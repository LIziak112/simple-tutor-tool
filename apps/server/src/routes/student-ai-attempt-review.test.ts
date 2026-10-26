import { randomUUID } from "node:crypto";
import {
  type AiAttemptReviewCreateData,
  type AiAttemptReviewDetailData,
  type AiAttemptReviewListData,
  type AiAttemptReviewPreviewData,
  aiAttemptReviewCreateOkSchema,
  aiAttemptReviewDetailOkSchema,
  aiAttemptReviewListOkSchema,
  aiAttemptReviewPreviewOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import {
  aiAttemptReviewResults,
  aiAttemptReviewTasks,
  assignments,
  attempts,
  responses,
  students,
  teachers,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { insertAiConnectionFixture } from "../test/ai-companion-fixtures.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { makeStudent } from "../test/note-fixtures.ts";

/**
 * 整体复盘路由测试（任务 1ef854c7；交接方案 §10 的路由/HTTP 部分）：
 * - 响应面最小：预览/列表/详情不含题面、答案、解析正文（assertNoLeak +
 *   哨兵内容级双断言）；受控出口（MCP 领取含答案解析）在服务测试 T07 断言；
 * - 知情门：无连接创建 403 AI_SETUP_REQUIRED 且零任务行（与批量复盘同口径）；
 * - 预览版本锚：伪造版本创建 → 409 AI_ATTEMPT_REVIEW_RANGE_CHANGED；
 * - 归属防枚举：他人/不存在 taskId → 404 同文案。
 */

const SENTINEL_STEM = "SENTINEL_ROUTE_AR_STEM";
const SENTINEL_SOLUTION = "SENTINEL_ROUTE_AR_SOLUTION";

const active: ReturnType<typeof createTestDb>[] = [];

function world() {
  const db = createTestDb();
  active.push(db);
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  const studentId = makeStudent(db);
  db.update(students)
    .set({ displayName: "整体复盘路由学生" })
    .where(eq(students.id, studentId))
    .run();
  const app = createApp({
    db,
    dataDir: createTestDir(),
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const cookie = `tutor_student_session=${createStudentSession(db, studentId).token}`;
  return { app, db, cookie, studentId };
}

afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

function submittedAttempt(db: Db, studentId: string) {
  const assignmentId = randomUUID();
  db.insert(assignments)
    .values({
      id: assignmentId,
      teacherId: TEST_TEACHER_ID,
      title: "整体复盘路由作业",
      dueAt: null,
      answerRelease: "on_submit",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  const attemptId = randomUUID();
  db.insert(attempts)
    .values({
      id: attemptId,
      studentId,
      sourceType: "assignment",
      assignmentId,
      status: "submitted",
      startedAt: "2026-06-01T00:00:00.000Z",
      submittedAt: "2026-06-01T01:00:00.000Z",
    })
    .run();
  return attemptId;
}

function addQuestion(
  db: Db,
  attemptId: string,
  questionId: string,
  options: { finalCorrect?: boolean | null } = {},
) {
  db.insert(responses)
    .values({
      id: randomUUID(),
      attemptId,
      questionId,
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: JSON.stringify({
        type: "choice",
        difficulty: 3,
        knowledge: ["考点A"],
        stemMd: SENTINEL_STEM,
        options: [{ text: "甲" }, { text: "乙" }],
        answers: { kind: "choice", index: 1 },
        hints: [],
        solutionMd: SENTINEL_SOLUTION,
        sourceMd: "::::question{type=choice}\n题干\n:::",
        id: questionId,
      }),
      answerJson: JSON.stringify({ kind: "choice", index: 0 }),
      submittedAt: "2026-06-01T01:00:00.000Z",
      autoCorrect: options.finalCorrect ?? null,
      finalCorrect: options.finalCorrect ?? null,
      teacherComment: null,
    })
    .run();
}

async function previewOf(
  app: ReturnType<typeof createApp>,
  cookie: string,
  attemptId: string,
): Promise<AiAttemptReviewPreviewData> {
  const res = await app.request(
    `/api/student/ai/attempt-reviews/preview?attemptId=${attemptId}`,
    { headers: { cookie } },
  );
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  const parsed = aiAttemptReviewPreviewOkSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  return (body as { data: AiAttemptReviewPreviewData }).data;
}

describe("整体复盘路由", () => {
  it("撤回公布后，详情与打开接口均不返回报告答案哨兵，且保留未读状态", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptId = submittedAttempt(db, studentId);
    addQuestion(db, attemptId, "q1", { finalCorrect: false });
    insertAiConnectionFixture(db, studentId);
    const preview = await previewOf(app, cookie, attemptId);
    const created = await app.request("/api/student/ai/attempt-reviews", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        attemptId,
        mutationId: "m-revoke",
        expectedPreviewVersion: preview.opaquePreviewVersion,
        purpose: "复盘",
        channel: "mcp",
      }),
    });
    expect(created.status).toBe(201);
    const { task } = (
      (await created.json()) as { data: AiAttemptReviewCreateData }
    ).data;
    db.update(aiAttemptReviewTasks)
      .set({ status: "replied", generation: 1 })
      .where(eq(aiAttemptReviewTasks.id, task.id))
      .run();
    db.insert(aiAttemptReviewResults)
      .values({
        id: randomUUID(),
        taskId: task.id,
        generation: 1,
        contentHash: "fixture",
        reportJson: JSON.stringify({
          schemaVersion: 1,
          overview: SENTINEL_SOLUTION,
          knowledgeFindings: [],
          errorPatterns: [],
          performanceNotes: [],
          trainingPlan: [],
          limitations: [],
        }),
        receivedAt: "2026-10-25T06:00:00.000Z",
      })
      .run();
    // 允许场景确实能读取模型正文；禁用后双断言不得返回同一哨兵。
    const allowed = await app.request(
      `/api/student/ai/attempt-reviews/${task.id}`,
      { headers: { cookie } },
    );
    expect(allowed.status).toBe(200);
    expect(JSON.stringify(await allowed.json())).toContain(SENTINEL_SOLUTION);
    const attempt = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    db.update(assignments)
      .set({ answerRelease: "after_due", dueAt: "2099-01-01T00:00:00.000Z" })
      .where(eq(assignments.id, attempt?.assignmentId ?? ""))
      .run();
    const detail = await app.request(
      `/api/student/ai/attempt-reviews/${task.id}`,
      { headers: { cookie } },
    );
    const opened = await app.request(
      `/api/student/ai/attempt-reviews/${task.id}/actions`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "open" }),
      },
    );
    for (const response of [detail, opened]) {
      expect(response.status).toBe(409);
      const body: unknown = await response.json();
      assertNoLeak(body);
      expect(JSON.stringify(body)).not.toContain(SENTINEL_SOLUTION);
    }
    expect(
      db
        .select()
        .from(aiAttemptReviewTasks)
        .where(eq(aiAttemptReviewTasks.id, task.id))
        .get()?.openedAt,
    ).toBeNull();
  });
  it("预览：形状合法且不含题面/答案/解析（键名与内容双断言）", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptId = submittedAttempt(db, studentId);
    addQuestion(db, attemptId, "q1", { finalCorrect: false });
    const data = await previewOf(app, cookie, attemptId);
    expect(data.questionCount).toBe(1);
    expect(data.counts.incorrectCount).toBe(1);
    expect(data.opaquePreviewVersion.startsWith("v1-")).toBe(true);
    const res = await app.request(
      `/api/student/ai/attempt-reviews/preview?attemptId=${attemptId}`,
      { headers: { cookie } },
    );
    const body: unknown = await res.json();
    assertNoLeak(body);
    expect(JSON.stringify(body)).not.toContain(SENTINEL_STEM);
    expect(JSON.stringify(body)).not.toContain(SENTINEL_SOLUTION);
  });

  it("未交卷预览 → 409；未知 attemptId → 404", async () => {
    const { app, db, cookie, studentId } = world();
    const draftId = randomUUID();
    db.insert(attempts)
      .values({
        id: draftId,
        studentId,
        sourceType: "assignment",
        assignmentId: null,
        status: "draft",
        startedAt: "2026-06-01T00:00:00.000Z",
      })
      .run();
    const draftRes = await app.request(
      `/api/student/ai/attempt-reviews/preview?attemptId=${draftId}`,
      { headers: { cookie } },
    );
    expect(draftRes.status).toBe(409);
    const draftBody = (await draftRes.json()) as { error?: string };
    expect(draftBody.error).toBe("AI_ATTEMPT_REVIEW_NOT_SUBMITTED");

    const missing = await app.request(
      `/api/student/ai/attempt-reviews/preview?attemptId=${randomUUID()}`,
      { headers: { cookie } },
    );
    expect(missing.status).toBe(404);
  });

  it("创建：无连接 403 零任务行；有连接 201；重放 200 created:false", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptId = submittedAttempt(db, studentId);
    addQuestion(db, attemptId, "q1", { finalCorrect: false });
    const preview = await previewOf(app, cookie, attemptId);
    const payload = {
      attemptId,
      mutationId: "m-route-1",
      expectedPreviewVersion: preview.opaquePreviewVersion,
      purpose: "整体复盘",
      channel: "mcp",
    };
    const blocked = await app.request("/api/student/ai/attempt-reviews", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(blocked.status).toBe(403);
    const blockedBody = (await blocked.json()) as { error?: string };
    expect(blockedBody.error).toBe("AI_SETUP_REQUIRED");
    expect(db.select().from(aiAttemptReviewTasks).all().length).toBe(0);

    insertAiConnectionFixture(db, studentId);
    const created = await app.request("/api/student/ai/attempt-reviews", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(created.status).toBe(201);
    const createdBody: unknown = await created.json();
    expect(aiAttemptReviewCreateOkSchema.safeParse(createdBody).success).toBe(
      true,
    );
    assertNoLeak(createdBody);
    expect(
      (createdBody as { data: AiAttemptReviewCreateData }).data.created,
    ).toBe(true);

    const replay = await app.request("/api/student/ai/attempt-reviews", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      data: AiAttemptReviewCreateData;
    };
    expect(replayBody.data.created).toBe(false);
  });

  it("伪造预览版本 → 409 RANGE_CHANGED 且不落任务行", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptId = submittedAttempt(db, studentId);
    addQuestion(db, attemptId, "q1", { finalCorrect: false });
    insertAiConnectionFixture(db, studentId);
    const res = await app.request("/api/student/ai/attempt-reviews", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        attemptId,
        mutationId: "m-forged",
        expectedPreviewVersion: "v1-forged",
        purpose: "整体复盘",
        channel: "mcp",
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("AI_ATTEMPT_REVIEW_RANGE_CHANGED");
    expect(db.select().from(aiAttemptReviewTasks).all().length).toBe(0);
  });

  it("列表/详情/动作：公开视图无泄露；他人任务 404 同文案；cancel 生效", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptId = submittedAttempt(db, studentId);
    addQuestion(db, attemptId, "q1", { finalCorrect: false });
    insertAiConnectionFixture(db, studentId);
    const preview = await previewOf(app, cookie, attemptId);
    const created = await app.request("/api/student/ai/attempt-reviews", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        attemptId,
        mutationId: "m-route-2",
        expectedPreviewVersion: preview.opaquePreviewVersion,
        purpose: "整体复盘",
        channel: "mcp",
      }),
    });
    const taskId = (
      (await created.json()) as { data: AiAttemptReviewCreateData }
    ).data.task.id;

    const list = await app.request("/api/student/ai/attempt-reviews", {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    const listBody: unknown = await list.json();
    expect(aiAttemptReviewListOkSchema.safeParse(listBody).success).toBe(true);
    assertNoLeak(listBody);
    expect(
      (listBody as { data: AiAttemptReviewListData }).data.tasks,
    ).toHaveLength(1);

    const detail = await app.request(
      `/api/student/ai/attempt-reviews/${taskId}`,
      { headers: { cookie } },
    );
    expect(detail.status).toBe(200);
    const detailBody: unknown = await detail.json();
    expect(aiAttemptReviewDetailOkSchema.safeParse(detailBody).success).toBe(
      true,
    );
    assertNoLeak(detailBody);
    expect(
      (detailBody as { data: AiAttemptReviewDetailData }).data.result,
    ).toBeNull();

    const foreign = await app.request(
      `/api/student/ai/attempt-reviews/${randomUUID()}`,
      { headers: { cookie } },
    );
    expect(foreign.status).toBe(404);

    const action = await app.request(
      `/api/student/ai/attempt-reviews/${taskId}/actions`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      },
    );
    expect(action.status).toBe(200);
    const row = db
      .select()
      .from(aiAttemptReviewTasks)
      .where(eq(aiAttemptReviewTasks.id, taskId))
      .get();
    expect(row?.status).toBe("cancelled");
  });
});
