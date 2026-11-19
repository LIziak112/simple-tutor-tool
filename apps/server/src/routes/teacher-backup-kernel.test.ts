import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempDisposableSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attemptResultOkSchema,
  attemptStartOkSchema,
  BACKUP_KERNEL_ARTIFACT,
  BACKUP_KERNEL_MANIFEST,
  BACKUP_SNAPSHOT_NAME_PATTERN,
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

function openInstance(seed?: (dataDir: string) => void) {
  const data = mkdtempDisposableSync(join(tmpdir(), "ownclass-double-backup-"));
  seed?.(data.path);
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

it("双库同时存在却截自不同时间时，管理员下载和恢复均拒绝遗漏一份内核作答", async () => {
  using source = openInstance();
  const app = source.app();
  const world = await setupAssignment(app);
  const teacher = await app.request("/api/teacher/me", {
    headers: { cookie: world.teacher },
  });
  const operator = teacherInfoOkSchema.parse(await teacher.json()).data.id;
  const admin = source.app(operator);
  const assignment = await assignKernelFixture(app, world);
  const first = await openedAttempt(app, assignment, world.ownerCookie);
  const download = (instance: TestApp) =>
    instance.request("/api/teacher/backup/download", {
      headers: { cookie: world.teacher },
    });
  const earlyResponse = await download(admin);
  expect(earlyResponse.status, await earlyResponse.clone().text()).toBe(200);
  const early = readZipEntriesMap(
    Buffer.from(await earlyResponse.arrayBuffer()),
  );

  const second = await openedAttempt(app, assignment, world.otherCookie);
  await answer(app, second, world.otherCookie, 0, 1);
  const before = await readResult(
    await submitAttemptRequest(app, world.otherCookie, second),
  );
  expect(before.attempt.scoreAuto).toBe(50);
  const lateResponse = await download(admin);
  expect(lateResponse.status, await lateResponse.clone().text()).toBe(200);
  const late = readZipEntriesMap(Buffer.from(await lateResponse.arrayBuffer()));
  const earlyProduct = [...early].find(([name]) =>
    BACKUP_SNAPSHOT_NAME_PATTERN.test(name),
  )?.[1];
  const lateKernel = late.get(kernelName);
  if (!earlyProduct || !lateKernel) throw new Error("样例归档缺少数据库");

  // 组合两次真实下载，从未手改业务行。乙卷的归属只存在于较晚的主库。
  using mixed = openInstance((dataDir) => {
    writeFileSync(join(dataDir, dbName), earlyProduct);
    writeFileSync(join(dataDir, kernelName), lateKernel);
  });
  const mixedApp = mixed.app(operator);
  expect((await readAttempt(mixedApp, first, world.ownerCookie)).status).toBe(
    200,
  );
  expect((await readAttempt(mixedApp, second, world.otherCookie)).status).toBe(
    404,
  );
  const corruptDownload = await download(mixedApp);
  await corruptDownload.arrayBuffer();

  early.set(kernelName, lateKernel);
  const metadata = backupKernelManifestSchema.parse(
    JSON.parse(early.get(BACKUP_KERNEL_MANIFEST)?.toString() ?? "null"),
  );
  early.set(
    BACKUP_KERNEL_MANIFEST,
    Buffer.from(
      JSON.stringify({
        ...metadata,
        kernelSha256: createHash("sha256").update(lateKernel).digest("hex"),
      }),
    ),
  );
  const corruptRestore = await restore(
    admin,
    world.teacher,
    await rezip(early),
  );
  expect([corruptDownload.status, corruptRestore.status]).toEqual([500, 400]);
  await expect(corruptRestore.json()).resolves.toMatchObject({
    error: "BACKUP_ZIP_INVALID",
  });
  expect(
    await readResult(await readAttempt(app, second, world.otherCookie)),
  ).toEqual(before);
  expect((await readAttempt(app, first, world.ownerCookie)).status).toBe(200);
});

it("开卷意图在内核未开卷和内核已开待绑定两种截面均可备份恢复", async () => {
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
  const product = () => source.handle.db.$client;
  product().exec(`
    CREATE TRIGGER stop_backup_open_binding BEFORE INSERT ON kernel_attempt_bindings
    BEGIN SELECT RAISE(ABORT, 'forced backup opening binding failure'); END
  `);
  expect(
    (await postAssignment(app, assignment, world.ownerCookie)).status,
  ).toBe(500);
  product().exec("DROP TRIGGER stop_backup_open_binding");
  const kernelPath = join(source.dataDir, kernelName);
  const kernel = new Database(kernelPath, { fileMustExist: true });
  let prepared: { id: string } | undefined;
  try {
    kernel.exec(`
      CREATE TRIGGER stop_backup_kernel_open BEFORE INSERT ON activities
      BEGIN SELECT RAISE(ABORT, 'forced backup kernel opening failure'); END
    `);
    expect(
      (await postAssignment(app, assignment, world.otherCookie)).status,
    ).toBe(500);
    kernel.exec("DROP TRIGGER stop_backup_kernel_open");
    const rows = kernel
      .prepare<[], { id: string }>("SELECT id FROM activities")
      .all();
    expect(rows).toHaveLength(1);
    [prepared] = rows;
  } finally {
    kernel.close();
  }
  if (!prepared) throw new Error("内核未保存防丢开卷凭据");
  const counts = () =>
    product()
      .prepare(
        "SELECT (SELECT COUNT(*) FROM kernel_assignment_openings) AS intents, (SELECT COUNT(*) FROM kernel_attempt_bindings) AS bound",
      )
      .get();
  expect(counts()).toEqual({ intents: 2, bound: 0 });
  const download = await admin.request("/api/teacher/backup/download", {
    headers: { cookie: world.teacher },
  });
  expect(download.status, await download.clone().text()).toBe(200);
  const bytes = new Uint8Array(await download.arrayBuffer());
  const kBytes = readZipEntriesMap(Buffer.from(bytes)).get(kernelName);
  if (!kBytes) throw new Error("双库 ZIP 中没有内核库");
  const archived = new Database(kBytes);
  try {
    expect(archived.prepare("SELECT id FROM activities").all()).toEqual([
      prepared,
    ]);
  } finally {
    archived.close();
  }
  const restored = await restore(admin, world.teacher, bytes);
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(counts()).toEqual({ intents: 2, bound: 0 });
  expect(await openedAttempt(app, assignment, world.ownerCookie)).toBe(
    prepared.id,
  );
  expect(await openedAttempt(app, assignment, world.otherCookie)).not.toBe(
    prepared.id,
  );
  expect(counts()).toEqual({ intents: 0, bound: 2 });
});

async function prepareBackupOriginals(source: ReturnType<typeof openInstance>) {
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
  const questionId = await answer(app, id, world.ownerCookie, 0, 1);
  const anotherQuestionId = "m04-p0-q2";
  const first = await putNoteReceipt(app, world.ownerCookie, id, questionId);
  const chosen = await putNoteReceipt(
    app,
    world.ownerCookie,
    id,
    questionId,
    2,
    { baseRevision: first.revision },
  );
  const submit = () =>
    submitAttemptRequest(app, world.ownerCookie, id, [
      {
        questionId,
        state: "frozen",
        versionId: chosen.versionId,
        revision: chosen.revision,
      },
      { questionId: anotherQuestionId, state: "none" },
    ]);
  const download = () =>
    admin.request("/api/teacher/backup/download", {
      headers: { cookie: world.teacher },
    });
  return {
    app,
    admin,
    world,
    id,
    questionId,
    anotherQuestionId,
    first,
    chosen,
    submit,
    download,
  };
}

it("双库下载与恢复拒绝已投影原稿索引的缺行或错版本", async () => {
  using source = openInstance();
  const fixture = await prepareBackupOriginals(source);
  const {
    app,
    admin,
    world,
    id,
    questionId,
    anotherQuestionId,
    first,
    chosen,
    submit,
    download,
  } = fixture;
  const result = await readResult(await submit());
  expect(
    await readResult(await readAttempt(app, id, world.ownerCookie)),
  ).toEqual(result);
  const clean = await download();
  expect(clean.status, await clean.clone().text()).toBe(200);
  const entries = readZipEntriesMap(Buffer.from(await clean.arrayBuffer()));
  const productFile = [...entries.keys()].find((name) =>
    BACKUP_SNAPSHOT_NAME_PATTERN.test(name),
  );
  const productBytes = productFile ? entries.get(productFile) : undefined;
  if (!productFile || !productBytes) throw new Error("双库 ZIP 中没有主库");

  const removeNone = (db: Database.Database) =>
    db
      .prepare(
        "DELETE FROM submission_evidence WHERE attempt_id = ? AND question_id = ?",
      )
      .run(id, anotherQuestionId);
  const snapshotDb = new Database(productBytes);
  try {
    expect(removeNone(snapshotDb).changes).toBe(1);
    const damaged = snapshotDb.serialize();
    entries.set(productFile, damaged);
    const manifest = backupKernelManifestSchema.parse(
      JSON.parse(entries.get(BACKUP_KERNEL_MANIFEST)?.toString() ?? "null"),
    );
    entries.set(
      BACKUP_KERNEL_MANIFEST,
      Buffer.from(
        JSON.stringify({
          ...manifest,
          productSha256: createHash("sha256").update(damaged).digest("hex"),
        }),
      ),
    );
  } finally {
    snapshotDb.close();
  }
  const rejectedArchive = await restore(
    admin,
    world.teacher,
    await rezip(entries),
  );
  const product = source.handle.db.$client;
  expect(rejectedArchive.status, await rejectedArchive.clone().text()).toBe(
    400,
  );
  await expect(rejectedArchive.json()).resolves.toMatchObject({
    error: "BACKUP_ZIP_INVALID",
  });
  expect(
    await readResult(await readAttempt(app, id, world.ownerCookie)),
  ).toEqual(result);

  const evidence = () =>
    product
      .prepare(
        "SELECT question_id, state, version_id, recorded_at FROM submission_evidence WHERE attempt_id = ? ORDER BY question_id",
      )
      .all(id);
  expect(removeNone(product).changes).toBe(1);
  const ordinary = await readAttempt(app, id, world.ownerCookie);
  expect(ordinary.status).toBe(409);
  await expect(ordinary.json()).resolves.toMatchObject({
    error: "NOTE_EVIDENCE_MISMATCH",
  });
  const assertRejectedDownload = async () => {
    const unchanged = evidence();
    const refused = await download();
    expect(refused.status, refused.headers.get("content-type") ?? "").toBe(500);
    await expect(refused.json()).resolves.toMatchObject({ ok: false });
    expect(evidence()).toEqual(unchanged);
  };
  await assertRejectedDownload();

  // 两个正文都完好，只有回执指定的第二版能作正式原稿。
  product
    .prepare(
      "INSERT INTO submission_evidence (id, attempt_id, question_id, state, recorded_at) SELECT ?, attempt_id, ?, 'none', recorded_at FROM submission_evidence WHERE attempt_id = ? AND question_id = ?",
    )
    .run(crypto.randomUUID(), anotherQuestionId, id, questionId);
  const changeVersion = product.prepare(
    "UPDATE submission_evidence SET version_id = ? WHERE attempt_id = ? AND question_id = ? AND version_id = ?",
  );
  expect(
    changeVersion.run(first.versionId, id, questionId, chosen.versionId)
      .changes,
  ).toBe(1);
  await assertRejectedDownload();
  expect(
    product
      .prepare("DELETE FROM submission_evidence WHERE attempt_id = ?")
      .run(id).changes,
  ).toBe(2);
  await assertRejectedDownload();
});

it("合法已确认待投影可导出原截面并在恢复后按原操作生成原稿索引", async () => {
  using source = openInstance();
  const {
    app,
    admin,
    world,
    id,
    questionId,
    anotherQuestionId,
    chosen,
    submit,
    download,
  } = await prepareBackupOriginals(source);
  const product = () => source.handle.db.$client;
  product().exec(`
    CREATE TRIGGER fail_backup_confirmation_projection BEFORE UPDATE OF status ON attempts
    WHEN OLD.status = 'draft' AND NEW.status <> 'draft'
    BEGIN SELECT RAISE(ABORT, 'forced backup confirmation projection failure'); END
  `);
  expect((await submit()).status).toBe(500);
  product().exec("DROP TRIGGER fail_backup_confirmation_projection");
  const state = (db: Database.Database) =>
    db
      .prepare(`
    SELECT status, (SELECT COUNT(*) FROM submission_evidence WHERE attempt_id = attempts.id) AS evidence_count
    FROM attempts WHERE id = ?
  `)
      .get(id);
  const original = { status: "draft", evidence_count: 0 };
  expect(state(product())).toEqual(original);
  const downloadResponse = await download();
  expect(downloadResponse.status, await downloadResponse.clone().text()).toBe(
    200,
  );
  expect(state(product())).toEqual(original);
  const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
  const archivedProduct = [...readZipEntriesMap(Buffer.from(bytes))].find(
    ([name]) => BACKUP_SNAPSHOT_NAME_PATTERN.test(name),
  )?.[1];
  if (!archivedProduct) throw new Error("双库 ZIP 中没有主库");
  const archived = new Database(archivedProduct);
  try {
    expect(state(archived)).toEqual(original);
  } finally {
    archived.close();
  }

  const restored = await restore(admin, world.teacher, bytes);
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(state(product())).toEqual(original);
  const result = await readResult(
    await readAttempt(app, id, world.ownerCookie),
  );
  expect(result.attempt.scoreAuto).toBe(50);
  expect(
    product()
      .prepare(
        "SELECT question_id, state, version_id FROM submission_evidence WHERE attempt_id = ? ORDER BY question_id",
      )
      .all(id),
  ).toEqual([
    { question_id: questionId, state: "frozen", version_id: chosen.versionId },
    { question_id: anotherQuestionId, state: "none", version_id: null },
  ]);
});
