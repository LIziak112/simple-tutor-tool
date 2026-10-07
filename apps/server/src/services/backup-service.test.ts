import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { runBackfills } from "../db/backfill";
import { createDb, createDbHandle, type DbHandle } from "../db/client";
import { runMigrations } from "../db/migrate";
import { students, teachers } from "../db/schema";
import { TEST_TEACHER_ID } from "../db/test-utils";
import { HttpError } from "../lib/http-error";
import { readZipEntries } from "../lib/zip-read";
import {
  BACKUP_DIR_NAME,
  buildBackupZip,
  collectBackupReferencedPaths,
  createSnapshot,
  listSnapshots,
  restoreFromBackup,
  startBackupScheduler,
} from "./backup-service";

/**
 * 备份与恢复服务测试（T4.5，对照 Phase4 清单 §4 验收逐条）：
 * - 往返核心：快照 → zip → 改数据（库行 / shared 文件 / blobs 文件 /
 *   secret.key）→ 恢复 → 全部回到备份时点；恢复前自动快照存在；
 * - 错误密码拒绝且零副作用（连接仍可用）；
 * - 损坏 zip / 缺 db / 未知顶层内容 → 400 且原数据无损；
 * - 替换中途失败（zip 内 db 是坏文件，重启连接抛错）→ 回滚复原；
 * - 保留 14 份轮转（造 16 份只剩最新 14）；
 * - 恢复后数据连接重启可用（同一 db 引用读到恢复数据）；
 * - 下载 zip 结构（快照原名 + blobs + shared + secret.key，无 backups/）；
 * - 下载恒先拍当前快照（Opus 实测③-1：zip 内 db 含下载前刚写入的行，
 *   不复用最长落后 24h 的旧快照；下载本身新增一份快照）。
 */

const PASSWORD = "backup-pass-123";

/** 备份 zip 流收整为 Buffer（与下载链路同流，测试内消费） */
async function zipToBuffer(
  zip: Awaited<ReturnType<typeof buildBackupZip>>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  zip.stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    zip.stream.on("end", () => resolve());
    zip.stream.on("error", (err: Error) => reject(err));
  });
  await done;
  return Buffer.concat(chunks);
}

interface Fixture {
  dataDir: string;
  handle: DbHandle;
  cleanup: () => void;
}

/** 真实文件库夹具：DATA_DIR（secret.key/shared/blobs）+ 迁移后的 tutor.db + 带密码教师 */
async function makeFixture(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "tutor-backup-data-"));
  writeFileSync(join(dataDir, "secret.key"), "ab".repeat(32), "utf8");
  mkdirSync(join(dataDir, "shared"), { recursive: true });
  mkdirSync(join(dataDir, "blobs", "ink", "att-1"), { recursive: true });
  writeFileSync(join(dataDir, "shared", "共享练习.md"), "共享内容 v1", "utf8");
  writeFileSync(
    join(dataDir, "blobs", "ink", "att-1", "手写.png"),
    "png-bytes-v1",
    "utf8",
  );

  const handle = createDbHandle(join(dataDir, "tutor.db"), (fresh) => {
    runMigrations(fresh);
    runBackfills(fresh);
  });
  handle.db
    .insert(teachers)
    .values({
      id: TEST_TEACHER_ID,
      loginName: "teacher",
      isAdmin: true,
      disabledAt: null,
      passwordHash: await hashPassword(PASSWORD),
      apiToken: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  handle.db
    .insert(students)
    .values({
      id: "stu-backup-1",
      teacherId: TEST_TEACHER_ID,
      loginName: "stu1",
      displayName: "学生一",
      passwordHash: null,
      linkToken: "link-stu-1",
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: "2026-01-02T00:00:00.000Z",
    })
    .run();

  return {
    dataDir,
    handle,
    cleanup: () => {
      handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 断言某学生行存在与否 */
function hasStudent(handle: DbHandle, id: string): boolean {
  return (
    handle.db.select().from(students).where(eq(students.id, id)).get() !==
    undefined
  );
}

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.cleanup();
  }
});

describe("备份 → 改数据 → 恢复（验收核心往返）", () => {
  it("db / shared / blobs / secret.key 全部回到备份时点；恢复前自动快照存在；连接重启可用", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const { dataDir, handle } = fixture;

    // 备份（zip 内含全部内容；下载恒先拍一份「当前时刻」快照——注入固定
    // 时点便于断言 zip 内 db 不是下面这行先拍的旧快照）
    createSnapshot(dataDir, handle.db, new Date("2026-10-01T03:00:00.000Z"));
    const zip = await zipToBuffer(
      buildBackupZip(dataDir, handle.db, new Date("2026-10-01T04:00:00.000Z")),
    );

    // 改数据：库增行、shared 加文件与改文件、blobs 加文件、secret.key 换内容
    handle.db
      .insert(students)
      .values({
        id: "stu-backup-2",
        teacherId: TEST_TEACHER_ID,
        loginName: "stu2",
        displayName: "学生二",
        passwordHash: null,
        linkToken: "link-stu-2",
        linkEnabled: true,
        passwordEnabled: false,
        note: null,
        archivedAt: null,
        createdAt: "2026-02-01T00:00:00.000Z",
      })
      .run();
    writeFileSync(join(dataDir, "shared", "新增共享.md"), "不该存在", "utf8");
    writeFileSync(
      join(dataDir, "shared", "共享练习.md"),
      "共享内容 v2",
      "utf8",
    );
    writeFileSync(
      join(dataDir, "blobs", "ink", "att-1", "新增.png"),
      "new",
      "utf8",
    );
    writeFileSync(join(dataDir, "secret.key"), "cd".repeat(32), "utf8");
    expect(hasStudent(handle, "stu-backup-2")).toBe(true);

    // 恢复
    const result = await restoreFromBackup(
      dataDir,
      handle,
      TEST_TEACHER_ID,
      PASSWORD,
      zip,
    );

    // 摘要
    expect(result.sessionWarning).toBe(true);
    expect(result.restoredFiles).toBeGreaterThanOrEqual(4);
    expect(result.snapshotTime).toBe("2026-10-01T04:00:00.000Z");
    expect(result.dbFilename).toMatch(/^tutor-\d{8}-\d{6}\.db$/);

    // db 回到备份时点：新增学生消失、原有学生仍在（同一 db 引用 = 连接已重启）
    expect(hasStudent(handle, "stu-backup-2")).toBe(false);
    expect(hasStudent(handle, "stu-backup-1")).toBe(true);
    // 教师行（含密码）完整恢复——恢复后可再验密码
    const teacherRow = handle.db
      .select()
      .from(teachers)
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .get();
    expect(teacherRow?.passwordHash).toBeTruthy();
    // 恢复后连接可写（重启后服务继续可用）
    handle.db
      .update(students)
      .set({ displayName: "学生一改" })
      .where(eq(students.id, "stu-backup-1"))
      .run();

    // shared 回到备份时点：新增文件消失、被改文件回 v1
    expect(existsSync(join(dataDir, "shared", "新增共享.md"))).toBe(false);
    expect(readFileSync(join(dataDir, "shared", "共享练习.md"), "utf8")).toBe(
      "共享内容 v1",
    );
    // blobs 回到备份时点
    expect(existsSync(join(dataDir, "blobs", "ink", "att-1", "新增.png"))).toBe(
      false,
    );
    expect(
      readFileSync(join(dataDir, "blobs", "ink", "att-1", "手写.png"), "utf8"),
    ).toBe("png-bytes-v1");
    // secret.key 回到备份内容
    expect(readFileSync(join(dataDir, "secret.key"), "utf8")).toBe(
      "ab".repeat(32),
    );
    // 运行库文件名归位 tutor.db
    expect(existsSync(join(dataDir, "tutor.db"))).toBe(true);

    // 恢复前自动快照存在（D21 回滚保险）：恢复时刻的旧数据快照在 backups/
    const names = readdirSync(join(dataDir, BACKUP_DIR_NAME));
    const snapshots = listSnapshots(dataDir);
    expect(snapshots.length).toBe(names.length);
    expect(snapshots.length).toBeGreaterThanOrEqual(3); // 旧手拍 + 下载补拍 + 恢复前保险
  });

  it("下载 zip 结构：快照原名 db + blobs/ + shared/ + secret.key，无 backups/", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const { dataDir, handle } = fixture;

    const zipBuffer = await zipToBuffer(buildBackupZip(dataDir, handle.db));
    const entries = readZipEntries(zipBuffer);
    const names = entries.map((entry) => entry.name);

    expect(names.some((name) => /^tutor-\d{8}-\d{6}\.db$/.test(name))).toBe(
      true,
    );
    expect(names).toContain("secret.key");
    expect(names).toContain("shared/共享练习.md");
    expect(names).toContain("blobs/ink/att-1/手写.png");
    expect(names.some((name) => name.startsWith("backups/"))).toBe(false);
    expect(names.some((name) => name.includes("tutor.db-wal"))).toBe(false);
  });

  it("下载恒先拍当前快照：下载新增一份且 zip 内 db 含下载前刚写入的行（Opus 实测③-1）", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const { dataDir, handle } = fixture;

    // 旧快照（模拟启动/24h 调度拍的）：不含下面即将写入的新学生——
    // 修复前 zip 会复用这份旧快照，恢复它将丢掉新写入的行
    createSnapshot(dataDir, handle.db, new Date("2026-09-01T00:00:00.000Z"));
    const beforeDownload = listSnapshots(dataDir).length;

    handle.db
      .insert(students)
      .values({
        id: "stu-before-download",
        teacherId: TEST_TEACHER_ID,
        loginName: "stu-fresh",
        displayName: "下载前刚写入",
        passwordHash: null,
        linkToken: "link-stu-fresh",
        linkEnabled: true,
        passwordEnabled: false,
        note: null,
        archivedAt: null,
        createdAt: "2026-03-01T00:00:00.000Z",
      })
      .run();

    const zipBuffer = await zipToBuffer(buildBackupZip(dataDir, handle.db));

    // 下载本身新增一份快照（恒拍，不再只在零快照时补拍）
    expect(listSnapshots(dataDir).length).toBe(beforeDownload + 1);

    // zip 内 db 是下载时刻的：解出 db 条目、落临时文件开连接直查，
    // 断言含下载前刚写入的行（= 当前时刻全量，而非旧快照时点）
    const entries = readZipEntries(zipBuffer);
    const dbEntry = entries.find((entry) =>
      /^tutor-\d{8}-\d{6}(?:-\d+)?\.db$/.test(entry.name),
    );
    expect(dbEntry).toBeDefined();
    if (!dbEntry) return;
    const tmpDbPath = join(dataDir, "zip-db-检查临时.db");
    writeFileSync(tmpDbPath, dbEntry.data);
    const check = createDb(tmpDbPath);
    try {
      expect(
        check
          .select()
          .from(students)
          .where(eq(students.id, "stu-before-download"))
          .get(),
      ).toBeDefined();
      expect(
        check
          .select()
          .from(students)
          .where(eq(students.id, "stu-backup-1"))
          .get(),
      ).toBeDefined();
    } finally {
      check.$client.close();
    }
  });
});

describe("恢复的拒绝路径（原数据无损）", () => {
  it("错误密码 → 403；数据未动、连接仍可用", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const { dataDir, handle } = fixture;
    createSnapshot(dataDir, handle.db);
    const zip = await zipToBuffer(buildBackupZip(dataDir, handle.db));

    const err = await restoreFromBackup(
      dataDir,
      handle,
      TEST_TEACHER_ID,
      "wrong-password",
      zip,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).code).toBe("BACKUP_INVALID_PASSWORD");

    // 连接仍可用（未关闭）
    expect(hasStudent(handle, "stu-backup-1")).toBe(true);
  });

  it("损坏 zip（随机字节）→ 400 且原数据无损", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const { dataDir, handle } = fixture;
    writeFileSync(join(dataDir, "shared", "共享练习.md"), "恢复前内容", "utf8");

    const err = await restoreFromBackup(
      dataDir,
      handle,
      TEST_TEACHER_ID,
      PASSWORD,
      Buffer.alloc(1024, 0x5a),
    ).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).code).toBe("BACKUP_ZIP_INVALID");

    expect(readFileSync(join(dataDir, "shared", "共享练习.md"), "utf8")).toBe(
      "恢复前内容",
    );
    expect(hasStudent(handle, "stu-backup-1")).toBe(true);
    expect(existsSync(join(dataDir, "tutor.db"))).toBe(true);
  });

  it("zip 缺 db 文件 / 含未知顶层内容 → 400 中文说明", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const { dataDir, handle } = fixture;

    // 缺 db：直接造一个只有 shared 文件的 zip（借 buildBackupZip 产物剔除 db 再打包太绕，
    // 用 zip-read 测试同款 archiver 内联打包）
    const { ZipArchive } = await import("archiver");
    const pack = async (files: Array<{ name: string; data: Buffer }>) => {
      const archive = new ZipArchive({ zlib: { level: 6 } });
      const chunks: Buffer[] = [];
      archive.on("data", (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise<void>((resolve, reject) => {
        archive.on("end", () => resolve());
        archive.on("error", (e: Error) => reject(e));
      });
      for (const file of files) archive.append(file.data, { name: file.name });
      await archive.finalize();
      await done;
      return Buffer.concat(chunks);
    };

    const noDb = await pack([{ name: "shared/a.md", data: Buffer.from("x") }]);
    const err1 = await restoreFromBackup(
      dataDir,
      handle,
      TEST_TEACHER_ID,
      PASSWORD,
      noDb,
    ).catch((e: unknown) => e);
    expect((err1 as HttpError).code).toBe("BACKUP_ZIP_INVALID");
    expect((err1 as HttpError).message).toContain("数据库文件");

    // 未知顶层：readZipEntries 会因名字安全通过、白名单拒绝 backups/ 覆写
    const validZip = await zipToBuffer(buildBackupZip(dataDir, handle.db));
    const entries = readZipEntries(validZip); // 借真实备份结构改造
    const rebuilt = await pack([
      ...entries.map((entry) => ({ name: entry.name, data: entry.data })),
      { name: "readme.txt", data: Buffer.from(" rogue ") },
    ]);
    const err2 = await restoreFromBackup(
      dataDir,
      handle,
      TEST_TEACHER_ID,
      PASSWORD,
      rebuilt,
    ).catch((e: unknown) => e);
    expect((err2 as HttpError).code).toBe("BACKUP_ZIP_INVALID");
    expect((err2 as HttpError).message).toContain("readme.txt");

    expect(hasStudent(handle, "stu-backup-1")).toBe(true);
  });

  it("zip 内 db 是坏文件（重启连接失败）→ 500 已回滚，原数据无损", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const { dataDir, handle } = fixture;

    // 真实备份 + 篡改 db 条目为非 SQLite 字节
    createSnapshot(dataDir, handle.db);
    const zipBuffer = await zipToBuffer(buildBackupZip(dataDir, handle.db));
    const entries = readZipEntries(zipBuffer);
    const { ZipArchive } = await import("archiver");
    const archive = new ZipArchive({ zlib: { level: 0 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      archive.on("end", () => resolve());
      archive.on("error", (e: Error) => reject(e));
    });
    for (const entry of entries) {
      // 同秒补拍的快照名可能带 -2/-3 序号，正则需兼容
      const isDb = /^tutor-\d{8}-\d{6}(?:-\d+)?\.db$/.test(entry.name);
      archive.append(isDb ? Buffer.from("这不是一个数据库文件") : entry.data, {
        name: entry.name,
      });
    }
    await archive.finalize();
    await done;
    const poisoned = Buffer.concat(chunks);

    const err = await restoreFromBackup(
      dataDir,
      handle,
      TEST_TEACHER_ID,
      PASSWORD,
      poisoned,
    ).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(500);
    expect((err as HttpError).code).toBe("BACKUP_RESTORE_FAILED");

    // 回滚复原：库行、secret.key、shared 都在原位且连接可用
    expect(hasStudent(handle, "stu-backup-1")).toBe(true);
    expect(readFileSync(join(dataDir, "secret.key"), "utf8")).toBe(
      "ab".repeat(32),
    );
    expect(readFileSync(join(dataDir, "shared", "共享练习.md"), "utf8")).toBe(
      "共享内容 v1",
    );
  });
});

describe("collectBackupReferencedPaths（T6R.14 GC 备份引用保留清单扫描件）", () => {
  it("快照引用的 note_versions/note_images 原始路径全收集；坏快照计 unreadable 且不炸", () => {
    const fixture = makeFixtureSync();
    fixtures.push(fixture);
    const { dataDir, handle } = fixture;
    // 无快照：零引用零计数
    expect(collectBackupReferencedPaths(dataDir)).toEqual({
      paths: [],
      unreadable: 0,
    });

    // 快照（空 notes 表族——表存在无行）后放一个损坏快照
    createSnapshot(dataDir, handle.db, new Date("2026-10-01T00:00:00.000Z"));
    writeFileSync(
      join(dataDir, BACKUP_DIR_NAME, "tutor-20261002-000000.db"),
      Buffer.alloc(256, 0x5a),
    );
    const result = collectBackupReferencedPaths(dataDir);
    expect(result.unreadable).toBe(1);
    expect(result.paths).toEqual([]); // 空表族 → 零引用（不视为损坏）

    // 直造一份含 note_versions/note_images 行的快照文件（扫描器只消费这两
    // 表——构造合法测试缝；真实 VACUUM INTO 快照链路由 backup-gc.test 覆盖）
    const crafted = join(dataDir, BACKUP_DIR_NAME, "tutor-20261003-000000.db");
    const craftedDb = createDb(crafted);
    craftedDb.$client
      .prepare(
        "CREATE TABLE note_versions (id TEXT PRIMARY KEY, body_path TEXT NOT NULL)",
      )
      .run();
    craftedDb.$client
      .prepare(
        "CREATE TABLE note_images (id TEXT PRIMARY KEY, path TEXT NOT NULL)",
      )
      .run();
    craftedDb.$client
      .prepare(
        "INSERT INTO note_versions VALUES ('v-1','blobs/notes/n-1/v1-abc01234567.json.gz')",
      )
      .run();
    craftedDb.$client
      .prepare(
        "INSERT INTO note_images VALUES ('i-1','blobs/notes/n-1/img-i-1.png')",
      )
      .run();
    craftedDb.$client.close();

    const withRows = collectBackupReferencedPaths(dataDir);
    expect(withRows.unreadable).toBe(1); // 坏快照仍在
    expect(withRows.paths).toEqual([
      "blobs/notes/n-1/v1-abc01234567.json.gz",
      "blobs/notes/n-1/img-i-1.png",
    ]);
  });
});

describe("快照轮转与调度", () => {
  it("保留 14 份：造 16 份只剩最新 14（按时间删最旧）", () => {
    const fixture = makeFixtureSync();
    fixtures.push(fixture);
    const { dataDir, handle } = fixture;

    for (let i = 0; i < 16; i += 1) {
      createSnapshot(
        dataDir,
        handle.db,
        new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
      );
    }
    const snapshots = listSnapshots(dataDir);
    expect(snapshots.length).toBe(14);
    // 倒序：最新在前（北京时间 08:00:15），最早两份（08:00:00/01）被删
    expect(snapshots[0]?.filename).toBe("tutor-20261001-080015.db");
    expect(snapshots.some((s) => s.filename.endsWith("-080000.db"))).toBe(
      false,
    );
    expect(snapshots.some((s) => s.filename.endsWith("-080001.db"))).toBe(
      false,
    );
    // 列表形状：时间倒序 + 大小非负
    for (let i = 1; i < snapshots.length; i += 1) {
      const previous = snapshots[i - 1];
      const current = snapshots[i];
      if (previous === undefined || current === undefined) {
        throw new Error("快照列表项缺失");
      }
      expect(previous.createdAt >= current.createdAt).toBe(true);
    }
    expect(snapshots.every((s) => s.sizeBytes > 0)).toBe(true);
  });

  it("同秒两次快照自动加序号，不互相覆盖", () => {
    const fixture = makeFixtureSync();
    fixtures.push(fixture);
    const { dataDir, handle } = fixture;
    const now = new Date("2026-10-01T04:00:00.000Z");
    const first = createSnapshot(dataDir, handle.db, now);
    const second = createSnapshot(dataDir, handle.db, now);
    expect(first).not.toBe(second);
    expect(second).toMatch(/-2\.db$/);
    expect(listSnapshots(dataDir).length).toBe(2);
  });

  it("调度器：启动立即快照 + 间隔触发 + stop 停止", () => {
    const fixture = makeFixtureSync();
    fixtures.push(fixture);
    const { dataDir, handle } = fixture;
    const logger = pino({ enabled: false });

    vi.useFakeTimers();
    try {
      const stop = startBackupScheduler(dataDir, handle.db, logger, 1000);
      expect(listSnapshots(dataDir).length).toBe(1); // 启动立即一份
      vi.advanceTimersByTime(2500);
      expect(listSnapshots(dataDir).length).toBe(3); // +2 个间隔
      stop();
      vi.advanceTimersByTime(5000);
      expect(listSnapshots(dataDir).length).toBe(3); // 停止后不再增长
    } finally {
      vi.useRealTimers();
    }
  });
});

/** 同步版夹具（轮转/调度用例不需要密码哈希的异步） */
function makeFixtureSync(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "tutor-backup-data-"));
  const handle = createDbHandle(join(dataDir, "tutor.db"), (fresh) => {
    runMigrations(fresh);
    runBackfills(fresh);
  });
  handle.db
    .insert(teachers)
    .values({
      id: TEST_TEACHER_ID,
      loginName: "teacher",
      isAdmin: true,
      disabledAt: null,
      passwordHash: null,
      apiToken: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  return {
    dataDir,
    handle,
    cleanup: () => {
      handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
