import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { attemptStartOkSchema } from "@tutor/contract";
import { stemMdLeaksAnswers } from "@tutor/md-dsl";
import { openLearningRuntime as openInstalledRuntime } from "learning-kernel";
import pino from "pino";
import { z } from "zod";
import serverPackage from "../../../package.json" with { type: "json" };
import { createDb } from "../../db/client.ts";
import { createTestDb, createTestDir } from "../../db/test-utils.ts";
import { HttpError } from "../../lib/http-error.ts";
import { requireAssignmentVisible } from "../../services/attempt-access.ts";
import { withAllowRedo } from "../../services/attempt-redo-policy.ts";
import { attemptSummaryOf } from "../../services/attempt-summary.ts";
import { createTrialApp } from "./assembly.ts";
import {
  attemptFacts,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";
import { draftForAssignment, publicationForAssignment } from "./publication.ts";

function sha256(archive: string | URL) {
  return createHash("sha256").update(readFileSync(archive)).digest("hex");
}

async function selectRuntime(args: string[]) {
  if (args.length === 0) {
    const dependency = serverPackage.dependencies["learning-kernel"];
    const match = /^file:(vendor\/learning-kernel-([0-9a-f]{64})\.tgz)$/u.exec(
      dependency,
    );
    assert.ok(match?.[1] && match[2], "内核依赖必须按内容寻址");
    const candidateHash = sha256(
      new URL(`../../../${match[1]}`, import.meta.url),
    );
    assert.equal(candidateHash, match[2], "内核归档哈希不匹配");
    return {
      candidateHash,
      candidateEntry: import.meta.resolve("learning-kernel"),
      blocked: false,
      openLearningRuntime: openInstalledRuntime,
    };
  }

  const [flag, candidatePath] = args;
  assert.ok(
    args.length === 2 && flag === "--historical-k1" && candidatePath,
    "用法：probe.ts [--historical-k1 <已离线安装 K1 的目录>]",
  );
  const candidateRoot = realpathSync(candidatePath);
  const candidateHash = sha256(
    join(candidateRoot, "learning-kernel-0.1.0.tgz"),
  );
  assert.equal(
    candidateHash,
    "4f24ba26cda0f0b2688cbd8057189186f55bc88e783470346acc4f20df4937b8",
  );
  assert.equal(
    sha256(join(candidateRoot, "zod-4.6.5.tgz")),
    "8015321552bb45f46999a161ae91317b6a46c54f42e92effae74f1db6aabbc04",
  );
  const candidateEntry = realpathSync(
    createRequire(join(candidateRoot, "package.json")).resolve(
      "learning-kernel",
    ),
  );
  const candidateRelativeEntry = relative(candidateRoot, candidateEntry);
  assert.ok(
    !candidateRelativeEntry.startsWith("..") &&
      !isAbsolute(candidateRelativeEntry),
  );
  const { openLearningRuntime } = (await import(
    pathToFileURL(candidateEntry).href
  )) as Pick<typeof import("learning-kernel"), "openLearningRuntime">;
  return { candidateHash, candidateEntry, blocked: true, openLearningRuntime };
}

const { candidateHash, candidateEntry, blocked, openLearningRuntime } =
  await selectRuntime(process.argv.slice(2));
const receiptSchema = z.object({
  activityId: z.uuid(),
  stepAttemptId: z.uuid(),
  startedAt: z.iso.datetime(),
});

const expected = z
  .object({
    questions: z.array(
      z.object({
        id: z.string(),
        version: z.number(),
        stemMd: z.string(),
        options: z.array(z.string()),
        answers: z.object({ kind: z.literal("choice"), index: z.number() }),
        solutionMd: z.string(),
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
const publicQuestions = expected.questions.map(({ id, stemMd, options }) => ({
  id,
  prompt: stemMd,
  options: Object.fromEntries(
    options.map((text, index) => [String(index), text]),
  ),
}));
const dataDir = createTestDir();
const productDatabase = join(dataDir, "ownclass.sqlite");
const kernelDatabase = join(dataDir, "learning-kernel.sqlite");
const template = createTestDb();
writeFileSync(productDatabase, template.$client.serialize());
template.$client.close();
const db = createDb(productDatabase);
let runtime = openLearningRuntime({ databasePath: kernelDatabase });

const productZero = {
  attempts: 0,
  responses: 0,
  scores: 0,
  evidence: 0,
  settlements: 0,
};
const assignmentByActivity = new Map<string, string>();
const receipts: z.infer<typeof receiptSchema>[] = [];
let publishInput: ReturnType<typeof publicationForAssignment> | undefined;
let publishError: unknown;
let kernelReadDenials = 0;
const trial = createTrialApp(
  {
    db,
    dataDir,
    logger: pino({ enabled: false }),
    publicUrl: "http://localhost:8787",
    isProduction: false,
  },
  (productDb, studentId, assignmentId, options = {}) => {
    const assignment = requireAssignmentVisible(
      productDb,
      studentId,
      assignmentId,
    );
    if (
      assignment.answerRelease !== "on_submit" ||
      assignment.allowPerQuestionFeedback ||
      assignment.allowRedo ||
      options.redo ||
      options.timeLimitMinutes !== undefined ||
      options.feedbackMode === "per_question"
    ) {
      throw new HttpError(
        422,
        "M04_PRACTICE_INELIGIBLE",
        "仅支持不限时、整卷确认的普通单选作业",
      );
    }

    // 本次隔离只验证一份固定作业。作业版本与活动的持久绑定在 P2 验证。
    publishInput ??= publicationForAssignment(productDb, assignment, studentId);
    assert.equal(publishInput.input.practice.id, assignmentId);
    try {
      runtime.publish(publishInput.input);
    } catch (error) {
      publishError = error;
      throw new HttpError(
        500,
        "M04_PUBLISH_REJECTED",
        "学习运行时未能发布这份作业",
      );
    }
    const receipt = receiptSchema.parse(
      runtime.start(
        { role: "student", id: studentId },
        {
          protocolVersion: 1,
          operationId: `open:${assignmentId}`,
          practiceId: publishInput.input.practice.id,
          practiceVersion: publishInput.input.practice.version,
        },
      ),
    );
    receipts.push(receipt);
    assignmentByActivity.set(receipt.activityId, assignmentId);
    return withAllowRedo(
      attemptSummaryOf(
        draftForAssignment(
          assignment,
          studentId,
          receipt.activityId,
          receipt.startedAt,
        ),
      ),
      assignment.allowRedo,
    );
  },
  (studentId, activityId) => {
    const assignmentId = assignmentByActivity.get(activityId);
    if (!assignmentId)
      throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
    requireAssignmentVisible(db, studentId, assignmentId);
    try {
      return runtime.read({ role: "student", id: studentId }, activityId);
    } catch (error) {
      if (
        !z
          .object({ status: z.literal(403), code: z.literal("FORBIDDEN") })
          .safeParse(error).success
      )
        throw error;
      kernelReadDenials++;
      throw new HttpError(403, "FORBIDDEN", "无权读取此作答");
    }
  },
);

function assertPublic(body: unknown) {
  const text = JSON.stringify(body);
  for (const question of expected.questions)
    assert.ok(!text.includes(question.solutionMd));
  function inspect(value: unknown, path: string) {
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (childPath !== "$.data.step.submit.slots.answers") {
        assert.doesNotMatch(
          key,
          /^(scoringKey|acceptedChoices|grading|answer|answers|solution\w*|sourceMd|passwordHash|linkToken)$/u,
          childPath,
        );
      }
      inspect(child, childPath);
    }
  }
  inspect(body, "$");
}

async function checkResponse(response: Response, status: number) {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assertPublic(body);
  return body;
}

function inspectKernel() {
  const inspection = new DatabaseSync(kernelDatabase, { readOnly: true });
  try {
    const tables = [
      "materials",
      "practices",
      "scoring_keys",
      "activities",
      "step_attempts",
      "works",
      "work_versions",
      "submissions",
      "completions",
      "automatic_verdicts",
    ];
    const counts = Object.fromEntries(
      tables.map((table) => [
        table,
        inspection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      ]),
    );
    const activities = inspection
      .prepare(
        "SELECT id, student_id, practice_id, practice_version, start_operation_id, started_at FROM activities",
      )
      .all()
      .map((row) => ({ ...row }));
    return { counts, activities };
  } finally {
    inspection.close();
  }
}

try {
  const {
    assignmentId,
    ownerCookie,
    otherCookie,
    studentId,
    otherStudentId,
    teacher,
  } = await setupAssignment(trial);
  for (const [cookie, status, error] of [
    [undefined, 401, "UNAUTHORIZED"],
    [teacher, 401, "UNAUTHORIZED"],
    [otherCookie, 403, "FORBIDDEN"],
  ] as const) {
    const body = await checkResponse(
      await postAssignment(trial, assignmentId, cookie),
      status,
    );
    assert.equal(z.object({ error: z.string() }).parse(body).error, error);
    assert.ok(!Object.hasOwn(body as object, "data"));
  }
  assert.equal(publishInput, undefined);
  assert.deepEqual(attemptFacts(db), productZero);
  const first = await checkResponse(
    await postAssignment(trial, assignmentId, ownerCookie),
    blocked ? 500 : 200,
  );
  assert.ok(publishInput);
  const publication = publishInput as ReturnType<
    typeof publicationForAssignment
  >;
  assert.deepEqual(
    publication.revisions,
    expected.questions.map(({ id, version }) => ({ id, version })),
  );
  assert.deepEqual(publication.input.practice.questions, publicQuestions);
  assert.ok(
    publication.input.practice.questions.every(
      ({ prompt }) => !stemMdLeaksAnswers(prompt),
    ),
  );
  assert.deepEqual(
    publication.input.scoringKey.acceptedChoices,
    Object.fromEntries(
      expected.questions.map(({ id, answers }) => [id, String(answers.index)]),
    ),
  );
  assert.equal(Object.hasOwn(publication.input, "material"), false);
  assert.equal(Object.hasOwn(publication.input.practice, "material"), false);

  let outcome: Record<string, unknown>;
  if (blocked) {
    assert.deepEqual(first, {
      ok: false,
      error: "M04_PUBLISH_REJECTED",
      message: "学习运行时未能发布这份作业",
    });
    const { issues } = z
      .object({
        name: z.literal("ZodError"),
        issues: z.array(
          z.object({
            code: z.string(),
            expected: z.string(),
            path: z.array(z.string()),
          }),
        ),
      })
      .parse(publishError);
    assert.deepEqual(issues, [
      { code: "invalid_type", expected: "object", path: ["material"] },
      {
        code: "invalid_type",
        expected: "object",
        path: ["practice", "material"],
      },
    ]);
    assert.deepEqual(receipts, []);
    outcome = { start: 500, issues };
  } else {
    assert.equal(publishError, undefined);
    const summary = attemptStartOkSchema.parse(first).data;
    const second = await checkResponse(
      await postAssignment(trial, assignmentId, ownerCookie),
      200,
    );
    assert.deepEqual(second, first);
    assert.ok(receipts[0]);
    assert.equal(receipts.length, 2);
    assert.deepEqual(receipts[1], receipts[0]);
    assert.equal(summary.id, receipts[0].activityId);
    assert.equal(summary.startedAt, receipts[0].startedAt);
    assert.equal(summary.phase, "opened");

    const detailUrl = `/api/student/attempts/${summary.id}`;
    const owner = await trial.request(detailUrl, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(owner.headers.get("Cache-Control"), "private, no-store");
    const ownerBody = await checkResponse(owner, 200);
    const detail = z
      .object({
        ok: z.literal(true),
        data: receiptSchema.extend({
          status: z.literal("active"),
          inputs: z.object({
            questions: z.object({
              from: z.literal("questions"),
              questions: z.unknown(),
            }),
          }),
        }),
      })
      .parse(ownerBody).data;
    assert.equal(detail.activityId, receipts[0].activityId);
    assert.equal(detail.stepAttemptId, receipts[0].stepAttemptId);
    assert.equal(detail.startedAt, receipts[0].startedAt);
    assert.deepEqual(detail.inputs.questions.questions, publicQuestions);
    assert.ok(!Object.hasOwn((ownerBody as { data: object }).data, "material"));
    assert.ok(
      !Object.hasOwn((ownerBody as { data: object }).data, "submission"),
    );
    const otherBody = await checkResponse(
      await trial.request(detailUrl, { headers: { cookie: otherCookie } }),
      403,
    );
    assert.equal(
      z.object({ error: z.string() }).parse(otherBody).error,
      "FORBIDDEN",
    );
    assert.ok(!Object.hasOwn(otherBody as object, "data"));
    assert.equal(kernelReadDenials, 0);

    runtime.close();
    runtime = openLearningRuntime({ databasePath: kernelDatabase });
    const reopened = await checkResponse(
      await trial.request(detailUrl, { headers: { cookie: ownerCookie } }),
      200,
    );
    assert.deepEqual(reopened, ownerBody);
    async function updateRoster(
      change: { addStudentIds: string[] } | { removeStudentIds: string[] },
    ) {
      const result = await trial.request(
        `/api/teacher/assignments/${assignmentId}`,
        {
          method: "PATCH",
          headers: { cookie: teacher, "content-type": "application/json" },
          body: JSON.stringify(change),
        },
      );
      assert.equal(result.status, 200, await result.text());
    }
    await updateRoster({ addStudentIds: [otherStudentId] });
    const otherMember = await checkResponse(
      await trial.request(detailUrl, { headers: { cookie: otherCookie } }),
      403,
    );
    assert.deepEqual(otherMember, {
      ok: false,
      error: "FORBIDDEN",
      message: "无权读取此作答",
    });
    assert.equal(kernelReadDenials, 1);
    await updateRoster({ removeStudentIds: [studentId] });
    const revoked = await checkResponse(
      await trial.request(detailUrl, { headers: { cookie: ownerCookie } }),
      403,
    );
    assert.equal(
      z.object({ error: z.string() }).parse(revoked).error,
      "FORBIDDEN",
    );
    assert.ok(!Object.hasOwn(revoked as object, "data"));
    assert.equal(kernelReadDenials, 1);
    outcome = {
      start: 200,
      repeat: 200,
      ownerRead: 200,
      otherRead: 403,
      otherMemberRead: 403,
      readAfterRosterRemoval: 403,
      readAfterKernelReopen: 200,
      receipt: receipts[0],
    };
  }

  const kernelFacts = inspectKernel();
  assert.deepEqual(attemptFacts(db), productZero);
  const recorded = Number(!blocked);
  assert.deepEqual(kernelFacts.counts, {
    materials: 0,
    practices: recorded,
    scoring_keys: recorded,
    activities: recorded,
    step_attempts: recorded,
    works: 0,
    work_versions: 0,
    submissions: 0,
    completions: 0,
    automatic_verdicts: 0,
  });
  assert.deepEqual(
    kernelFacts.activities,
    receipts[0]
      ? [
          {
            id: receipts[0].activityId,
            student_id: studentId,
            practice_id: assignmentId,
            practice_version: 1,
            start_operation_id: `open:${assignmentId}`,
            started_at: receipts[0].startedAt,
          },
        ]
      : [],
  );
  const methods = Object.keys(runtime);
  console.log(
    JSON.stringify(
      {
        candidateHash,
        candidateEntry,
        methods,
        productDatabase,
        kernelDatabase,
        outcome,
        assignmentId,
        revisions: publication.revisions,
        productFacts: attemptFacts(db),
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
