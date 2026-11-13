import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupRestoreOkSchema,
  backupSnapshotListOkSchema,
  teacherInfoOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { hashPassword } from "../auth/password.ts";
import { createTeacherSession } from "../auth/session.ts";
import { runBackfills } from "../db/backfill.ts";
import { createDbHandle, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { teachers } from "../db/schema.ts";
import { readZipEntries } from "../lib/zip-read.ts";

/**
 * 备份与恢复路由测试（T4.5）：鉴权（未登录 401）、快照列表契约、zip 下载
 * （流式直出 + 响应头 + 可解包）、恢复（multipart 形状校验 / 错误密码 403 /
 * 成功恢复响应含会话提示字段且数据回退）。
 * 夹具用真实文件库 + 可重启句柄（恢复替换 DATA_DIR 必须落盘才能验证）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "backup-pass-123";

interface BackupApp {
  app: ReturnType<typeof createApp>;
  cookie: string;
  dataDir: string;
  handle: DbHandle;
  teacherId: string;
}

const apps: BackupApp[] = [];

async function makeBackupApp(authorize = true): Promise<BackupApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "tutor-backup-route-"));
  writeFileSync(join(dataDir, "secret.key"), "ef".repeat(32), "utf8");
  mkdirSync(join(dataDir, "shared"), { recursive: true });
  writeFileSync(join(dataDir, "shared", "共享.md"), "route-v1", "utf8");

  const handle = createDbHandle(join(dataDir, "tutor.db"), (fresh) => {
    runMigrations(fresh);
    runBackfills(fresh);
  });
  const options = {
    isProduction: false,
    logger: silentLogger,
    db: handle.db,
    dbHandle: handle,
    publicUrl: "http://localhost:8787",
    dataDir,
  };
  const setupApp = createApp(options);

  // 首启 setup 建教师（密码经代理连接写入，登录链路与生产一致）
  const setup = await setupApp.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  expect(setup.status).toBe(200);
  const cookieLine = setup.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!cookieLine) throw new Error("setup 未下发会话 cookie");
  const { data } = teacherInfoOkSchema.parse(await setup.json());

  const fixture: BackupApp = {
    app: authorize
      ? createApp({ ...options, backupOperatorId: data.id })
      : setupApp,
    cookie: `tutor_session=${cookieLine.slice("tutor_session=".length).split(";")[0] ?? ""}`,
    dataDir,
    handle,
    teacherId: data.id,
  };
  apps.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of apps.splice(0)) {
    fixture.handle.close();
    rmSync(fixture.dataDir, { recursive: true, force: true });
  }
});

/** 登录后的 GET/POST 请求 */
async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  cookie: string | undefined,
  init?: RequestInit,
): Promise<Response> {
  return app.request(path, {
    method,
    ...init,
    headers: { ...(init?.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
}

async function signInOtherTeacher(
  handle: DbHandle,
  isAdmin: boolean,
): Promise<string> {
  const id = "other-teacher";
  handle.db
    .insert(teachers)
    .values({
      id,
      loginName: "other",
      isAdmin,
      passwordHash: await hashPassword(TEACHER_PASSWORD),
      createdAt: new Date().toISOString(),
    })
    .run();
  return `tutor_session=${createTeacherSession(handle.db, id).token}`;
}

function signal() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

describe("整站备份默认关闭", () => {
  it("首位管理员未获主机配置授权时不能查看整站快照", async () => {
    const { app, cookie } = await makeBackupApp(false);
    const res = await request(
      app,
      "GET",
      "/api/teacher/backup/snapshots",
      cookie,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "BACKUP_OPERATOR_REQUIRED",
    });
    const me = await request(app, "GET", "/api/teacher/me", cookie);
    await expect(me.json()).resolves.toMatchObject({
      data: { canManageInstanceBackup: false },
    });
  });
});

describe("整站备份操作员权限", () => {
  it("普通教师和其他管理员均无整站备份权限", async () => {
    const { app, dataDir, handle } = await makeBackupApp();
    const cookie = await signInOtherTeacher(handle, false);
    for (const isAdmin of [false, true]) {
      handle.db
        .update(teachers)
        .set({ isAdmin })
        .where(eq(teachers.id, "other-teacher"))
        .run();
      const me = await request(app, "GET", "/api/teacher/me", cookie);
      await expect(me.json()).resolves.toMatchObject({
        data: { canManageInstanceBackup: false },
      });
      for (const [method, action] of [
        ["GET", "snapshots"],
        ["GET", "download"],
        ["POST", "restore"],
      ] as const) {
        const response = await request(
          app,
          method,
          `/api/teacher/backup/${action}`,
          cookie,
        );
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          error: "BACKUP_OPERATOR_REQUIRED",
        });
      }
    }
    expect(existsSync(join(dataDir, "backups"))).toBe(false);
  });

  it("撤销管理员资格后，同一会话的备份权限随即失效", async () => {
    const { app, cookie, handle, teacherId } = await makeBackupApp();
    const me = await request(app, "GET", "/api/teacher/me", cookie);
    await expect(me.json()).resolves.toMatchObject({
      data: { canManageInstanceBackup: true },
    });
    handle.db
      .update(teachers)
      .set({ isAdmin: false })
      .where(eq(teachers.id, teacherId))
      .run();
    const response = await request(
      app,
      "GET",
      "/api/teacher/backup/snapshots",
      cookie,
    );
    expect(response.status).toBe(403);
  });

  it("恢复上传期间撤销资格时，原数据和快照不发生变更", async () => {
    const { app, cookie, dataDir, handle, teacherId } = await makeBackupApp();
    const url = "http://localhost:8787/api/teacher/backup/restore";
    const form = new FormData();
    form.append("zip", new File(["测试文件"], "backup.zip"));
    form.append("password", TEACHER_PASSWORD);
    const prepared = new Request(url, { method: "POST", body: form });
    const bytes = new Uint8Array(await prepared.arrayBuffer());
    const started = signal();
    const resume = signal();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          started.resolve();
          await resume.promise;
          controller.enqueue(bytes);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const headers = new Headers(prepared.headers);
    headers.set("cookie", cookie);
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers,
      body,
      duplex: "half",
    };
    const result = app.request(new Request(url, init));
    await started.promise;
    try {
      handle.db
        .update(teachers)
        .set({ isAdmin: false })
        .where(eq(teachers.id, teacherId))
        .run();
    } finally {
      resume.resolve();
    }
    const response = await result;
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "BACKUP_OPERATOR_REQUIRED",
    });
    expect(existsSync(join(dataDir, "backups"))).toBe(false);
    expect(existsSync(join(dataDir, "shared", "共享.md"))).toBe(true);
  });

  it("其他管理员无法重置主机指定操作员的密码", async () => {
    const { app, handle, teacherId } = await makeBackupApp();
    const cookie = await signInOtherTeacher(handle, true);
    const response = await request(
      app,
      "POST",
      `/api/admin/teachers/${teacherId}/reset-password`,
      cookie,
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "replacement-password" }),
      },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "BACKUP_OPERATOR_PASSWORD_PROTECTED",
    });
  });
});

describe("GET /api/teacher/backup/snapshots", () => {
  it("未登录 401；登录后返回契约形状的快照列表", async () => {
    const { app, cookie } = await makeBackupApp();

    const denied = await request(
      app,
      "GET",
      "/api/teacher/backup/snapshots",
      undefined,
    );
    expect(denied.status).toBe(401);
    const deniedBody = (await denied.json()) as { error: string };
    expect(deniedBody.error).toBe("UNAUTHORIZED");

    // 下载恒先补拍当前快照——先下载一次让列表非空
    const download = await request(
      app,
      "GET",
      "/api/teacher/backup/download",
      cookie,
    );
    expect(download.status).toBe(200);

    const res = await request(
      app,
      "GET",
      "/api/teacher/backup/snapshots",
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const parsed = backupSnapshotListOkSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.data.snapshots.length).toBeGreaterThanOrEqual(1);
    expect(parsed.data.data.snapshots[0]?.filename).toMatch(
      /^tutor-\d{8}-\d{6}\.db$/,
    );
  });
});

describe("GET /api/teacher/backup/download", () => {
  it("未登录 401；登录后 zip 直出（响应头 + 可解包结构）", async () => {
    const { app, cookie, dataDir } = await makeBackupApp();

    const denied = await request(
      app,
      "GET",
      "/api/teacher/backup/download",
      undefined,
    );
    expect(denied.status).toBe(401);

    const res = await request(
      app,
      "GET",
      "/api/teacher/backup/download",
      cookie,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="tutor-backup-\d{8}-\d{6}\.zip"/,
    );

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    const names = readZipEntries(bytes).map((entry) => entry.name);
    expect(names.some((name) => /^tutor-\d{8}-\d{6}\.db$/.test(name))).toBe(
      true,
    );
    expect(names).toContain("secret.key");
    expect(names).toContain("shared/共享.md");
    expect(names.some((name) => name.startsWith("backups/"))).toBe(false);
    // 下载恒先补拍当前快照（dataDir 里出现 backups/）
    expect(existsSync(join(dataDir, "backups"))).toBe(true);
  });
});

describe("POST /api/teacher/backup/restore", () => {
  it("未登录 401", async () => {
    const { app } = await makeBackupApp();
    const res = await app.request("/api/teacher/backup/restore", {
      method: "POST",
      body: new FormData(),
    });
    expect(res.status).toBe(401);
  });

  it("非 multipart（缺 zip/password 字段）→ 400 VALIDATION_ERROR", async () => {
    const { app, cookie } = await makeBackupApp();
    const res = await request(
      app,
      "POST",
      "/api/teacher/backup/restore",
      cookie,
      {
        body: new FormData(), // 空 multipart：两字段都缺
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("multipart");
  });

  it("错误密码 → 403 BACKUP_INVALID_PASSWORD，原数据无损", async () => {
    const { app, cookie, dataDir } = await makeBackupApp();
    const download = await request(
      app,
      "GET",
      "/api/teacher/backup/download",
      cookie,
    );
    const zipBytes = Buffer.from(await download.arrayBuffer());
    writeFileSync(join(dataDir, "shared", "共享.md"), "改过", "utf8");

    const form = new FormData();
    form.append("zip", new File([zipBytes], "backup.zip"));
    form.append("password", "wrong-password");
    const res = await request(
      app,
      "POST",
      "/api/teacher/backup/restore",
      cookie,
      {
        body: form,
      },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("BACKUP_INVALID_PASSWORD");
    // 密码错在动数据之前：改动保留
    expect(existsSync(join(dataDir, "shared", "共享.md"))).toBe(true);
  });

  it("成功恢复：响应含会话提示字段且数据回到备份时点（服务进程内的连接已重启）", async () => {
    const fixture = await makeBackupApp();
    const { app, cookie, dataDir, handle } = fixture;

    const download = await request(
      app,
      "GET",
      "/api/teacher/backup/download",
      cookie,
    );
    const zipBytes = Buffer.from(await download.arrayBuffer());

    // 备份后改数据：shared 文件删除（回到时点后应复原）
    rmSync(join(dataDir, "shared", "共享.md"));

    const form = new FormData();
    form.append("zip", new File([zipBytes], "backup.zip"));
    form.append("password", TEACHER_PASSWORD);
    const res = await request(
      app,
      "POST",
      "/api/teacher/backup/restore",
      cookie,
      {
        body: form,
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const parsed = backupRestoreOkSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.data.sessionWarning).toBe(true);
      expect(parsed.data.data.restoredFiles).toBeGreaterThanOrEqual(2);
    }

    // 文件回到备份时点；恢复后的连接仍可服务（同一句柄读库成功）
    expect(existsSync(join(dataDir, "shared", "共享.md"))).toBe(true);
    expect(
      handle.db
        .select()
        .from((await import("../db/schema.ts")).teachers)
        .all().length,
    ).toBe(1);
    // 恢复后再调接口正常（路由仍挂在同一 app 上，代理 db 已指向恢复库）
    const again = await request(
      app,
      "GET",
      "/api/teacher/backup/snapshots",
      cookie,
    );
    expect(again.status).toBe(200);
  });
});
