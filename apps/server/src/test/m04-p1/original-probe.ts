import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import {
  attemptDraftOkSchema,
  attemptStartOkSchema,
  noteHeadDataSchema,
  noteVersionReceiptSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { openLearningRuntime } from "learning-kernel";
import pino from "pino";
import { z } from "zod";
import serverPackage from "../../../package.json" with { type: "json" };
import { createDb } from "../../db/client.ts";
import { attempts } from "../../db/schema.ts";
import { createTestDb, createTestDir } from "../../db/test-utils.ts";
import { requireAssignmentVisible } from "../../services/attempt-access.ts";
import { attemptResponseRows } from "../../services/attempt-freeze.ts";
import { reserveSubmissionOriginals } from "../../services/attempt-original-reservation.ts";
import { withAllowRedo } from "../../services/attempt-redo-policy.ts";
import { attemptSummaryOf } from "../../services/attempt-summary.ts";
import {
  gcNoteVersions,
  NOTE_GC_SAFETY_WINDOW_MS,
} from "../../services/note-gc.ts";
import { assertNoLeak } from "../assert-no-leak.ts";
import {
  gzipJson,
  makeNotePng,
  noteDoc,
  postNoteImage,
  putNoteBodyForm,
} from "../note-fixtures.ts";
import { createTrialApp } from "./assembly.ts";
import {
  attemptFacts,
  loginAssignmentOwner,
  postAssignment,
  removeAssignmentOwner,
  setupAssignment,
  verifyInactiveOwnerCookies,
} from "./product-fixture.ts";
import {
  draftForAssignment,
  projectTrialDraft,
  publicationForAssignment,
} from "./publication.ts";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

const dependency = serverPackage.dependencies["learning-kernel"];
const match = /^file:(vendor\/learning-kernel-([0-9a-f]{64})\.tgz)$/u.exec(
  dependency,
);
assert.ok(match?.[1] && match[2], "内核依赖必须按内容寻址");
const candidateHash = sha256(
  readFileSync(new URL(`../../../${match[1]}`, import.meta.url)),
);
assert.equal(candidateHash, match[2]);

const dataDir = createTestDir();
const productDatabase = join(dataDir, "ownclass.sqlite");
const kernelDatabase = join(dataDir, "learning-kernel.sqlite");
const template = createTestDb();
writeFileSync(productDatabase, template.$client.serialize());
template.$client.close();
let db = createDb(productDatabase);
let runtime = openLearningRuntime({ databasePath: kernelDatabase });
const receiptSchema = z.object({
  activityId: z.uuid(),
  stepAttemptId: z.uuid(),
  startedAt: z.iso.datetime(),
});
let receipt: z.infer<typeof receiptSchema> | undefined;
let projectOnOpen = false;

function mountApp() {
  // 原作业入口交给内核，详情和笔记继续走产品 API。
  return createTrialApp(
    {
      db,
      dataDir,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
      isProduction: false,
    },
    (productDb, studentId, assignmentId) => {
      const assignment = requireAssignmentVisible(
        productDb,
        studentId,
        assignmentId,
      );
      const publication = publicationForAssignment(
        productDb,
        assignment,
        studentId,
      );
      assert.deepEqual(publication.revisions, [
        { id: "m04-p0-q1", version: 1 },
        { id: "m04-p0-q2", version: 1 },
      ]);
      runtime.publish(publication.input);
      receipt = receiptSchema.parse(
        runtime.start(
          { role: "student", id: studentId },
          {
            protocolVersion: 1,
            operationId: `open:${assignmentId}`,
            practiceId: assignmentId,
            practiceVersion: 1,
          },
        ),
      );
      const draft = draftForAssignment(
        assignment,
        studentId,
        receipt.activityId,
        receipt.startedAt,
      );
      if (projectOnOpen) projectTrialDraft(productDb, draft);
      return withAllowRedo(attemptSummaryOf(draft), assignment.allowRedo);
    },
  );
}

async function errorCode(response: Response, status: number, code: string) {
  const payload: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(payload));
  assertNoLeak(payload);
  assert.equal(
    z
      .strictObject({
        ok: z.literal(false),
        error: z.string(),
        message: z.string(),
      })
      .parse(payload).error,
    code,
  );
}

function readOnlyKernelFacts() {
  const sqlite = new DatabaseSync(kernelDatabase, { readOnly: true });
  try {
    return {
      activities: sqlite
        .prepare("SELECT id, student_id, practice_id FROM activities")
        .all()
        .map((row) => ({ ...row })),
      submissions: sqlite.prepare("SELECT COUNT(*) AS n FROM submissions").get()
        ?.n,
      verdicts: sqlite
        .prepare("SELECT COUNT(*) AS n FROM automatic_verdicts")
        .get()?.n,
      completions: sqlite.prepare("SELECT COUNT(*) AS n FROM completions").get()
        ?.n,
    };
  } finally {
    sqlite.close();
  }
}

let app = mountApp();
try {
  const world = await setupAssignment(app);
  const { assignmentId, studentId, ownerCookie, otherCookie, teacher } = world;
  const student = { role: "student", id: studentId } as const;
  const headers = { cookie: ownerCookie };
  const setInk = async (enabledCapabilities: [] | ["ink"]) => {
    const response = await app.request(
      "/api/teacher/settings/capability-profile",
      {
        method: "PUT",
        headers: { cookie: teacher, "content-type": "application/json" },
        body: JSON.stringify({ enabledCapabilities }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as { data: unknown }).data, {
      enabledCapabilities,
    });
  };
  await setInk([]);

  const opening = await postAssignment(app, assignmentId, ownerCookie);
  assert.equal(opening.status, 200);
  const opened = attemptStartOkSchema.parse(await opening.json()).data;
  assert.ok(receipt);
  const { activityId, stepAttemptId, startedAt } = receipt;
  assert.equal(opened.id, activityId);
  assert.equal(opened.startedAt, startedAt);
  assert.ok(opened.frozenAt);
  const frozenAt = opened.frozenAt;
  const kernelBefore = runtime.read(student, activityId);
  assert.equal(kernelBefore.activityId, activityId);
  const initialFacts = readOnlyKernelFacts();
  assert.deepEqual(initialFacts, {
    activities: [
      { id: activityId, student_id: studentId, practice_id: assignmentId },
    ],
    submissions: 0,
    verdicts: 0,
    completions: 0,
  });

  const path = `/api/student/attempts/${activityId}`;
  const firstId = "m04-p0-q1";
  const secondId = "m04-p0-q2";
  const notePath = (questionId: string) => `${path}/notes/${questionId}`;
  const putNote = (cookie: string, strokes: number, baseRevision = 0) => {
    const body = putNoteBodyForm(gzipJson(noteDoc(strokes)), { baseRevision });
    body.set("expectedFrozenAt", frozenAt);
    return app.request(notePath(firstId), {
      method: "PUT",
      headers: { cookie },
      body,
    });
  };
  async function draft() {
    const response = await app.request(path, { headers });
    assert.equal(response.status, 200);
    const payload: unknown = await response.json();
    assertNoLeak(payload);
    return attemptDraftOkSchema.parse(payload).data;
  }
  async function head(questionId: string) {
    const response = await app.request(notePath(questionId), { headers });
    assert.equal(response.status, 200);
    const payload = z
      .object({ ok: z.literal(true), data: noteHeadDataSchema })
      .parse(await response.json());
    return payload.data;
  }
  async function savedNote(cookie: string, strokes: number, baseRevision = 0) {
    const response = await putNote(cookie, strokes, baseRevision);
    assert.equal(response.status, 200);
    const payload = z
      .object({ ok: z.literal(true), data: noteVersionReceiptSchema })
      .parse(await response.json());
    return payload.data;
  }

  assert.deepEqual(attemptFacts(db), {
    attempts: 0,
    responses: 0,
    scores: 0,
    evidence: 0,
    settlements: 0,
  });
  await errorCode(
    await app.request(notePath(firstId), { headers }),
    404,
    "ATTEMPT_NOT_FOUND",
  );
  await errorCode(await putNote(ownerCookie, 1), 404, "ATTEMPT_NOT_FOUND");

  const assignment = requireAssignmentVisible(db, studentId, assignmentId);
  const productDraft = draftForAssignment(
    assignment,
    studentId,
    activityId,
    startedAt,
  );
  db.insert(attempts).values(productDraft).run();
  await errorCode(
    await app.request(notePath(firstId), { headers }),
    404,
    "QUESTION_NOT_FOUND",
  );
  await errorCode(await putNote(ownerCookie, 1), 404, "QUESTION_NOT_FOUND");
  assert.equal(
    db.delete(attempts).where(eq(attempts.id, activityId)).run().changes,
    1,
  );
  projectOnOpen = true;
  const projected = await postAssignment(app, assignmentId, ownerCookie);
  assert.equal(projected.status, 200);
  assert.deepEqual(
    attemptStartOkSchema.parse(await projected.json()).data,
    opened,
  );
  assert.deepEqual(receipt, { activityId, stepAttemptId, startedAt });
  const frozenRows = attemptResponseRows(db, activityId).map(
    ({ id, questionId, questionVersion }) => ({
      questionRevisionId: id,
      questionId,
      questionVersion,
    }),
  );
  const detail = await draft();
  assert.equal(detail.attempt.id, activityId);
  assert.equal(detail.attempt.frozenAt, frozenAt);
  assert.deepEqual(
    detail.units.flatMap((unit) =>
      unit.questions.map(({ id, questionRevisionId, questionVersion }) => ({
        questionRevisionId,
        questionId: id,
        questionVersion,
      })),
    ),
    frozenRows,
  );
  assert.deepEqual(
    frozenRows.map(({ questionId, questionVersion }) => [
      questionId,
      questionVersion,
    ]),
    [
      [firstId, 1],
      [secondId, 1],
    ],
  );
  assert.equal(
    new Set(frozenRows.map(({ questionRevisionId }) => questionRevisionId))
      .size,
    2,
  );

  assert.deepEqual(detail.enabledCapabilities, []);
  assert.equal((await head(firstId)).note, null);
  await setInk(["ink"]);
  assert.deepEqual((await draft()).enabledCapabilities, ["ink"]);
  const original = await savedNote(ownerCookie, 1);
  assert.equal(original.revision, 1);
  const png = makeNotePng();
  const imageResponse = await postNoteImage(
    app,
    "student",
    original.versionId,
    png,
    ownerCookie,
  );
  assert.equal(imageResponse.status, 200);
  const {
    data: { imageId },
  } = z
    .object({ data: z.object({ imageId: z.uuid() }) })
    .parse(await imageResponse.json());
  const documentPath = `/api/student/note-versions/${original.versionId}/document`;
  const imagePath = `/api/student/note-versions/${original.versionId}/images/${imageId}.png`;
  const readAsset = (url: string, cookie = ownerCookie) =>
    app.request(url, { headers: { cookie } });
  async function bytes(url: string, mime: string) {
    const response = await readAsset(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), mime);
    return Buffer.from(await response.arrayBuffer());
  }
  const bodyV1 = await bytes(documentPath, "application/gzip");
  assert.equal(sha256(gunzipSync(bodyV1)), original.hash);
  assert.deepEqual(await bytes(imagePath, "image/png"), Buffer.from(png));
  const intent = {
    operationId: randomUUID(),
    attemptId: activityId,
    studentId,
    originals: [
      {
        questionId: firstId,
        versionId: original.versionId,
        revision: original.revision,
      },
    ],
  };
  const reserved = reserveSubmissionOriginals(db, dataDir, intent);
  assert.deepEqual(reserved, [{ ...intent.originals[0], hash: original.hash }]);

  await setInk([]);
  assert.deepEqual((await draft()).enabledCapabilities, []);
  assert.equal(
    (await head(firstId)).note?.currentVersionId,
    original.versionId,
  );
  await removeAssignmentOwner(app, world);
  assert.equal(
    (await head(firstId)).note?.currentVersionId,
    original.versionId,
  );
  await errorCode(
    await postAssignment(app, assignmentId, ownerCookie),
    403,
    "FORBIDDEN",
  );
  const secondSession = await loginAssignmentOwner(app);
  assert.notEqual(secondSession, ownerCookie);
  const newer = await savedNote(secondSession, 2, 1);
  assert.equal(newer.revision, 2);
  assert.notEqual(newer.versionId, original.versionId);

  db.$client.close();
  runtime.close();
  db = createDb(productDatabase);
  runtime = openLearningRuntime({ databasePath: kernelDatabase });
  app = mountApp();
  assert.deepEqual(runtime.read(student, activityId), kernelBefore);
  const gc = gcNoteVersions(db, dataDir, {
    now: new Date(Date.parse(newer.savedAt) + NOTE_GC_SAFETY_WINDOW_MS + 1),
  });
  assert.equal(gc.candidateVersionRows, 0);
  assert.equal(gc.deletedVersionRows, 0);
  assert.equal(gc.deletedFiles, 0);
  assert.equal(gc.keptByReference, 2);
  assert.equal(gc.fileFailures, 0);
  assert.deepEqual(reserveSubmissionOriginals(db, dataDir, intent), reserved);
  assert.deepEqual(await bytes(documentPath, "application/gzip"), bodyV1);
  assert.deepEqual(await bytes(imagePath, "image/png"), Buffer.from(png));
  const current = await head(firstId);
  assert.equal(
    current.note?.questionRevisionId,
    frozenRows[0]?.questionRevisionId,
  );
  assert.equal(current.note?.currentVersionId, newer.versionId);
  assert.equal(current.note?.revision, 2);
  assert.equal(current.evidence, null);
  assert.deepEqual(await head(secondId), {
    note: null,
    images: [],
    evidence: null,
    corrections: [],
    supplements: [],
  });

  async function deny(cookie: string, status: number, code: string) {
    await errorCode(
      await app.request(notePath(firstId), { headers: { cookie } }),
      status,
      code,
    );
    await errorCode(await putNote(cookie, 3, 2), status, code);
    await errorCode(await readAsset(documentPath, cookie), status, code);
    await errorCode(await readAsset(imagePath, cookie), status, code);
  }
  await deny(otherCookie, 403, "FORBIDDEN");
  await verifyInactiveOwnerCookies(app, world, (cookie) =>
    deny(cookie, 401, "UNAUTHORIZED"),
  );
  const productFacts = attemptFacts(db);
  assert.deepEqual(productFacts, {
    attempts: 1,
    responses: 2,
    scores: 0,
    evidence: 0,
    settlements: 0,
  });
  assert.equal(
    db.$client
      .prepare(
        "SELECT COUNT(*) AS n FROM attempt_original_reservations WHERE attempt_id = ? AND state = 'pending'",
      )
      .pluck()
      .get(activityId),
    1,
  );
  const kernelFacts = readOnlyKernelFacts();
  assert.deepEqual(kernelFacts, initialFacts);

  console.log(
    JSON.stringify(
      {
        candidateHash,
        productDatabase,
        kernelDatabase,
        activityId,
        stepAttemptId,
        missingHost: {
          read: "404 ATTEMPT_NOT_FOUND",
          write: "404 ATTEMPT_NOT_FOUND",
        },
        withoutFrozenRows: {
          read: "404 QUESTION_NOT_FOUND",
          write: "404 QUESTION_NOT_FOUND",
        },
        frozenRows,
        enabledCapabilities: [[], ["ink"], []],
        noteRevisions: [original.revision, newer.revision],
        reserved,
        gc,
        recovered: {
          headRevision: 2,
          gzipBytes: bodyV1.byteLength,
          pngBytes: png.byteLength,
          gzipSha256: sha256(bodyV1),
          pngSha256: sha256(png),
        },
        rosterRemoval: { read: 200, save: 200, open: 403 },
        access: { other: 403, loggedOut: 401, archived: 401 },
        productFacts,
        kernelFacts,
      },
      null,
      2,
    ),
  );
} finally {
  runtime.close();
  db.$client.close();
}
