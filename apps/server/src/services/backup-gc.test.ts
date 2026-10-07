import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { NoteImageUploadMeta } from "@tutor/contract";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { runBackfills } from "../db/backfill";
import { createDb, createDbHandle, type Db, type DbHandle } from "../db/client";
import { runMigrations } from "../db/migrate";
import {
  attempts as attemptsTable,
  noteVersions as noteVersionsTable,
  students as studentsTable,
  submissionEvidence as submissionEvidenceTable,
  teachers as teachersTable,
} from "../db/schema";
import { TEST_TEACHER_ID } from "../db/test-utils";
import { gzipJson, makeNotePng, noteDoc } from "../test/note-fixtures";
import { insertFrozenResponse, newDraftAttempt } from "./attempt-service";
import {
  BACKUP_DIR_NAME,
  buildBackupZip,
  createSnapshot,
  restoreFromBackup,
} from "./backup-service";
import {
  attachNoteImage,
  gcNoteVersions,
  getStudentNoteDocument,
  getStudentNoteEvidence,
  getStudentNoteImagePng,
  readNoteVersionDoc,
  saveNoteVersion,
} from "./note-service";
import { previewReviewPack } from "./review-pack-service";

/**
 * 备份恢复与 GC 交汇测试（T6R.14 核心，方案 §6.3「文件与数据库」）：
 * - 备份下载 → 干净实例恢复 → 读取手写原稿（证据行→版本文档→PNG 直出全链）；
 * - GC 与备份/导出并存：备份快照引用的未引用版本不被回收（备份引用保留
 *   清单——每次 GC 现扫 backups/ 快照，快照按 14 份轮转删除后引用自然释放）；
 *   恢复视角的引用完整性（快照内每个行路径的文件都在）在 GC 后仍成立；
 *   证据/头引用版本照旧保留，导出预览不缺图；
 * - 备份快照损坏不可读 → GC 保守放弃本轮删除（宁可漏删不可误删，
 *   与存量路径形态异常的既有口径一致）。
 * 真实文件库 + 真实快照（VACUUM INTO）+ 真实 zip 打包/恢复，不经 mock。
 */

const PASSWORD = "backup-pass-123";
const QUESTION_ID = "q-evidence-1";

/** 备份 zip 流收整为 Buffer（backup-service.test 同款） */
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

interface World {
  dataDir: string;
  handle: DbHandle;
  db: Db;
  studentId: string;
  attemptId: string;
  cleanup: () => void;
}

/** 真实文件库世界：迁移后 tutor.db + 教师（带密码）+ 学生 + 冻结一题 attempt */
async function makeWorld(tag: string): Promise<World> {
  const dataDir = mkdtempSync(join(tmpdir(), `tutor-bakgc-${tag}-`));
  const handle = createDbHandle(join(dataDir, "tutor.db"), (fresh) => {
    runMigrations(fresh);
    runBackfills(fresh);
  });
  const db = handle.db;
  db.insert(teachersTable)
    .values({
      id: TEST_TEACHER_ID,
      loginName: "teacher",
      isAdmin: true,
      disabledAt: null,
      passwordHash: await hashPassword(PASSWORD),
      apiToken: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    })
    .run();
  const studentId = randomUUID();
  db.insert(studentsTable)
    .values({
      id: studentId,
      teacherId: TEST_TEACHER_ID,
      loginName: `stu-${tag}`,
      displayName: "学生",
      passwordHash: null,
      linkToken: `link-${randomUUID()}`,
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    })
    .run();
  const attempt = newDraftAttempt({
    id: randomUUID(),
    studentId,
    sourceType: "assignment",
    assignmentId: null,
    courseId: null,
    unitId: null,
    attemptNo: 1,
    startedAt: "2026-10-01T00:00:00.000Z",
  });
  db.transaction((tx) => {
    tx.insert(attemptsTable).values(attempt).run();
    insertFrozenResponse(tx, {
      attemptId: attempt.id,
      questionId: QUESTION_ID,
      questionVersion: 1,
      questionSnapshotJson: JSON.stringify({ id: QUESTION_ID, type: "fill" }),
      unitId: null,
    });
  });
  return {
    dataDir,
    handle,
    db,
    studentId,
    attemptId: attempt.id,
    cleanup: () => {
      handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

interface Draft {
  db: Db;
  dataDir: string;
  studentId: string;
  attemptId: string;
}

/** 存两版正文（v1 返回回执；v2 成为 head） */
function saveTwoVersions(w: Draft): {
  v1: ReturnType<typeof saveNoteVersion>;
  v2: ReturnType<typeof saveNoteVersion>;
} {
  const v1 = saveNoteVersion(
    w.db,
    w.dataDir,
    w.studentId,
    w.attemptId,
    QUESTION_ID,
    gzipJson(noteDoc(1)),
    { baseRevision: 0, mutationId: randomUUID() },
  );
  const v2 = saveNoteVersion(
    w.db,
    w.dataDir,
    w.studentId,
    w.attemptId,
    QUESTION_ID,
    gzipJson(noteDoc(2)),
    { baseRevision: 1, mutationId: randomUUID() },
  );
  return { v1, v2 };
}

/** 全部版本 server_saved_at 改到过去（安全窗口流逝；直改 SQL 与 GC 测试同款） */
function ageAllVersions(db: Db): void {
  db.$client
    .prepare(
      "UPDATE note_versions SET server_saved_at = '2026-01-01T00:00:00.000Z'",
    )
    .run();
}

const worlds: World[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.cleanup();
});

// ---------- 备份 → 干净实例恢复 → 手写原稿全链 ----------

describe("备份恢复：证据链完整恢复（T6R.14 验收核心）", () => {
  it("下载备份 → 干净实例恢复 → 证据行→版本文档→PNG 直出全链可读", async () => {
    const source = await makeWorld("src");
    worlds.push(source);
    const receipt = saveNoteVersion(
      source.db,
      source.dataDir,
      source.studentId,
      source.attemptId,
      QUESTION_ID,
      gzipJson(noteDoc(1)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    const imageMeta: NoteImageUploadMeta = {
      spec: "analysis",
      pageIndex: 0,
      crop: { x: 0, y: 0, width: 1000, height: 800 },
      pixelWidth: 320,
      pixelHeight: 200,
    };
    const pngBytes = makeNotePng(320, 200);
    attachNoteImage(
      source.db,
      source.dataDir,
      { kind: "student", id: source.studentId },
      receipt.versionId,
      pngBytes,
      imageMeta,
    );
    source.db
      .insert(submissionEvidenceTable)
      .values({
        id: randomUUID(),
        attemptId: source.attemptId,
        questionId: QUESTION_ID,
        state: "frozen",
        versionId: receipt.versionId,
        recordedAt: "2026-10-02T00:00:00.000Z",
      })
      .run();

    // 备份下载（恒先拍当前时刻快照 + blobs + secret.key）
    const zip = await zipToBuffer(buildBackupZip(source.dataDir, source.db));

    // 干净实例（独立 DATA_DIR + 新库）：恢复前密码校验对当前库执行 →
    // 预置同 id 同密码教师行（makeWorld 已插）
    const clean = await makeWorld("clean");
    worlds.push(clean);
    const result = await restoreFromBackup(
      clean.dataDir,
      clean.handle,
      TEST_TEACHER_ID,
      PASSWORD,
      zip,
    );
    expect(result.sessionWarning).toBe(true);
    // 快照 db + blobs/notes 正文与派生图 = 3 个条目（source 世界无 shared/secret）
    expect(result.restoredFiles).toBe(3);

    // 全链读取（连接已重启到恢复库；id 全部用**来源库**的——恢复后库里
    // 是备份时点的数据）。先移除调试探针。
    // ① 证据行 → 冻结版本引用
    const evidence = getStudentNoteEvidence(
      clean.db,
      source.studentId,
      source.attemptId,
      QUESTION_ID,
    );
    expect(evidence.evidence?.state).toBe("frozen");
    expect(evidence.evidence?.versionId).toBe(receipt.versionId);
    // ② 版本文档（矢量原稿）可读且内容一致
    const doc = readNoteVersionDoc(clean.db, clean.dataDir, receipt.versionId);
    expect(doc.doc).toEqual(noteDoc(1));
    // getStudentNoteDocument 直出 gzip 字节也可读（路由同款通道）
    const gzipBytes = getStudentNoteDocument(
      clean.db,
      clean.dataDir,
      source.studentId,
      receipt.versionId,
    );
    expect(gzipBytes.byteLength).toBeGreaterThan(0);
    // ③ 派生图 PNG 直出，字节与原稿一致
    const imageId = evidence.images[0]?.imageId;
    expect(imageId).toBeDefined();
    const restoredPng = getStudentNoteImagePng(
      clean.db,
      clean.dataDir,
      source.studentId,
      receipt.versionId,
      imageId as string,
    );
    expect(Buffer.from(restoredPng).equals(Buffer.from(pngBytes))).toBe(true);
  });
});

// ---------- GC × 备份/导出并存 ----------

describe("GC 备份引用保留清单（方案 §6.3：备份引用也进保留集合）", () => {
  it("快照引用的未引用版本不被回收；旧快照 + 现存文件可读正文；快照轮转删除后引用释放", async () => {
    const w = await makeWorld("keep");
    worlds.push(w);
    const { v1 } = saveTwoVersions(w);
    // 快照（整库拷贝，含 v1+v2 行——v1 在当前库已不被引用）
    const snapName = createSnapshot(
      w.dataDir,
      w.db,
      new Date("2026-10-03T00:00:00.000Z"),
    );
    ageAllVersions(w.db);

    const result = gcNoteVersions(w.db, w.dataDir, {
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    // v1 只被备份引用：不删行、不删文件（keptByBackup 计数可见）
    expect(result.deletedVersionRows).toBe(0);
    expect(result.keptByBackup).toBe(1);
    expect(w.db.select().from(noteVersionsTable).all()).toHaveLength(2);

    // 旧快照 db + 现存磁盘文件 → 保留中的旧备份可读对应 blobs（恢复可行性）
    const snapDb = createDb(join(w.dataDir, BACKUP_DIR_NAME, snapName));
    try {
      const v1Read = readNoteVersionDoc(snapDb, w.dataDir, v1.versionId);
      expect(v1Read.doc).toEqual(noteDoc(1));
    } finally {
      snapDb.$client.close();
    }

    // 快照按轮转过期删除 → 下一轮 GC 引用释放，v1 行+文件被回收
    rmSync(join(w.dataDir, BACKUP_DIR_NAME, snapName), { force: true });
    const after = gcNoteVersions(w.db, w.dataDir, {
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    expect(after.deletedVersionRows).toBe(1);
    expect(after.keptByBackup).toBe(0);
    expect(w.db.select().from(noteVersionsTable).all()).toHaveLength(1);
  });

  it("证据原稿在 GC 后完整：引用零缺失、导出预览不缺图、PNG 可直出（导出/备份与 GC 并存）", async () => {
    const w = await makeWorld("evid");
    worlds.push(w);
    const receipt = saveNoteVersion(
      w.db,
      w.dataDir,
      w.studentId,
      w.attemptId,
      QUESTION_ID,
      gzipJson(noteDoc(1)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    const pngBytes = makeNotePng(320, 200);
    const image = attachNoteImage(
      w.db,
      w.dataDir,
      { kind: "student", id: w.studentId },
      receipt.versionId,
      pngBytes,
      {
        spec: "analysis",
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 800 },
        pixelWidth: 320,
        pixelHeight: 200,
      },
    );
    w.db
      .insert(submissionEvidenceTable)
      .values({
        id: randomUUID(),
        attemptId: w.attemptId,
        questionId: QUESTION_ID,
        state: "frozen",
        versionId: receipt.versionId,
        recordedAt: "2026-10-02T00:00:00.000Z",
      })
      .run();
    // 备份快照在 GC 前拍（模拟「备份下载进行中」的时点状态）
    const snapName = createSnapshot(
      w.dataDir,
      w.db,
      new Date("2026-10-03T00:00:00.000Z"),
    );
    ageAllVersions(w.db);
    const result = gcNoteVersions(w.db, w.dataDir, {
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    // 证据引用 + head 引用 + 备份引用三重保留，零删除
    expect(result.deletedVersionRows).toBe(0);
    expect(result.sweptOrphanFiles).toBe(0);

    // 引用完整性（方案 §6.3「恢复后做引用完整性检查，缺文件显式列出」——
    // 这里在 GC 后对快照做同款检查）：快照内每个行路径的文件都在磁盘
    const snapDb = createDb(join(w.dataDir, BACKUP_DIR_NAME, snapName));
    try {
      const bodyPaths = snapDb.$client
        .prepare("SELECT body_path AS p FROM note_versions")
        .all() as Array<{ p: string }>;
      const imagePaths = snapDb.$client
        .prepare("SELECT path AS p FROM note_images")
        .all() as Array<{ p: string }>;
      expect(bodyPaths.length).toBeGreaterThan(0);
      for (const row of [...bodyPaths, ...imagePaths]) {
        expect(existsSync(resolve(w.dataDir, row.p)), row.p).toBe(true);
      }
    } finally {
      snapDb.$client.close();
    }

    // 导出消费方（教师单题复习包预览）不缺材料：证据图在场、缺失清单为空
    const preview = previewReviewPack(
      w.db,
      w.dataDir,
      { kind: "teacher", id: TEST_TEACHER_ID },
      w.attemptId,
      QUESTION_ID,
    );
    expect(preview.missing).toEqual([]);
    expect(
      preview.files.some((file) => file.path.startsWith("evidence/")),
    ).toBe(true);
    // PNG 直出字节一致（查看通道全链）
    const live = getStudentNoteImagePng(
      w.db,
      w.dataDir,
      w.studentId,
      receipt.versionId,
      image.imageId,
    );
    expect(Buffer.from(live).equals(Buffer.from(pngBytes))).toBe(true);
  });

  it("备份快照损坏不可读：GC 保守放弃本轮删除（版本/文件一律不动）", async () => {
    const w = await makeWorld("corrupt");
    worlds.push(w);
    saveTwoVersions(w);
    ageAllVersions(w.db);
    // 损坏快照（随机字节，命名合快照模式）
    mkdirSync(join(w.dataDir, BACKUP_DIR_NAME), { recursive: true });
    writeFileSync(
      join(w.dataDir, BACKUP_DIR_NAME, "tutor-20261003-000000.db"),
      Buffer.alloc(512, 0x5a),
    );
    // 超窗孤儿正文文件（若孤儿清扫照跑会被删——保守口径下必须保留）
    const headRow = w.db.select().from(noteVersionsTable).all().at(-1) as {
      id: string;
      bodyPath: string;
    };
    const orphanRel = join(
      "blobs",
      "notes",
      headRow.bodyPath.split(/[\\/]/)[2] ?? "x",
      "v9-abcdef012345.json.gz",
    );
    mkdirSync(dirname(resolve(w.dataDir, orphanRel)), { recursive: true });
    writeFileSync(resolve(w.dataDir, orphanRel), "orphan");

    const result = gcNoteVersions(w.db, w.dataDir, {
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    expect(result.unreadableBackupDbs).toBe(1);
    // 保守：不可读备份可能引用任何文件——版本行与文件、孤儿一律不动
    expect(result.deletedVersionRows).toBe(0);
    expect(result.sweptOrphanFiles).toBe(0);
    expect(existsSync(resolve(w.dataDir, orphanRel))).toBe(true);
    expect(w.db.select().from(noteVersionsTable).all()).toHaveLength(2);
  });
});
