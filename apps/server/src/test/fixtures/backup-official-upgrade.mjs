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

const [sourceZip, fixture, inputSha256, expectedRuntime] =
  process.argv.slice(2);
assert.ok(
  sourceZip && ["K10", "K11", "K11-amended", "K12-amended"].includes(fixture),
);
const sha256 = /^[0-9a-f]{64}$/u;
assert.ok(sha256.test(inputSha256) && sha256.test(expectedRuntime));
const amended = fixture.endsWith("-amended");
const oldRuntime =
  fixture === "K10"
    ? "922ec7f9091aea01506a725754830765a9c394edaf1753d680210b883d8b1413"
    : fixture === "K12-amended"
      ? "7bc836b57ec9140d3ee898a489e03b414490c89de491690c981580548a87c1f3"
      : "1968b032742f9626b5d8270984965b39c27ea67541c36ec51a8e12ed9c40d5d5";
const amendedQuestion = "m04-p0-q1";
const studentContinued = fixture === "K12-amended";
const amendedRevision = studentContinued ? 2 : 1;
const amendedAnswer = { kind: "choice", index: studentContinued ? 0 : 1 };
const restoredAnswerIndex = amended ? 1 - amendedAnswer.index : 1;
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
assert.equal(hash(input), inputSha256);

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
assert.equal(
  old.manifest.kernelSchemaVersion,
  fixture === "K10" ? 13 : fixture === "K12-amended" ? 15 : 14,
);
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
  amended
    ? [
        ["draft", "合成甲"],
        ["graded", "合成甲"],
      ]
    : [
        ["draft", "合成甲"],
        ["graded", "合成乙"],
        ["graded", "合成甲"],
      ],
);
const [draft] = facts;
const halfScore = facts.at(-1);
const fullScore = amended ? undefined : facts[1];
const documentBytes = old.entries.get(original?.documentPath);
const imageBytes = old.entries.get(original?.imagePath);
assert.ok(operator);
if (amended) {
  assert.equal(original, undefined);
} else {
  assert.equal(original?.attemptId, halfScore.id);
  assert.equal(original.revision, 2);
  assert.ok(documentBytes?.length && imageBytes?.length);
}

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
    amendmentAuditCount() {
      return handle.db.$client
        .prepare(`SELECT COUNT(*) FROM response_edit_audits e
          JOIN responses r ON r.id = e.response_id
          WHERE r.attempt_id = ? AND r.question_id = ? AND e.kind = 'answer'
            AND e.answer_revision = 1`)
        .pluck()
        .get(draft.id, amendedQuestion);
    },
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
  const results = [[halfScore, owner, 50]];
  const other =
    fullScore && (await loginStudent(app, fullScore.login, studentPassword));
  if (fullScore) results.push([fullScore, other, 100]);
  for (const [attempt, cookie, score] of results) {
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
  if (original) {
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
    assert.equal(
      (await get(app, `${originalPath}/document`, other)).status,
      403,
    );
  }
  const draftDetail = async () => {
    const response = await get(app, `/api/student/attempts/${draft.id}`, owner);
    assert.equal(response.status, 200);
    return attemptDraftOkSchema.parse(await response.json()).data;
  };
  if (amended) {
    const view = await draftDetail();
    assert.deepEqual(view.drafts[amendedQuestion], amendedAnswer);
    assert.equal(view.draftRevisions[amendedQuestion], amendedRevision);
    const detail = await get(app, `/api/teacher/attempts/${draft.id}`, teacher);
    assert.equal(detail.status, 200);
    const question = teacherAttemptDetailOkSchema
      .parse(await detail.json())
      .data.questions.find((row) => row.questionId === amendedQuestion);
    assert.deepEqual(question?.answer, amendedAnswer);
    assert.equal(question.changeCount, studentContinued ? 1 : 0);
    assert.equal(target.amendmentAuditCount(), 1);
  }
  return { app, teacher, owner, draftDetail };
}

async function saveDraft(context, questionNo, index = 1) {
  const view = await context.draftDetail();
  const question = (
    await fetchSubmitRevisions(context.app, context.owner, draft.id)
  )[questionNo];
  assert.ok(question);
  const answer = { kind: "choice", index };
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
  assert.equal(
    saved.draftRevisions[question.questionId],
    question.expectedAnswerRevision + 1,
  );
  return question.questionId;
}

using upgraded = openTarget();
const oldRestore = await restoreFresh(upgraded, input, `${fixture} 官方归档`);
const state = await readRecovered(upgraded);
const first = await saveDraft(state, amended ? 1 : 0);
if (amended) assert.notEqual(first, amendedQuestion);

const endpoint = "/api/teacher/backup/download";
assert.equal((await get(upgraded.app(), endpoint, state.teacher)).status, 403);
assert.equal((await get(state.app, endpoint, state.owner)).status, 401);
const downloaded = await get(state.app, endpoint, state.teacher);
assert.equal(downloaded.status, 200);
assert.equal(downloaded.headers.get("content-type"), "application/zip");
const current = Buffer.from(await downloaded.arrayBuffer());
const exported = readArchive(current, expectedRuntime);
assert.equal(exported.manifest.kernelSchemaVersion, 16);

using reopened = openTarget();
const currentRestore = await restoreFresh(reopened, current, "当前运行时归档");
const restored = await readRecovered(reopened);
assert.deepEqual((await restored.draftDetail()).drafts[first], {
  kind: "choice",
  index: 1,
});
const second = await saveDraft(restored, amended ? 0 : 1, restoredAnswerIndex);
if (amended) assert.equal(second, amendedQuestion);

async function rejectArtifact(artifact, declaredSha256) {
  const entries = new Map(exported.entries);
  entries.set(BACKUP_KERNEL_ARTIFACT, artifact);
  entries.set(
    BACKUP_KERNEL_MANIFEST,
    Buffer.from(
      JSON.stringify({
        ...exported.manifest,
        kernelArtifactSha256: declaredSha256,
      }),
    ),
  );
  const stream = new ZipArchive();
  const invalid = zipToBackupBuffer({
    stream,
    filename: "invalid-artifact.zip",
  });
  for (const [name, bytes] of entries) stream.append(bytes, { name });
  await stream.finalize();
  const refusal = await restore(
    restored.app,
    restored.teacher,
    await invalid,
    teacherPassword,
  );
  assert.equal(refusal.status, 400);
  assert.equal((await refusal.json()).error, "BACKUP_ZIP_INVALID");
  return refusal.status;
}

const unrecognized = Buffer.from("independent-unrecognized-artifact", "utf8");
const unknownRestore = await rejectArtifact(unrecognized, hash(unrecognized));
const mismatchedArtifactRestore = await rejectArtifact(
  old.entries.get(BACKUP_KERNEL_ARTIFACT),
  expectedRuntime,
);
assert.deepEqual((await restored.draftDetail()).drafts[second], {
  kind: "choice",
  index: restoredAnswerIndex,
});
if (amended) {
  assert.equal(
    (await restored.draftDetail()).draftRevisions[amendedQuestion],
    amendedRevision + 1,
  );
  assert.equal(reopened.amendmentAuditCount(), 1);
}

console.log(
  JSON.stringify({
    fixture,
    oldRestore,
    currentDownload: downloaded.status,
    currentRestore,
    unknownRestore,
    mismatchedArtifactRestore,
    teacherScores: amended ? [50] : [50, 100],
    draftWrites: 2,
    frozenOriginalRevision: original?.revision,
    documentBytes: documentBytes?.length,
    imageBytes: imageBytes?.length,
    amendmentAuditCount: amended ? reopened.amendmentAuditCount() : undefined,
    amendmentAnswerRevisionAfterStudentWrite: amended
      ? amendedRevision + 1
      : undefined,
    kernelBefore: old.manifest.kernelSchemaVersion,
    kernelAfter: exported.manifest.kernelSchemaVersion,
    inputKernelArtifactSha256: oldRuntime,
    kernelArtifactSha256: expectedRuntime,
    inputZipSha256: inputSha256,
    currentZipSha256: hash(current),
  }),
);
