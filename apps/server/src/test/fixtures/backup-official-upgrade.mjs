import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempDisposableSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attemptDraftOkSchema,
  attemptResultOkSchema,
  BACKUP_KERNEL_ARTIFACT,
  BACKUP_KERNEL_DATABASE,
  BACKUP_KERNEL_MANIFEST,
  BACKUP_SNAPSHOT_NAME_PATTERN,
  backupKernelManifestSchema,
  teacherAttemptDetailOkSchema,
  teacherInfoOkSchema,
} from "@tutor/contract";
import { ZipArchive } from "archiver";
import Database from "better-sqlite3";
import pino from "pino";
import { createApp } from "../../app.ts";
import { runBackfills } from "../../db/backfill.ts";
import { createDbHandle } from "../../db/client.ts";
import { runMigrations } from "../../db/migrate.ts";
import { readZipEntriesMap } from "../../lib/zip-read.ts";
import { zipToBackupBuffer } from "../backup-fixtures.ts";
import { nodePeerBindings } from "../node-peer.ts";
import { extractSessionToken, loginStudent } from "../note-world.ts";
import { fetchSubmitRevisions } from "../submit-revisions.ts";

const [sourceZip, expectedRuntime] = process.argv.slice(2);
const oldRuntime =
  "922ec7f9091aea01506a725754830765a9c394edaf1753d680210b883d8b1413";
assert.ok(sourceZip && /^[0-9a-f]{64}$/u.test(expectedRuntime));
assert.notEqual(
  expectedRuntime,
  oldRuntime,
  "探针须验证 K10 归档在后代运行时上的恢复",
);
const {
  OWNCLASS_BACKUP_FIXTURE_TEACHER_PASSWORD: teacherPassword,
  OWNCLASS_BACKUP_FIXTURE_STUDENT_PASSWORD: studentPassword,
} = process.env;
assert.ok(
  teacherPassword && studentPassword,
  "通过环境变量提供合成归档的登录口令",
);

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const input = readFileSync(sourceZip);
assert.equal(
  hash(input),
  "91bb913d0441f6d37036345c98af65b7cd132e9e29321774259569e90d091329",
);

function readArchive(bytes, runtime) {
  const entries = readZipEntriesMap(bytes);
  const manifest = backupKernelManifestSchema.parse(
    JSON.parse(entries.get(BACKUP_KERNEL_MANIFEST).toString()),
  );
  assert.equal(manifest.kernelArtifactSha256, runtime);
  assert.equal(hash(entries.get(BACKUP_KERNEL_ARTIFACT)), runtime);
  assert.equal(
    hash(entries.get(BACKUP_KERNEL_DATABASE)),
    manifest.kernelSha256,
  );
  const product = [...entries].find(([name]) =>
    BACKUP_SNAPSHOT_NAME_PATTERN.test(name),
  )?.[1];
  assert.ok(product);
  assert.equal(hash(product), manifest.productSha256);
  return { entries, product, manifest };
}

const old = readArchive(input, oldRuntime);
assert.equal(old.manifest.kernelSchemaVersion, 13);
const snapshot = new Database(old.product);
let facts;
let original;
let operator;
try {
  facts = snapshot
    .prepare(`
    SELECT a.id, a.status, s.login_name AS login
    FROM attempts a JOIN students s ON s.id = a.student_id ORDER BY a.status, s.login_name
  `)
    .all();
  original = snapshot
    .prepare(`
    SELECT e.attempt_id AS attemptId, v.id AS versionId, v.revision, v.body_path AS documentPath,
      i.id AS imageId, i.path AS imagePath
    FROM submission_evidence e JOIN note_versions v ON v.id = e.version_id
    JOIN note_images i ON i.note_version_id = v.id WHERE e.state = 'frozen' AND i.state = 'ready'
  `)
    .get();
  operator = snapshot
    .prepare("SELECT id, login_name AS login FROM teachers WHERE is_admin = 1")
    .get();
} finally {
  snapshot.close();
}
assert.deepEqual(
  facts.map(({ status, login }) => [status, login]),
  [
    ["draft", "合成甲"],
    ["graded", "合成乙"],
    ["graded", "合成甲"],
  ],
);
assert.equal(original?.attemptId, facts[2].id);
assert.equal(original.revision, 2);
const [draft, fullScore, halfScore] = facts;
const documentBytes = old.entries.get(original.documentPath);
const imageBytes = old.entries.get(original.imagePath);
assert.ok(documentBytes?.length && imageBytes?.length && operator);

function openTarget() {
  const directory = mkdtempDisposableSync(
    join(tmpdir(), "ownclass-official-backup-"),
  );
  const handle = createDbHandle(join(directory.path, "tutor.db"), (db) => {
    runMigrations(db);
    runBackfills(db);
  });
  const app = (backupOperatorId) =>
    createApp({
      db: handle.db,
      dbHandle: handle,
      dataDir: directory.path,
      backupOperatorId,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
      isProduction: false,
    });
  return {
    app,
    [Symbol.dispose]() {
      handle.close();
      directory.remove();
    },
  };
}

const json = { "content-type": "application/json" };
const postJson = (app, path, body) =>
  app.request(
    path,
    { method: "POST", headers: json, body: JSON.stringify(body) },
    nodePeerBindings("10.0.0.2"),
  );
const get = (app, path, cookie) => app.request(path, { headers: { cookie } });
async function restore(app, cookie, bytes, password) {
  const body = new FormData();
  body.set("zip", new File([new Uint8Array(bytes)], "fixture-backup.zip"));
  body.set("password", password);
  return app.request("/api/teacher/backup/restore", {
    method: "POST",
    headers: { cookie },
    body,
  });
}

async function restoreFresh(target, bytes, label) {
  const password = randomUUID();
  const setup = await postJson(target.app(), "/api/public/teacher/setup", {
    loginName: "synthetic-backup-operator",
    password,
  });
  assert.equal(setup.status, 200);
  const { data: fresh } = teacherInfoOkSchema.parse(await setup.clone().json());
  const response = await restore(
    target.app(fresh.id),
    `tutor_session=${extractSessionToken(setup)}`,
    bytes,
    password,
  );
  assert.equal(
    response.status,
    200,
    `${label}：${response.status === 200 ? "" : await response.clone().text()}`,
  );
  return response.status;
}

async function readRecovered(target) {
  const app = target.app(operator.id);
  const login = await postJson(app, "/api/public/teacher/login", {
    loginName: operator.login,
    password: teacherPassword,
  });
  assert.equal(login.status, 200);
  const teacher = `tutor_session=${extractSessionToken(login)}`;
  const owner = await loginStudent(app, halfScore.login, studentPassword);
  const other = await loginStudent(app, fullScore.login, studentPassword);
  for (const [attempt, cookie, score] of [
    [halfScore, owner, 50],
    [fullScore, other, 100],
  ]) {
    const result = await get(
      app,
      `/api/student/attempts/${attempt.id}`,
      cookie,
    );
    assert.equal(result.status, 200);
    assert.equal(
      attemptResultOkSchema.parse(await result.json()).data.summary.total,
      2,
    );
    const detail = await get(
      app,
      `/api/teacher/attempts/${attempt.id}`,
      teacher,
    );
    assert.equal(detail.status, 200);
    assert.equal(
      teacherAttemptDetailOkSchema.parse(await detail.json()).data.scoreAuto,
      score,
    );
  }
  const originalPath = `/api/student/note-versions/${original.versionId}`;
  const document = await get(app, `${originalPath}/document`, owner);
  const image = await get(
    app,
    `${originalPath}/images/${original.imageId}.png`,
    owner,
  );
  assert.equal(document.status, 200);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await document.arrayBuffer()), documentBytes);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), imageBytes);
  assert.equal((await get(app, `${originalPath}/document`, other)).status, 403);
  const draftDetail = async () => {
    const response = await get(app, `/api/student/attempts/${draft.id}`, owner);
    assert.equal(response.status, 200);
    return attemptDraftOkSchema.parse(await response.json()).data;
  };
  return { app, teacher, owner, draftDetail };
}

async function saveDraft(context, questionNo) {
  const view = await context.draftDetail();
  const question = (
    await fetchSubmitRevisions(context.app, context.owner, draft.id)
  )[questionNo];
  assert.ok(question);
  const answer = { kind: "choice", index: 1 };
  const response = await context.app.request(
    `/api/student/attempts/${draft.id}/answers/${question.questionId}`,
    {
      method: "PUT",
      headers: { ...json, cookie: context.owner },
      body: JSON.stringify({
        answer,
        mutationId: randomUUID(),
        baseRevision: question.expectedAnswerRevision,
        expectedFrozenAt: view.attempt.frozenAt,
        questionRevisionId: question.questionRevisionId,
      }),
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await context.draftDetail();
  assert.deepEqual(saved.drafts[question.questionId], answer);
  return question.questionId;
}

using upgraded = openTarget();
const oldRestore = await restoreFresh(upgraded, input, "K10 官方归档");
const state = await readRecovered(upgraded);
const first = await saveDraft(state, 0);

const endpoint = "/api/teacher/backup/download";
assert.equal((await get(upgraded.app(), endpoint, state.teacher)).status, 403);
assert.equal((await get(state.app, endpoint, state.owner)).status, 401);
const downloaded = await get(state.app, endpoint, state.teacher);
assert.equal(downloaded.status, 200);
assert.equal(downloaded.headers.get("content-type"), "application/zip");
const current = Buffer.from(await downloaded.arrayBuffer());
const exported = readArchive(current, expectedRuntime);
assert.equal(exported.manifest.kernelSchemaVersion, 14);

using reopened = openTarget();
const currentRestore = await restoreFresh(reopened, current, "当前运行时归档");
const restored = await readRecovered(reopened);
assert.deepEqual((await restored.draftDetail()).drafts[first], {
  kind: "choice",
  index: 1,
});
const second = await saveDraft(restored, 1);

const unrecognized = Buffer.from("independent-unrecognized-artifact", "utf8");
exported.entries.set(BACKUP_KERNEL_ARTIFACT, unrecognized);
exported.entries.set(
  BACKUP_KERNEL_MANIFEST,
  Buffer.from(
    JSON.stringify({
      ...exported.manifest,
      kernelArtifactSha256: hash(unrecognized),
    }),
  ),
);
const stream = new ZipArchive();
const invalid = zipToBackupBuffer({ stream, filename: "unrecognized.zip" });
for (const [name, bytes] of exported.entries) stream.append(bytes, { name });
await stream.finalize();
const refusal = await restore(
  restored.app,
  restored.teacher,
  await invalid,
  teacherPassword,
);
assert.equal(refusal.status, 400);
assert.equal((await refusal.json()).error, "BACKUP_ZIP_INVALID");
assert.deepEqual((await restored.draftDetail()).drafts[second], {
  kind: "choice",
  index: 1,
});

console.log(
  JSON.stringify({
    oldRestore,
    currentDownload: downloaded.status,
    currentRestore,
    unknownRestore: refusal.status,
    teacherScores: [50, 100],
    legacyDraftWrites: 2,
    frozenOriginalRevision: original.revision,
    documentBytes: documentBytes.length,
    imageBytes: imageBytes.length,
    kernelBefore: old.manifest.kernelSchemaVersion,
    kernelAfter: exported.manifest.kernelSchemaVersion,
    kernelArtifactSha256: expectedRuntime,
  }),
);
