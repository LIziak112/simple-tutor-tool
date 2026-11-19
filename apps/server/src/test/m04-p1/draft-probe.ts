import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  attemptAnswerConflictCurrentSchema,
  attemptAnswerSaveDataSchema,
  attemptDraftOkSchema,
  attemptStartOkSchema,
  studentRecordsOkSchema,
} from "@tutor/contract";
import type { openLearningRuntime, StudentPrincipal } from "learning-kernel";
import pino from "pino";
import { z } from "zod";
import { createApp } from "../../app.ts";
import type { Db } from "../../db/client.ts";
import { attempts } from "../../db/schema.ts";
import { createTestDb, createTestDir } from "../../db/test-utils.ts";
import { HttpError } from "../../lib/http-error.ts";
import {
  questionNotFound,
  requireAssignmentVisible,
  requireUsableAttempt,
} from "../../services/attempt-access.ts";
import { assertAttemptWriteProof } from "../../services/attempt-activity.ts";
import type { saveDraftAnswer } from "../../services/attempt-answer.ts";
import {
  attemptResponseRows,
  freezeInputsOfNewAttempt,
  insertFrozenResponses,
} from "../../services/attempt-freeze.ts";
import { assertFrozenAnswerShape } from "../../services/attempt-question-projection.ts";
import { attemptSummaryOf } from "../../services/attempt-summary.ts";
import { studentSelfReviewEnabledOf } from "../../services/practice-feedback-settings-service.ts";
import { snapshotOfRow } from "../../services/snapshot.ts";
import type { TestApp } from "../note-fixtures.ts";
import { createTrialApp } from "./assembly.ts";
import {
  attemptFacts,
  postAssignment,
  setupAssignment,
  verifyInactiveOwnerCookies,
} from "./product-fixture.ts";
import { draftForAssignment, publicationForAssignment } from "./publication.ts";

type DraftRuntime = ReturnType<typeof openLearningRuntime> & {
  saveChoiceDraft(
    principal: StudentPrincipal,
    activityId: string,
    input: {
      protocolVersion: 1;
      operationId: string;
      stepAttemptId: string;
      slotId: string;
      questionId: string;
      questionVersion: number;
      choice: string;
      baseRevision: number;
    },
  ): { questionId: string; revision: number; changeCount: number };
};
const [install] = process.argv.slice(2);
assert.ok(install, "须提供已离线安装草稿试验包的目录");
const preview = resolve(install);
const sha = createHash("sha256")
  .update(readFileSync(join(preview, "learning-kernel-0.1.0.tgz")))
  .digest("hex");
const originalSha =
  "0f946a651e1ebad321f27210af1c092088688edb5e5e343510d42dd8882b88af";
const repairedSha =
  "b3fd31c5b8c153064b32209e332c7e19259bbc700261391c1ae2680fdbfa64b5";
assert.ok(sha === originalSha || sha === repairedSha);
const hasAtomicOperationCurrent = sha === repairedSha;
const requirePreview = createRequire(join(preview, "package.json"));
const entry = requirePreview.resolve("learning-kernel");
const kernel = (await import(pathToFileURL(entry).href)) as {
  openLearningRuntime(input: { databasePath: string }): DraftRuntime;
};
const dataDir = createTestDir();
const kernelPath = join(dataDir, "learning-kernel.sqlite");
const runtime = kernel.openLearningRuntime({ databasePath: kernelPath });
const db = createTestDb();
const oldDb = createTestDb();
const legacyClientDb = createTestDb();
const options = {
  dataDir,
  isProduction: false,
  publicUrl: "http://localhost:8787",
  logger: pino({ enabled: false }),
};
const owner = (id: string): StudentPrincipal => ({ role: "student", id });
const activitySteps = new Map<string, string>();
const parseKernelError = z.object({
  status: z.literal(409),
  code: z.enum(["OPERATION_CONFLICT", "ANSWER_REVISION_CONFLICT"]),
  current: z
    .object({ revision: z.int(), choice: z.string().nullable() })
    .optional(),
});
const kernelOperationErrors: z.infer<typeof parseKernelError>[] = [];
function boundActivity(db: Db, studentId: string, attemptId: string) {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.assignmentId === null)
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  const stepAttemptId = activitySteps.get(attemptId);
  if (!stepAttemptId)
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  return { attempt, stepAttemptId };
}
const saveInKernel: typeof saveDraftAnswer = (
  db,
  studentId,
  attemptId,
  questionId,
  answer,
  proof = {},
) => {
  const { attempt, stepAttemptId } = boundActivity(db, studentId, attemptId);
  const row = attemptResponseRows(db, attemptId).find(
    (row) => row.questionId === questionId,
  );
  if (row === undefined) throw questionNotFound();
  assertAttemptWriteProof(attempt, proof, proof.questionRevisionId, row.id);
  const snapshot = snapshotOfRow(row);
  if (snapshot === null) throw questionNotFound();
  assertFrozenAnswerShape(db, row, snapshot, answer);
  if (
    answer.kind !== "choice" ||
    proof.baseRevision === undefined ||
    proof.mutationId === undefined
  ) {
    throw new HttpError(400, "VALIDATION_ERROR", "须提供单选答案及保存凭据");
  }
  try {
    return attemptAnswerSaveDataSchema.parse(
      runtime.saveChoiceDraft(owner(studentId), attemptId, {
        protocolVersion: 1,
        operationId: proof.mutationId,
        stepAttemptId,
        slotId: "answers",
        questionId,
        questionVersion: row.questionVersion,
        choice: String(answer.index),
        baseRevision: proof.baseRevision,
      }),
    );
  } catch (error) {
    const parsed = parseKernelError.safeParse(error);
    if (!parsed.success) throw error;
    const { code, current } = parsed.data;
    if (code === "OPERATION_CONFLICT") kernelOperationErrors.push(parsed.data);
    // 内核随异常提供同一事务内读取的云端稿。
    const details = current
      ? {
          _current: attemptAnswerConflictCurrentSchema.parse({
            revision: current.revision,
            draft:
              current.choice === null
                ? null
                : { kind: "choice", index: Number(current.choice) },
          }),
        }
      : undefined;
    throw new HttpError(
      409,
      current ? "ANSWER_REVISION_CONFLICT" : code,
      "本题答案保存发生冲突",
      details,
    );
  }
};
const trial = createTrialApp(
  { ...options, db },
  (db, studentId, assignmentId) => {
    const assignment = requireAssignmentVisible(db, studentId, assignmentId);
    const publication = publicationForAssignment(db, assignment, studentId);
    const { input, revisions } = publication;
    assert.deepEqual(revisions, [
      { id: "m04-p0-q1", version: 1 },
      { id: "m04-p0-q2", version: 1 },
    ]);
    const questions = input.practice.questions.map((question, index) => ({
      ...question,
      version: revisions[index]?.version,
    }));
    runtime.publish({ ...input, practice: { ...input.practice, questions } });
    const receipt = runtime.start(owner(studentId), {
      protocolVersion: 1,
      practiceId: assignmentId,
      practiceVersion: 1,
      operationId: `open:${assignmentId}`,
    });
    const draft = draftForAssignment(
      assignment,
      studentId,
      receipt.activityId,
      receipt.startedAt,
    );
    if (!activitySteps.has(receipt.activityId)) {
      const { liveRows, teacherId, knowledgeByQuestion } =
        freezeInputsOfNewAttempt(db, draft);
      db.transaction((tx) => {
        tx.insert(attempts).values(draft).run();
        insertFrozenResponses(
          tx,
          draft.id,
          liveRows,
          knowledgeByQuestion,
          studentSelfReviewEnabledOf(db, teacherId),
        );
      });
      activitySteps.set(receipt.activityId, receipt.stepAttemptId);
    }
    return attemptSummaryOf(draft);
  },
  (studentId, activityId) => {
    boundActivity(db, studentId, activityId);
    return runtime.read(owner(studentId), activityId);
  },
  saveInKernel,
);
const old = createApp({ ...options, db: oldDb });
const draftHost = createApp({ ...options, db });
const frozen = z
  .object({
    questions: z.array(
      z.object({
        id: z.string(),
        version: z.number(),
        stemMd: z.string(),
        options: z.array(z.string()),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/P0-冻结单选.json", import.meta.url),
        "utf8",
      ),
    ),
  );

async function begin(app: TestApp, readApp: TestApp) {
  const world = await setupAssignment(app);
  const started = await postAssignment(
    app,
    world.assignmentId,
    world.ownerCookie,
  );
  assert.equal(started.status, 200);
  const attempt = attemptStartOkSchema.parse(await started.json()).data;
  const path = `/api/student/attempts/${attempt.id}`;
  const response = await readApp.request(path, {
    headers: { cookie: world.ownerCookie },
  });
  const detail = attemptDraftOkSchema.parse(await response.json()).data;
  const questions = detail.units.flatMap((unit) => unit.questions);
  assert.deepEqual(
    questions.map(({ id, questionVersion, stemMd, options }) => ({
      id,
      version: questionVersion,
      stemMd,
      options,
    })),
    frozen.questions,
  );
  assert.deepEqual(detail.drafts, {});
  assert.deepEqual(detail.draftRevisions, { "m04-p0-q1": 0, "m04-p0-q2": 0 });
  return { ...world, attempt, path, questions, app };
}
type World = Awaited<ReturnType<typeof begin>>;
type Body = {
  answer: { kind: "choice"; index: number } | null;
  baseRevision: number;
  mutationId: string;
  expectedFrozenAt?: string;
  questionRevisionId: string;
};
function wire(
  world: World,
  index: number,
  choice: number,
  baseRevision: number,
  mutationId = randomUUID(),
): Body {
  const question = world.questions[index];
  assert.ok(question);
  assert.ok(world.attempt.frozenAt);
  return {
    answer: { kind: "choice", index: choice },
    baseRevision,
    mutationId,
    expectedFrozenAt: world.attempt.frozenAt,
    questionRevisionId: question.questionRevisionId,
  };
}
async function put(
  world: World,
  index: number,
  body: Pick<Body, "answer"> & Partial<Omit<Body, "answer">>,
  status: number,
  target: { cookie?: string; path?: string; questionId?: string } = {},
) {
  const response = await world.app.request(
    `${target.path ?? world.path}/answers/${target.questionId ?? world.questions[index]?.id}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: target.cookie ?? world.ownerCookie,
      },
      body: JSON.stringify(body),
    },
  );
  const payload = (await response.json()) as {
    ok: boolean;
    data?: unknown;
    error?: string;
    _current?: unknown;
  };
  assert.equal(response.status, status, JSON.stringify(payload));
  assert.equal(payload.ok, status < 400);
  if (status >= 400) {
    assert.ok(!Object.hasOwn(payload, "data"));
    if (payload.error !== "ANSWER_REVISION_CONFLICT") {
      assert.ok(!Object.hasOwn(payload, "_current"));
    }
  }
  assert.doesNotMatch(
    JSON.stringify(payload),
    /"(answers|solutionMd|acceptedChoices|scoringKey)"\s*:/u,
  );
  return payload;
}
function draftFacts(db: Db, id: string) {
  return db.$client
    .prepare(
      "SELECT id, question_id, answer_json, answer_revision, change_count, auto_correct, final_correct FROM responses WHERE attempt_id = ? ORDER BY question_id",
    )
    .all(id);
}
async function candidateDetail(world: World) {
  const response = await trial.request(world.path, {
    headers: { cookie: world.ownerCookie },
  });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.doesNotMatch(
    JSON.stringify(body),
    /"(solutionMd|acceptedChoices|scoringKey)"\s*:/u,
  );
  return z
    .object({
      ok: z.literal(true),
      data: z.looseObject({
        activityId: z.literal(world.attempt.id),
        choiceDrafts: z
          .array(
            z.object({
              questionId: z.string(),
              questionVersion: z.number(),
              revision: z.number(),
              choice: z.string(),
              changeCount: z.number(),
            }),
          )
          .optional(),
      }),
    })
    .parse(body).data;
}

async function readProgress(world: World) {
  const headers = { cookie: world.ownerCookie };
  const detail = await world.app.request(world.path, { headers });
  const records = await world.app.request("/api/student/records", { headers });
  assert.equal(detail.status, 200);
  assert.equal(records.status, 200);
  const { data } = z
    .object({
      data: z.object({
        attempt: z
          .object({ phase: z.string().optional(), status: z.string() })
          .optional(),
        status: z.string().optional(),
      }),
    })
    .parse(await detail.json());
  return {
    phase: data.attempt?.phase ?? null,
    status: data.attempt?.status ?? data.status ?? null,
    records: studentRecordsOkSchema.parse(await records.json()).data.total,
  };
}

async function oldClientResponses() {
  const app = createApp({ ...options, db: legacyClientDb });
  const world = await begin(app, app);
  const noProof = { answer: { kind: "choice", index: 1 } } as const;
  const first = await put(world, 0, noProof, 200);
  const repeat = await put(world, 0, noProof, 200);
  assert.deepEqual(first.data, {
    questionId: "m04-p0-q1",
    revision: 1,
    changeCount: 1,
  });
  assert.deepEqual(repeat.data, {
    questionId: "m04-p0-q1",
    revision: 2,
    changeCount: 2,
  });
  const takeover = await put(world, 0, wire(world, 0, 1, 2), 200);
  assert.deepEqual(takeover, repeat);
  const afterTakeover = await put(world, 0, noProof, 409);
  assert.equal(afterTakeover.error, "ANSWER_REVISION_CONFLICT");
  assert.deepEqual(afterTakeover._current, {
    revision: 2,
    draft: noProof.answer,
  });
  return { first, repeat, takeover, afterTakeover };
}
async function removeOwner(world: World) {
  const response = await world.app.request(
    `/api/teacher/assignments/${world.assignmentId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: world.teacher },
      body: JSON.stringify({
        removeStudentIds: [world.studentId],
        confirmStarted: true,
      }),
    },
  );
  assert.equal(response.status, 200, await response.text());
}
function kernelFacts() {
  const inspection = new DatabaseSync(kernelPath, { readOnly: true });
  try {
    return Object.fromEntries(
      [
        "activities",
        "works",
        "work_versions",
        "choice_draft_operations",
        "submissions",
        "automatic_verdicts",
        "completions",
      ].map((table) => [
        table,
        inspection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      ]),
    );
  } finally {
    inspection.close();
  }
}

try {
  const candidate = await begin(trial, draftHost);
  const legacy = await begin(old, old);
  const frozenHost = draftFacts(db, candidate.attempt.id);
  const factsBefore = attemptFacts(db);
  assert.equal((await candidateDetail(candidate)).choiceDrafts, undefined);
  const legacyUnversioned = await oldClientResponses();
  const noProof = { answer: { kind: "choice", index: 1 } } as const;
  const unversionedFirst = await put(candidate, 0, noProof, 400);
  const unversionedRepeat = await put(candidate, 0, noProof, 400);
  assert.equal(unversionedFirst.error, "VALIDATION_ERROR");
  assert.deepEqual(unversionedRepeat, unversionedFirst);
  const progress: Record<string, unknown> = {};
  const differences: Record<string, unknown> = {};
  const operation = randomUUID();
  for (const [kind, world] of [
    ["legacy", legacy],
    ["kernel", candidate],
  ] as const) {
    const before = await readProgress(world);
    assert.deepEqual(
      before,
      kind === "legacy"
        ? { phase: "opened", status: "draft", records: 0 }
        : { phase: null, status: "active", records: 0 },
    );
    const first = wire(world, 0, 1, 0, operation);
    const saved = await put(world, 0, first, 200);
    assert.deepEqual(saved.data, {
      questionId: "m04-p0-q1",
      revision: 1,
      changeCount: 1,
    });
    const afterFirst = await readProgress(world);
    assert.deepEqual(
      afterFirst,
      kind === "legacy"
        ? { phase: "active", status: "draft", records: 1 }
        : before,
    );
    if (kind === "kernel") {
      assert.deepEqual(
        draftFacts(db, candidate.attempt.id),
        frozenHost,
        "试验 PUT 误走旧写入",
      );
      assert.deepEqual((await candidateDetail(candidate)).choiceDrafts, [
        {
          questionId: "m04-p0-q1",
          questionVersion: 1,
          revision: 1,
          choice: "1",
          changeCount: 1,
        },
      ]);
    }
    assert.deepEqual(await put(world, 0, first, 200), saved);
    const reused = await put(
      world,
      0,
      { ...first, answer: { kind: "choice", index: 2 } },
      409,
    );
    const expectOperationCurrent =
      kind === "legacy" || hasAtomicOperationCurrent;
    assert.equal(
      reused.error,
      expectOperationCurrent
        ? "ANSWER_REVISION_CONFLICT"
        : "OPERATION_CONFLICT",
    );
    assert.deepEqual(
      reused._current,
      expectOperationCurrent
        ? { revision: 1, draft: { kind: "choice", index: 1 } }
        : undefined,
    );
    assert.deepEqual(await put(world, 0, wire(world, 0, 1, 0), 200), saved);
    assert.deepEqual((await put(world, 1, wire(world, 1, 0, 0), 200)).data, {
      questionId: "m04-p0-q2",
      revision: 1,
      changeCount: 1,
    });
    if (kind === "kernel") {
      assert.deepEqual(
        (await candidateDetail(candidate)).choiceDrafts?.map(
          ({ choice }) => choice,
        ),
        ["1", "0"],
      );
    }
    assert.deepEqual((await put(world, 0, wire(world, 0, 2, 1), 200)).data, {
      questionId: "m04-p0-q1",
      revision: 2,
      changeCount: 2,
    });
    const reusedAfterLaterSave = await put(
      world,
      0,
      { ...first, answer: { kind: "choice", index: 0 } },
      409,
    );
    assert.equal(reusedAfterLaterSave.error, reused.error);
    assert.deepEqual(
      reusedAfterLaterSave._current,
      expectOperationCurrent
        ? { revision: 2, draft: { kind: "choice", index: 2 } }
        : undefined,
    );
    differences[kind] = { reusedOperation: reused, reusedAfterLaterSave };
    const stale = await put(world, 0, wire(world, 0, 0, 1), 409);
    assert.equal(stale.error, "ANSWER_REVISION_CONFLICT");
    assert.deepEqual(stale._current, {
      revision: 2,
      draft: { kind: "choice", index: 2 },
    });
    const afterConflict = await readProgress(world);
    assert.deepEqual(afterConflict, afterFirst);
    progress[kind] = { before, afterFirst, afterConflict };
    assert.equal(
      (
        await put(
          world,
          0,
          {
            ...first,
            questionRevisionId: world.questions[1]?.questionRevisionId ?? "",
          },
          409,
        )
      ).error,
      "QUESTION_REVISION_STALE",
    );
    assert.equal(
      (
        await put(
          world,
          0,
          {
            ...wire(world, 0, 0, 2),
            expectedFrozenAt: "2020-01-01T00:00:00.000Z",
          },
          409,
        )
      ).error,
      "ATTEMPT_SNAPSHOT_CHANGED",
    );
    assert.equal(
      (
        await put(world, 0, wire(world, 0, 0, 2), 404, {
          path: `/api/student/attempts/${randomUUID()}`,
        })
      ).error,
      "ATTEMPT_NOT_FOUND",
    );
    assert.equal(
      (
        await put(world, 0, wire(world, 0, 0, 2), 404, {
          questionId: "other-question",
        })
      ).error,
      "QUESTION_NOT_FOUND",
    );
    assert.equal(
      (
        await put(world, 0, first, 403, {
          cookie: world.otherCookie,
        })
      ).error,
      "FORBIDDEN",
    );
    assert.equal(
      (await put(world, 0, { ...wire(world, 0, 0, 2), answer: null }, 400))
        .error,
      "VALIDATION_ERROR",
    );
  }
  const unversionedAfterTakeover = await put(candidate, 0, noProof, 400);
  assert.deepEqual(unversionedAfterTakeover, unversionedFirst);
  const { choiceDrafts } = await candidateDetail(candidate);
  assert.deepEqual(choiceDrafts, [
    {
      questionId: "m04-p0-q1",
      questionVersion: 1,
      revision: 2,
      choice: "2",
      changeCount: 2,
    },
    {
      questionId: "m04-p0-q2",
      questionVersion: 1,
      revision: 1,
      choice: "0",
      changeCount: 1,
    },
  ]);
  await removeOwner(candidate);
  await removeOwner(legacy);
  const candidateAfterRemoval = await put(
    candidate,
    0,
    wire(candidate, 0, 0, 2),
    200,
  );
  const legacyAfterRemoval = await put(legacy, 0, wire(legacy, 0, 0, 2), 200);
  assert.deepEqual(candidateAfterRemoval, legacyAfterRemoval);
  assert.deepEqual(legacyAfterRemoval.data, {
    questionId: "m04-p0-q1",
    revision: 3,
    changeCount: 3,
  });
  assert.deepEqual((await candidateDetail(candidate)).choiceDrafts?.[0], {
    questionId: "m04-p0-q1",
    questionVersion: 1,
    revision: 3,
    choice: "0",
    changeCount: 3,
  });
  const retainedLegacy = await legacy.app.request(legacy.path, {
    headers: { cookie: legacy.ownerCookie },
  });
  assert.equal(retainedLegacy.status, 200);
  const legacyDraft = attemptDraftOkSchema.parse(
    await retainedLegacy.json(),
  ).data;
  assert.deepEqual(legacyDraft.drafts["m04-p0-q1"], {
    kind: "choice",
    index: 0,
  });
  for (const world of [legacy, candidate]) {
    const noNewAttempt = await postAssignment(
      world.app,
      world.assignmentId,
      world.ownerCookie,
    );
    assert.equal(noNewAttempt.status, 403);
    await assertDetailDenial(world, world.otherCookie, 403);
    await verifyInactiveOwnerCookies(world.app, world, async (cookie) => {
      await assertDetailDenial(world, cookie, 401);
      const rejected = await put(world, 0, wire(world, 0, 1, 3), 401, {
        cookie,
      });
      assert.equal(rejected.error, "UNAUTHORIZED");
      assert.ok(
        !Object.hasOwn(rejected, "data") &&
          !Object.hasOwn(rejected, "_current"),
      );
    });
  }
  assert.deepEqual(attemptFacts(db), factsBefore);
  assert.deepEqual(draftFacts(db, candidate.attempt.id), frozenHost);
  const persisted = kernelFacts();
  assert.deepEqual(
    kernelOperationErrors,
    [1, 2].map((revision) => ({
      status: 409,
      code: "OPERATION_CONFLICT",
      ...(hasAtomicOperationCurrent
        ? { current: { revision, choice: String(revision) } }
        : {}),
    })),
  );
  assert.deepEqual(persisted, {
    activities: 1,
    works: 2,
    work_versions: 4,
    choice_draft_operations: 5,
    submissions: 0,
    automatic_verdicts: 0,
    completions: 0,
  });
  console.log(
    JSON.stringify(
      {
        sha,
        entry,
        kernelPath,
        differences,
        kernelOperationErrors,
        oldClientWithoutProof: {
          legacy: legacyUnversioned,
          kernel: {
            first: unversionedFirst,
            repeat: unversionedRepeat,
            afterTakeover: unversionedAfterTakeover,
          },
        },
        progress,
        rosterRemoval: {
          kernel: candidateAfterRemoval,
          legacy: legacyAfterRemoval,
        },
        getAfterRosterRemoval: 200,
        startAfterRosterRemoval: 403,
        readAndSaveAfterLogout: 401,
        readAndSaveAfterArchive: 401,
        choiceDrafts,
        productFacts: attemptFacts(db),
        productResponses: frozenHost,
        kernelFacts: persisted,
      },
      null,
      2,
    ),
  );
} finally {
  runtime.close();
  db.$client.close();
  oldDb.$client.close();
  legacyClientDb.$client.close();
}

async function assertDetailDenial(
  world: World,
  cookie: string,
  status: number,
) {
  const response = await world.app.request(world.path, { headers: { cookie } });
  assert.equal(response.status, status);
  const body = z
    .strictObject({
      ok: z.literal(false),
      error: z.literal(status === 401 ? "UNAUTHORIZED" : "FORBIDDEN"),
      message: z.string(),
    })
    .parse(await response.json());
  assert.ok(!Object.hasOwn(body, "data") && !Object.hasOwn(body, "_current"));
}
