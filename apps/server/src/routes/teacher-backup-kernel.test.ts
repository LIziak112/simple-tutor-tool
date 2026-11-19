import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempDisposableSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attemptResultOkSchema,
  attemptStartOkSchema,
  BACKUP_KERNEL_ARTIFACT,
  BACKUP_KERNEL_MANIFEST,
  backupKernelManifestSchema,
  teacherInfoOkSchema,
} from "@tutor/contract";
import { ZipArchive } from "archiver";
import Database from "better-sqlite3";
import { openLearningRuntime } from "learning-kernel";
import pino from "pino";
import { expect, it } from "vitest";
import { createApp } from "../app.ts";
import { runBackfills } from "../db/backfill.ts";
import { createDbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { readZipEntriesMap } from "../lib/zip-read.ts";
import { BACKUP_RESTORE_MARKER } from "../services/backup-process-guard.ts";
import { zipToBackupBuffer } from "../test/backup-fixtures.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { putNoteReceipt, type TestApp } from "../test/note-fixtures.ts";
import { extractSessionToken } from "../test/note-world.ts";
import {
  fetchSubmitRevisions,
  submitAttemptRequest,
} from "../test/submit-revisions.ts";

const password = "teacher-pass-8";
const dbName = "tutor.db";
const kernelName = "learning-kernel.sqlite";

function openInstance() {
  const data = mkdtempDisposableSync(join(tmpdir(), "ownclass-double-backup-"));
  const handle = createDbHandle(join(data.path, dbName), (db) => {
    runMigrations(db);
    runBackfills(db);
  });
  function app(backupOperatorId?: string) {
    return createApp({
      db: handle.db,
      dbHandle: handle,
      dataDir: data.path,
      backupOperatorId,
      kernelAssignmentCreationEnabled: true,
      isProduction: false,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
    });
  }
  return {
    app,
    handle,
    dataDir: data.path,
    [Symbol.dispose]() {
      handle.close();
      data.remove();
    },
  };
}

async function openedAttempt(
  app: TestApp,
  assignmentId: string,
  cookie: string,
) {
  const response = await postAssignment(app, assignmentId, cookie);
  expect(response.status, await response.clone().text()).toBe(200);
  return attemptStartOkSchema.parse(await response.json()).data.id;
}

async function readAttempt(app: TestApp, attemptId: string, cookie: string) {
  return app.request(`/api/student/attempts/${attemptId}`, {
    headers: { cookie },
  });
}

async function answer(
  app: TestApp,
  id: string,
  cookie: string,
  index: number,
  choice: number,
) {
  const question = (await fetchSubmitRevisions(app, cookie, id))[index];
  if (!question) throw new Error("未读到冻结题");
  const response = await app.request(
    `/api/student/attempts/${id}/answers/${question.questionId}`,
    {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: { kind: "choice", index: choice } }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return question.questionId;
}

async function readResult(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return attemptResultOkSchema.parse(await response.json()).data;
}

function restore(app: TestApp, cookie: string, bytes: Uint8Array<ArrayBuffer>) {
  const body = new FormData();
  body.set("zip", new File([bytes], "tutor-backup.zip"));
  body.set("password", password);
  return app.request("/api/teacher/backup/restore", {
    method: "POST",
    headers: { cookie },
    body,
  });
}

async function startPeer(dataDir: string, operator: string, interruption = "") {
  const child = fork(
    fileURLToPath(
      new URL("../test/fixtures/backup-restore-peer.mjs", import.meta.url),
    ),
    [dataDir, operator, interruption],
    {
      execArgv: [
        "--import",
        new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
      ],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise<{
    app: TestApp;
    exited: typeof exited;
    [Symbol.asyncDispose](): Promise<void>;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`隔离服务未启动：${stderr}`));
    }, 20_000);
    child.once("error", reject);
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`隔离服务退出 ${code}：${stderr}`));
    });
    child.once("message", (origin) => {
      clearTimeout(timer);
      if (
        typeof origin !== "string" ||
        !origin.startsWith("http://127.0.0.1:")
      ) {
        child.kill("SIGKILL");
        reject(new Error("隔离服务未返回本机地址"));
        return;
      }
      resolve({
        app: { request: (path, init) => fetch(`${origin}${path}`, init) },
        exited,
        async [Symbol.asyncDispose]() {
          if (child.connected) child.send("stop");
          const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
          await exited;
          clearTimeout(timeout);
        },
      });
    });
  });
}

async function rezip(entries: Map<string, Buffer>) {
  const stream = new ZipArchive();
  const result = zipToBackupBuffer({ stream, filename: "invalid.zip" });
  for (const [name, data] of entries) stream.append(data, { name });
  await stream.finalize();
  return new Uint8Array(await result);
}

it("管理员下载的双库可在独立目录恢复原稿、成绩、进行中的草稿和旧卷", async () => {
  using source = openInstance();
  const sourceApp = source.app();
  const world = await setupAssignment(sourceApp);
  const teacher = await sourceApp.request("/api/teacher/me", {
    headers: { cookie: world.teacher },
  });
  const operator = teacherInfoOkSchema.parse(await teacher.json()).data.id;
  const admin = source.app(operator);
  const kernelAssignment = await assignKernelFixture(sourceApp, world);
  const posted = await openedAttempt(
    sourceApp,
    kernelAssignment,
    world.ownerCookie,
  );
  const drafting = await openedAttempt(
    sourceApp,
    kernelAssignment,
    world.otherCookie,
  );
  const legacy = await openedAttempt(
    sourceApp,
    world.assignmentId,
    world.ownerCookie,
  );
  const questionId = await answer(sourceApp, posted, world.ownerCookie, 0, 1);
  await answer(sourceApp, legacy, world.ownerCookie, 0, 1);
  const original = await putNoteReceipt(
    sourceApp,
    world.ownerCookie,
    posted,
    questionId,
  );
  const originalPath = `/api/student/note-versions/${original.versionId}/document`;
  const readOriginal = (app: TestApp) =>
    app.request(originalPath, { headers: { cookie: world.ownerCookie } });
  const postedResult = await readResult(
    await submitAttemptRequest(sourceApp, world.ownerCookie, posted, [
      {
        questionId,
        state: "frozen",
        versionId: original.versionId,
        revision: original.revision,
      },
      { questionId: "m04-p0-q2", state: "none" },
    ]),
  );
  const legacyResult = await readResult(
    await submitAttemptRequest(sourceApp, world.ownerCookie, legacy),
  );
  expect(postedResult.attempt.scoreAuto).toBe(50);
  expect(legacyResult.attempt.scoreAuto).toBe(50);
  const beforeOriginal = await readOriginal(sourceApp);
  expect(beforeOriginal.status).toBe(200);
  const originalBytes = Buffer.from(await beforeOriginal.arrayBuffer());
  expect(originalBytes.length).toBeGreaterThan(0);

  let bytes: Uint8Array<ArrayBuffer>;
  {
    await using peer = await startPeer(source.dataDir, operator);
    const kernel = new Database(join(source.dataDir, kernelName), {
      fileMustExist: true,
    });
    try {
      expect(kernel.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
      kernel.exec("BEGIN");
      kernel.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
      await answer(peer.app, drafting, world.otherCookie, 0, 1);
      for (const filename of [dbName, kernelName]) {
        expect(
          statSync(join(source.dataDir, `${filename}-wal`)).size,
        ).toBeGreaterThan(32);
      }
      const download = await admin.request("/api/teacher/backup/download", {
        headers: { cookie: world.teacher },
      });
      expect(download.status, await download.clone().text()).toBe(200);
      bytes = new Uint8Array(await download.arrayBuffer());
      const denied = await restore(admin, world.teacher, bytes);
      expect(denied.status, await denied.clone().text()).toBe(409);
      await expect(denied.json()).resolves.toMatchObject({
        error: "BACKUP_RESTORE_FAILED",
        message: expect.stringContaining("另一个服务进程"),
      });
    } finally {
      kernel.close();
    }
  }

  const entries = readZipEntriesMap(Buffer.from(bytes));
  expect(entries.has(kernelName)).toBe(true);
  const lost = new Map(entries);
  lost.delete(kernelName);
  lost.delete(BACKUP_KERNEL_MANIFEST);
  lost.delete(BACKUP_KERNEL_ARTIFACT);
  const malformed = new Map(entries).set(kernelName, Buffer.alloc(0));
  const replacedManifest = new Map(entries).set(
    BACKUP_KERNEL_MANIFEST,
    Buffer.from("{}"),
  );
  const originalEntry = [...entries.keys()].find(
    (name) => name.startsWith("blobs/notes/") && name.endsWith(".json.gz"),
  );
  if (!originalEntry) throw new Error("完整双库 ZIP 中没有冻结原稿");
  const missingOriginal = new Map(entries);
  missingOriginal.delete(originalEntry);

  const mixed = new Map(entries);
  {
    using other = openInstance();
    const app = other.app();
    const foreign = await setupAssignment(app);
    const assigned = await assignKernelFixture(app, foreign);
    await openedAttempt(app, assigned, foreign.ownerCookie);
    const kernel = readFileSync(join(other.dataDir, kernelName));
    const manifest = backupKernelManifestSchema.parse(
      JSON.parse(entries.get(BACKUP_KERNEL_MANIFEST)?.toString() ?? "null"),
    );
    mixed.set(kernelName, kernel);
    mixed.set(
      BACKUP_KERNEL_MANIFEST,
      Buffer.from(
        JSON.stringify({
          ...manifest,
          kernelSha256: createHash("sha256").update(kernel).digest("hex"),
        }),
      ),
    );
  }
  for (const variant of [
    lost,
    malformed,
    replacedManifest,
    missingOriginal,
    mixed,
  ]) {
    const denied = await restore(admin, world.teacher, await rezip(variant));
    expect(denied.status, await denied.clone().text()).toBe(400);
    await expect(denied.json()).resolves.toMatchObject({
      error: "BACKUP_ZIP_INVALID",
    });
    expect(
      await readResult(await readAttempt(sourceApp, posted, world.ownerCookie)),
    ).toEqual(postedResult);
  }

  using target = openInstance();
  const setup = await target.app().request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password }),
  });
  expect(setup.status).toBe(200);
  const targetApp = target.app(
    teacherInfoOkSchema.parse(await setup.clone().json()).data.id,
  );
  const restored = await restore(
    targetApp,
    `tutor_session=${extractSessionToken(setup)}`,
    bytes,
  );
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(
    await readResult(await readAttempt(targetApp, posted, world.ownerCookie)),
  ).toEqual(postedResult);
  expect(
    await readResult(await readAttempt(targetApp, legacy, world.ownerCookie)),
  ).toEqual(legacyResult);
  const restoredOriginal = await readOriginal(targetApp);
  expect(restoredOriginal.status).toBe(200);
  expect(Buffer.from(await restoredOriginal.arrayBuffer())).toEqual(
    originalBytes,
  );
  expect((await readAttempt(targetApp, posted, world.otherCookie)).status).toBe(
    403,
  );
  expect(
    (await fetchSubmitRevisions(targetApp, world.otherCookie, drafting))[0]
      ?.expectedAnswerRevision,
  ).toBe(1);
  await answer(targetApp, drafting, world.otherCookie, 1, 2);
  const finished = await readResult(
    await submitAttemptRequest(targetApp, world.otherCookie, drafting),
  );
  expect(finished.attempt.scoreAuto).toBe(100);
  expect(existsSync(join(target.dataDir, kernelName))).toBe(true);

  await answer(sourceApp, drafting, world.otherCookie, 1, 2);
  source.handle.close();
  {
    await using interrupted = await startPeer(
      source.dataDir,
      operator,
      "after-kernel-move",
    );
    await expect(
      restore(interrupted.app, world.teacher, bytes),
    ).rejects.toThrow();
    await interrupted.exited;
  }
  const marker = join(source.dataDir, "backups", BACKUP_RESTORE_MARKER);
  expect(existsSync(marker)).toBe(true);
  await using recovered = await startPeer(source.dataDir, operator);
  expect(existsSync(marker)).toBe(false);
  expect(
    await readResult(
      await readAttempt(recovered.app, posted, world.ownerCookie),
    ),
  ).toEqual(postedResult);
  const recoveredOriginal = await readOriginal(recovered.app);
  expect(recoveredOriginal.status).toBe(200);
  expect(Buffer.from(await recoveredOriginal.arrayBuffer())).toEqual(
    originalBytes,
  );
  expect(
    (await fetchSubmitRevisions(recovered.app, world.otherCookie, drafting))[1]
      ?.expectedAnswerRevision,
  ).toBe(1);
}, 90_000);

it("归档并恢复 K9 已重冻而主库待投影的合法截面", async () => {
  using source = openInstance();
  const app = source.app();
  const world = await setupAssignment(app);
  const teacher = await app.request("/api/teacher/me", {
    headers: { cookie: world.teacher },
  });
  const admin = source.app(
    teacherInfoOkSchema.parse(await teacher.json()).data.id,
  );
  const assignment = await assignKernelFixture(app, world);
  const id = await openedAttempt(app, assignment, world.ownerCookie);
  const markdown = readFileSync(
    new URL("../test/m04-p1/fixtures/P0-单选夹具.md", import.meta.url),
    "utf8",
  ).replace("2 + 3 等于多少？", "重冻后：2 + 3 是多少？");
  const imported = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { cookie: world.teacher, "content-type": "application/json" },
    body: JSON.stringify({ filename: "M04P0.md", markdown }),
  });
  expect(imported.status, await imported.clone().text()).toBe(200);

  const product = source.handle.db.$client;
  product.exec(`
    CREATE TRIGGER fail_backup_refreeze_projection
    BEFORE UPDATE OF step_attempt_id ON kernel_attempt_bindings
    BEGIN SELECT RAISE(ABORT, 'forced backup refreeze projection failure'); END
  `);
  const interrupted = await postAssignment(app, assignment, world.ownerCookie);
  expect(interrupted.status).toBe(500);
  product.exec("DROP TRIGGER fail_backup_refreeze_projection");
  const binding = () =>
    source.handle.db.$client
      .prepare(
        "SELECT practice_version FROM kernel_attempt_bindings WHERE attempt_id=?",
      )
      .get(id);
  expect(binding()).toEqual({ practice_version: 1 });
  const runtime = openLearningRuntime({
    databasePath: join(source.dataDir, kernelName),
  });
  try {
    expect(
      runtime.read({ role: "student", id: world.studentId }, id),
    ).toMatchObject({ activityId: id, practiceVersion: 2 });
  } finally {
    runtime.close();
  }

  const download = await admin.request("/api/teacher/backup/download", {
    headers: { cookie: world.teacher },
  });
  expect(download.status, await download.clone().text()).toBe(200);
  const restored = await restore(
    admin,
    world.teacher,
    new Uint8Array(await download.arrayBuffer()),
  );
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(binding()).toEqual({ practice_version: 1 });
  const reply = await readAttempt(app, id, world.ownerCookie);
  expect(reply.status).toBe(200);
  expect(await reply.text()).toContain("重冻后：2 + 3 是多少？");
  expect(binding()).toEqual({ practice_version: 2 });
}, 45_000);
