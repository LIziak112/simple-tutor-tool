import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  aiAttemptReviewCreateOkSchema,
  aiAttemptReviewDetailOkSchema,
  aiAttemptReviewListOkSchema,
  aiAttemptReviewMcpClaimViewSchema,
  aiAttemptReviewPreviewOkSchema,
  aiAttemptReviewTaskPublicSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
} from "@tutor/contract";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import {
  callToolJson,
  connectMcpClientViaApp,
} from "../test/mcp-test-utils.ts";
import { fetchSubmitRevisions } from "../test/submit-revisions.ts";

const route = "/api/student/ai/attempt-reviews";
const connections = "/api/student/ai/connections";
const logger = pino({ enabled: false });
const resources: Array<() => void> = [];

afterEach(() => {
  for (const close of resources.splice(0).reverse()) close();
});

async function expectStatus(response: Response, status: number) {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as unknown;
}

async function expectDenied(response: Response, status: number, error: string) {
  const body = await expectStatus(response, status);
  expect(body).toMatchObject({ ok: false, error });
  expect(body).not.toHaveProperty("data");
  assertNoLeak(body);
}

async function world(
  backend: "legacy" | "kernel",
  mode: "confirmed" | "interrupt" | "draft" = "confirmed",
) {
  const dataDir = createTestDir();
  resources.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const file = join(dataDir, "product.sqlite");
  const seed = createTestDb();
  try {
    writeFileSync(file, seed.$client.serialize());
  } finally {
    seed.$client.close();
  }
  let db = createDb(file);
  resources.push(() => db.$client.close());
  const openApp = () =>
    createApp({
      db,
      dataDir,
      kernelAssignmentCreationEnabled: true,
      isProduction: false,
      logger,
      publicUrl: "http://localhost:8787",
    });
  let app = openApp();
  const { ownerCookie, otherCookie, teacher, ...fixture } =
    await setupAssignment(app);
  const assignmentId =
    backend === "legacy"
      ? fixture.assignmentId
      : await assignKernelFixture(app, {
          ownerCookie,
          otherCookie,
          teacher,
          ...fixture,
        });
  const call = (
    path: string,
    method = "GET",
    body?: object,
    cookie = ownerCookie,
  ) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const start = attemptStartOkSchema.parse(
    await expectStatus(
      await postAssignment(app, assignmentId, ownerCookie),
      200,
    ),
  ).data;
  const attempt = `/api/student/attempts/${start.id}`;
  const revisions = () => fetchSubmitRevisions(app, ownerCookie, start.id);
  const frozen = await revisions();
  expect(frozen.map((item) => item.questionId)).toEqual([
    "m04-p0-q1",
    "m04-p0-q2",
  ]);
  for (const question of frozen) {
    await expectStatus(
      await call(`${attempt}/answers/${question.questionId}`, "PUT", {
        answer: { kind: "choice", index: 1 },
        mutationId: randomUUID(),
        baseRevision: question.expectedAnswerRevision,
        expectedFrozenAt: start.frozenAt,
        questionRevisionId: question.questionRevisionId,
      }),
      200,
    );
  }
  if (mode !== "draft") {
    if (mode === "interrupt") {
      db.$client.exec(`
        CREATE TRIGGER interrupt_ai_review_projection BEFORE UPDATE OF status ON attempts
        WHEN NEW.status = 'graded'
        BEGIN SELECT RAISE(ABORT, 'interrupted AI review projection'); END
      `);
    }
    try {
      const submitted = await call(`${attempt}/submit`, "POST", {
        revisions: await revisions(),
      });
      const result = await expectStatus(
        submitted,
        mode === "interrupt" ? 500 : 200,
      );
      if (mode === "confirmed")
        expect(attemptResultOkSchema.parse(result).data.attempt.scoreAuto).toBe(
          50,
        );
    } finally {
      if (mode === "interrupt")
        db.$client.exec("DROP TRIGGER interrupt_ai_review_projection");
    }
  }
  if (backend === "kernel") {
    expect(
      db.$client
        .prepare(
          "SELECT answer_json, final_correct FROM responses WHERE attempt_id = ?",
        )
        .all(start.id),
    ).toEqual(
      Array.from({ length: 2 }, () => ({
        answer_json: null,
        final_correct: null,
      })),
    );
  }

  async function newConnection(cookie: string) {
    const body = (await expectStatus(
      await call(connections, "POST", { channel: "mcp" }, cookie),
      201,
    )) as {
      data: { connection: { id: string }; credential: { token: string } };
    };
    return { id: body.data.connection.id, token: body.data.credential.token };
  }
  const owner = await newConnection(ownerCookie);
  return {
    dataDir,
    assignmentId,
    start,
    frozen,
    owner,
    teacher,
    ownerCookie,
    otherCookie,
    call,
    newConnection,
    get db() {
      return db;
    },
    restart() {
      db.$client.close();
      db = createDb(file);
      app = openApp();
    },
    connect(token = owner.token) {
      return connectMcpClientViaApp(
        app,
        "/mcp/student",
        token,
        "m04-attempt-review",
      );
    },
  };
}

async function createReview(env: Awaited<ReturnType<typeof world>>) {
  const attemptId = env.start.id;
  const preview = aiAttemptReviewPreviewOkSchema.parse(
    await expectStatus(
      await env.call(`${route}/preview?attemptId=${attemptId}`),
      200,
    ),
  ).data;
  const body = {
    attemptId,
    mutationId: randomUUID(),
    expectedPreviewVersion: preview.opaquePreviewVersion,
    purpose: "复盘两道合成单选",
    channel: "mcp",
  };
  const created = aiAttemptReviewCreateOkSchema.parse(
    await expectStatus(await env.call(route, "POST", body), 201),
  ).data;
  expect(created.created).toBe(true);
  const replay = aiAttemptReviewCreateOkSchema.parse(
    await expectStatus(await env.call(route, "POST", body), 200),
  ).data;
  expect(replay).toMatchObject({
    created: false,
    task: { id: created.task.id },
  });
  return { preview, taskId: created.task.id, body };
}

function reportOf(
  taskId: string,
  view: ReturnType<typeof aiAttemptReviewMcpClaimViewSchema.parse>,
) {
  return {
    taskId,
    leaseToken: view.lease.leaseToken,
    generation: view.generation,
    snapshotVersion: view.snapshotVersion,
    report: {
      schemaVersion: 1,
      overview: "合成复盘记录",
      knowledgeFindings: [],
      errorPatterns: [],
      performanceNotes: [],
      trainingPlan: [],
      limitations: [],
    },
  };
}

it.each(["legacy", "kernel"] as const)(
  "%s 经正常 HTTP 同意后，SDK 领取并交付相同的两题作答快照",
  async (backend) => {
    const env = await world(backend);
    env.restart();
    const { preview, taskId } = await createReview(env);
    const expectedCounts = {
      total: 2,
      correctCount: 1,
      incorrectCount: 1,
      unansweredCount: 0,
      pendingCount: 0,
      unknownAnswerCount: 0,
      hasAnswerCount: 2,
      missingAnswerCount: 0,
      gradedCount: 2,
      accuracyAmongGraded: 0.5,
    };
    expect.soft(preview.counts).toEqual(expectedCounts);
    env.restart();

    const client = await env.connect();
    try {
      const claimed = await callToolJson(client, "claim_attempt_review", {
        taskId,
      });
      expect(claimed.isError).toBe(false);
      const { claimed: success, ...payload } = claimed.data;
      expect(success).toBe(true);
      const view = aiAttemptReviewMcpClaimViewSchema.parse(payload);
      expect(view.snapshotVersion).toBe(preview.opaquePreviewVersion);
      expect.soft(view.snapshot.counts).toEqual(expectedCounts);
      expect.soft(view.snapshot.questions).toMatchObject(
        env.frozen.map(({ questionId, questionRevisionId }, index) => ({
          questionNo: index + 1,
          questionId,
          questionRevisionId,
          studentAnswerText: index === 0 ? "B（5）" : "B（6）",
          referenceAnswerMd: index === 0 ? "B" : "C",
          solutionMd: expect.stringContaining(
            index === 0 ? "合成详解甲" : "合成详解乙",
          ),
          answerState: "answered",
          gradingState: index === 0 ? "correct" : "incorrect",
          displayStatus: index === 0 ? "correct" : "incorrect",
        })),
      );
      assertNoLeak(claimed.data, {
        allow: ["solutionMd"],
        forbid: ["scoringKey", "keyRef", "acceptedChoice", "evaluation"],
      });
      const repeated = await callToolJson(client, "claim_attempt_review", {
        taskId,
      });
      expect(repeated).toMatchObject({
        isError: true,
        data: { error: "AI_STATE_CONFLICT" },
      });
      expect(repeated.data).not.toHaveProperty("snapshot");

      const report = reportOf(taskId, view);
      expect(
        await callToolJson(client, "submit_attempt_review_result", report),
      ).toMatchObject({
        isError: false,
        data: { submitted: true, duplicate: false },
      });
      expect(
        await callToolJson(client, "submit_attempt_review_result", report),
      ).toMatchObject({
        isError: false,
        data: { submitted: true, duplicate: true },
      });
    } finally {
      await client.close();
    }
    env.restart();

    const detail = async () =>
      aiAttemptReviewDetailOkSchema.parse(
        await expectStatus(await env.call(`${route}/${taskId}`), 200),
      ).data;
    expect(await detail()).toMatchObject({
      task: { status: "replied" },
      result: { overview: "合成复盘记录" },
    });
    await expectStatus(
      await env.call(`${route}/${taskId}/actions`, "POST", {
        action: "archive",
      }),
      200,
    );
    const list = aiAttemptReviewListOkSchema.parse(
      await expectStatus(await env.call(`${route}?archived=exclude`), 200),
    ).data;
    expect(list.tasks).toEqual([]);
    expect(await detail()).toMatchObject({
      task: { status: "replied", archivedAt: expect.any(String) },
    });
    await expectDenied(
      await env.call(`${route}/${taskId}`, "GET", undefined, env.otherCookie),
      404,
      "NOT_FOUND",
    );
  },
);

it("没有本人同意和当前公布授权就无法领取或交付内核整卷复盘", async () => {
  const env = await world("kernel");
  const other = await env.newConnection(env.otherCookie);
  const previewPath = `${route}/preview?attemptId=${env.start.id}`;
  await expectDenied(
    await env.call(previewPath, "GET", undefined, env.otherCookie),
    403,
    "FORBIDDEN",
  );
  const { taskId } = await createReview(env);
  const client = await env.connect();
  const otherClient = await env.connect(other.token);
  try {
    const denied = await callToolJson(otherClient, "claim_attempt_review", {
      taskId,
    });
    expect(denied).toMatchObject({
      isError: true,
      data: { error: "NOT_FOUND" },
    });
    expect(denied.data).not.toHaveProperty("snapshot");
    const claim = await callToolJson(client, "claim_attempt_review", {
      taskId,
    });
    expect(claim.isError).toBe(false);
    const { claimed, ...payload } = claim.data;
    expect(claimed).toBe(true);
    const view = aiAttemptReviewMcpClaimViewSchema.parse(payload);
    const body = reportOf(taskId, view);
    const assignment = `/api/teacher/assignments/${env.assignmentId}`;
    await expectStatus(
      await env.call(
        assignment,
        "PATCH",
        { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00.000Z" },
        env.teacher,
      ),
      200,
    );
    await expectDenied(
      await env.call(previewPath),
      409,
      "AI_ATTEMPT_REVIEW_NOT_RELEASED",
    );
    await expectDenied(
      await env.call(`${route}/${taskId}`),
      409,
      "AI_ATTEMPT_REVIEW_NOT_RELEASED",
    );
    const deniedReport = await callToolJson(
      client,
      "submit_attempt_review_result",
      body,
    );
    expect(deniedReport).toMatchObject({
      isError: true,
      data: { error: "AI_ATTEMPT_REVIEW_NOT_RELEASED" },
    });
    expect(deniedReport.data).not.toHaveProperty("report");
    expect(
      env.db.$client
        .prepare(
          "SELECT COUNT(*) AS n FROM ai_attempt_review_results WHERE task_id = ?",
        )
        .get(taskId),
    ).toEqual({ n: 0 });

    await expectStatus(
      await env.call(
        assignment,
        "PATCH",
        { answerRelease: "on_submit" },
        env.teacher,
      ),
      200,
    );
    await expectStatus(
      await env.call(`${route}/${taskId}/actions`, "POST", {
        action: "cancel",
      }),
      200,
    );
    const late = await callToolJson(
      client,
      "submit_attempt_review_result",
      body,
    );
    expect(late.isError).toBe(true);
    expect(late.data).not.toHaveProperty("report");
    expect(
      env.db.$client
        .prepare(
          "SELECT COUNT(*) AS n FROM ai_attempt_review_results WHERE task_id = ?",
        )
        .get(taskId),
    ).toEqual({ n: 0 });

    await expectStatus(
      await env.call(`${connections}/${env.owner.id}`, "DELETE"),
      200,
    );
    await expect(env.connect()).rejects.toMatchObject({
      code: 401,
      message: expect.stringContaining("UNAUTHORIZED"),
    });
  } finally {
    await otherClient.close();
    await client.close();
  }
});

it("领取前撤回公布会暂停，重新公布后可按原授权快照领取", async () => {
  const env = await world("kernel");
  const client = await env.connect();
  try {
    expect(
      await callToolJson(client, "claim_attempt_review", {}),
    ).toMatchObject({
      isError: false,
      data: { claimed: false },
    });
    const { taskId, preview } = await createReview(env);
    const assignment = `/api/teacher/assignments/${env.assignmentId}`;
    await expectStatus(
      await env.call(
        assignment,
        "PATCH",
        { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00.000Z" },
        env.teacher,
      ),
      200,
    );
    const denied = await callToolJson(client, "claim_attempt_review", {
      taskId,
    });
    expect(denied).toMatchObject({
      isError: true,
      data: { error: "AI_ATTEMPT_REVIEW_RANGE_CHANGED" },
    });
    expect(denied.data).not.toHaveProperty("snapshot");
    expect(
      env.db.$client
        .prepare(
          "SELECT status, generation FROM ai_attempt_review_tasks WHERE id = ?",
        )
        .get(taskId),
    ).toEqual({ status: "paused", generation: 0 });
    await expectStatus(
      await env.call(
        assignment,
        "PATCH",
        { answerRelease: "on_submit" },
        env.teacher,
      ),
      200,
    );
    await expectStatus(
      await env.call(`${route}/${taskId}/actions`, "POST", { action: "retry" }),
      200,
    );
    const claimed = await callToolJson(client, "claim_attempt_review", {
      taskId,
    });
    expect(claimed.isError).toBe(false);
    const { claimed: success, ...payload } = claimed.data;
    expect(success).toBe(true);
    const view = aiAttemptReviewMcpClaimViewSchema.parse(payload);
    expect(view.snapshotVersion).toBe(preview.opaquePreviewVersion);
    expect(view.snapshot.counts).toEqual(preview.counts);
  } finally {
    await client.close();
  }
});

it("撤回公布保留整卷任务和操作，所有公开回执只返回空统计，重新公布恢复原快照", async () => {
  const env = await world("kernel");
  const { taskId, preview, body } = await createReview(env);
  const stored = () =>
    env.db.$client
      .prepare(
        "SELECT counts_json, context_snapshot_json, snapshot_version FROM ai_attempt_review_tasks WHERE id = ?",
      )
      .get(taskId);
  const before = stored();
  expect(before).toBeDefined();
  const assignment = `/api/teacher/assignments/${env.assignmentId}`;
  await expectStatus(
    await env.call(
      assignment,
      "PATCH",
      { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00.000Z" },
      env.teacher,
    ),
    200,
  );
  const hidden = (payload: unknown) => {
    expect.soft(payload).toMatchObject({
      id: taskId,
      counts: null,
      snapshotVersion: preview.opaquePreviewVersion,
    });
    assertNoLeak(payload, {
      forbid: [
        "correctCount",
        "incorrectCount",
        "unansweredCount",
        "pendingCount",
        "hasAnswerCount",
        "missingAnswerCount",
        "unknownAnswerCount",
        "gradedCount",
        "accuracyAmongGraded",
      ],
    });
  };
  const list = aiAttemptReviewListOkSchema.parse(
    await expectStatus(await env.call(route), 200),
  ).data;
  expect(list.tasks).toHaveLength(1);
  expect(list.tasks[0]?.allowedActions).toContain("cancel");
  hidden(list.tasks[0]);
  const replay = aiAttemptReviewCreateOkSchema.parse(
    await expectStatus(await env.call(route, "POST", body), 200),
  ).data;
  expect(replay.created).toBe(false);
  hidden(replay.task);
  const client = await env.connect();
  try {
    const sdk = await callToolJson(client, "list_my_attempt_reviews", {});
    expect(sdk).toMatchObject({
      isError: false,
      data: { tasks: [{ taskId, status: "created", questionCount: 2 }] },
    });
    assertNoLeak(sdk.data, {
      forbid: ["counts", "correctCount", "gradedCount", "accuracyAmongGraded"],
    });
    for (const action of ["cancel", "archive"]) {
      const response = (await expectStatus(
        await env.call(`${route}/${taskId}/actions`, "POST", { action }),
        200,
      )) as { data: unknown };
      hidden(aiAttemptReviewTaskPublicSchema.parse(response.data));
    }
  } finally {
    await client.close();
  }
  expect(stored()).toEqual(before);
  await expectStatus(
    await env.call(
      assignment,
      "PATCH",
      { answerRelease: "on_submit" },
      env.teacher,
    ),
    200,
  );
  const archived = aiAttemptReviewListOkSchema.parse(
    await expectStatus(await env.call(`${route}?archived=only`), 200),
  ).data;
  expect(archived.tasks).toMatchObject([
    {
      id: taskId,
      status: "cancelled",
      counts: preview.counts,
      snapshotVersion: preview.opaquePreviewVersion,
    },
  ]);
  expect(stored()).toEqual(before);
});

it("内核已确认但宿主尚是 draft，重启后的 AI 预览首读恢复一次正式事实", async () => {
  const env = await world("kernel", "interrupt");
  env.restart();
  const host = () =>
    env.db.$client
      .prepare(
        "SELECT status, score_auto, score_final FROM attempts WHERE id = ?",
      )
      .get(env.start.id);
  const authority = () => {
    using db = new DatabaseSync(join(env.dataDir, "learning-kernel.sqlite"), {
      readOnly: true,
    });
    return db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM submissions s JOIN step_attempts a ON a.id=s.step_attempt_id WHERE a.activity_id=?) AS submissions,
              (SELECT COUNT(*) FROM completions WHERE activity_id=?) AS completions`,
      )
      .get(env.start.id, env.start.id);
  };
  expect(host()).toEqual({
    status: "draft",
    score_auto: null,
    score_final: null,
  });
  expect(authority()).toEqual({ submissions: 1, completions: 1 });
  const path = `${route}/preview?attemptId=${env.start.id}`;
  await expectDenied(
    await env.call(path, "GET", undefined, env.otherCookie),
    403,
    "FORBIDDEN",
  );
  expect(host()).toMatchObject({ status: "draft" });
  const preview = aiAttemptReviewPreviewOkSchema.parse(
    await expectStatus(await env.call(path), 200),
  ).data;
  expect(preview.counts).toMatchObject({
    correctCount: 1,
    incorrectCount: 1,
    hasAnswerCount: 2,
    accuracyAmongGraded: 0.5,
  });
  expect(host()).toEqual({
    status: "graded",
    score_auto: null,
    score_final: null,
  });
  env.restart();
  const again = aiAttemptReviewPreviewOkSchema.parse(
    await expectStatus(await env.call(path), 200),
  ).data;
  expect(again.opaquePreviewVersion).toBe(preview.opaquePreviewVersion);
  expect(again.counts).toEqual(preview.counts);
  expect(authority()).toEqual({ submissions: 1, completions: 1 });
});

it("正式答了两道但真正未交的内核草稿保持 409，AI 不代交", async () => {
  const env = await world("kernel", "draft");
  env.restart();
  await expectDenied(
    await env.call(`${route}/preview?attemptId=${env.start.id}`),
    409,
    "AI_ATTEMPT_REVIEW_NOT_SUBMITTED",
  );
  expect(
    env.db.$client
      .prepare("SELECT status FROM attempts WHERE id = ?")
      .get(env.start.id),
  ).toEqual({ status: "draft" });
});
