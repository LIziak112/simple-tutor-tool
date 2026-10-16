import { randomUUID } from "node:crypto";
import type { ApiErr } from "@tutor/contract";
import {
  AI_BATCH_MAX_QUESTIONS,
  type AiBatchCreateData,
  aiBatchCreateOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import {
  aiTasks,
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
import { createAiShareTicket } from "../services/ai-companion/student-ai-share.ts";
import { insertAiConnectionFixture } from "../test/ai-companion-fixtures.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { makeStudent } from "../test/note-fixtures.ts";

/**
 * SAI-31 批量复盘路由测试（B16「先测」①②④⑤⑥ 的路由/HTTP 部分）。
 *
 * - 契约边界：>30 题 400 AI_BATCH_LIMIT；空/重复条目/未知字段 400；
 *   超长诉求 400 AI_TEXT_TOO_LONG；
 * - 首次知情门与 POST /ai/tasks 同口径（无连接 403 AI_SETUP_REQUIRED 零任务行）；
 * - 响应面最小：逐项 id/outcome/原因，无题面/答案/解析（assertNoLeak 硬规则）；
 * - link 通道：任务停 created 等外部（不冒充已回复），票据正文含本题哨兵
 *   不含他题（一题一份上下文的对外交付面）。
 */

const BATCH_PATH = "/api/student/ai/batch-review";
/** 题面哨兵：分享正文逐题隔离断言用 */
const SENTINEL_A = "SENTINEL_ROUTE_QA";
const SENTINEL_B = "SENTINEL_ROUTE_QB";

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
    .set({ displayName: "批量路由学生" })
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

/** 已交卷已公布作业卷 + 一题（可指定判分与题面哨兵） */
function addQuestion(
  db: Db,
  attemptId: string,
  questionId: string,
  options: { finalCorrect?: boolean | null; stem?: string } = {},
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
        stemMd: options.stem ?? `题面-${questionId}`,
        options: [{ text: "甲" }, { text: "乙" }],
        answers: { kind: "choice", index: 1 },
        hints: [],
        solutionMd: `解析-${questionId}`,
        sourceMd: "::::question{type=choice}\n题干\n:::",
        id: questionId,
      }),
      answerJson: null,
      submittedAt: "2026-06-01T00:00:00.000Z",
      autoCorrect: options.finalCorrect ?? null,
      finalCorrect: options.finalCorrect ?? null,
      teacherComment: null,
    })
    .run();
}

function submittedAttempt(db: Db, studentId: string): string {
  const assignmentId = randomUUID();
  db.insert(assignments)
    .values({
      id: assignmentId,
      teacherId: TEST_TEACHER_ID,
      title: "路由批量作业",
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
      courseId: null,
      unitId: null,
      lectureId: null,
      attemptNo: 1,
      status: "submitted",
      startedAt: "2026-06-01T00:00:00.000Z",
      submittedAt: "2026-06-01T01:00:00.000Z",
      frozenAt: "2026-06-01T00:00:00.000Z",
      legacyUnverified: false,
      abandonedAt: null,
    })
    .run();
  return attemptId;
}

async function postBatch(
  app: ReturnType<typeof createApp>,
  cookie: string | undefined,
  body: unknown,
): Promise<Response> {
  return app.request(BATCH_PATH, {
    method: "POST",
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** 最小合法请求体（单错题） */
function requestBody(
  attemptId: string,
  questionIds: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    items: questionIds.map((questionId) => ({ attemptId, questionId })),
    channel: "inapp",
    question: "请帮我复盘这些错题",
    mutationId: "route-batch-mut-1",
    ...overrides,
  };
}

describe("SAI-31 批量复盘路由：鉴权、知情门与契约边界", () => {
  it("未登录 401；无连接 403 AI_SETUP_REQUIRED 且零任务行", async () => {
    const { app, db, cookie, studentId } = world();
    const anon = await postBatch(app, undefined, {});
    expect(anon.status).toBe(401);

    const attemptId = submittedAttempt(db, studentId);
    addQuestion(db, attemptId, "q-1", { finalCorrect: false });
    const gated = await postBatch(app, cookie, requestBody(attemptId, ["q-1"]));
    expect(gated.status).toBe(403);
    expect(((await gated.json()) as ApiErr).error).toBe("AI_SETUP_REQUIRED");
    expect(db.select().from(aiTasks).all()).toHaveLength(0);

    insertAiConnectionFixture(db, studentId);
    const ok = await postBatch(app, cookie, requestBody(attemptId, ["q-1"]));
    expect(ok.status).toBe(200);
    expect(db.select().from(aiTasks).all()).toHaveLength(1);
  });

  it("超过单批上限 400 AI_BATCH_LIMIT；空/重复/未知字段 400 VALIDATION_ERROR", async () => {
    const { app, db, cookie, studentId } = world();
    insertAiConnectionFixture(db, studentId);
    const attemptId = submittedAttempt(db, studentId);
    const ids = Array.from(
      { length: AI_BATCH_MAX_QUESTIONS + 1 },
      (_, i) => `q-limit-${i}`,
    );
    for (const id of ids)
      addQuestion(db, attemptId, id, { finalCorrect: false });

    const tooMany = await postBatch(app, cookie, requestBody(attemptId, ids));
    expect(tooMany.status).toBe(400);
    const err = (await tooMany.json()) as ApiErr;
    expect(err.error).toBe("AI_BATCH_LIMIT");

    const empty = await postBatch(app, cookie, requestBody(attemptId, []));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    const dup = await postBatch(app, cookie, {
      ...requestBody(attemptId, ["q-limit-0"]),
      items: [
        { attemptId, questionId: "q-limit-0" },
        { attemptId, questionId: "q-limit-0" },
      ],
    });
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    const unknown = await postBatch(app, cookie, {
      ...requestBody(attemptId, ["q-limit-0"]),
      correct: true,
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });

  it("超长诉求 400 AI_TEXT_TOO_LONG", async () => {
    const { app, db, cookie, studentId } = world();
    insertAiConnectionFixture(db, studentId);
    const attemptId = submittedAttempt(db, studentId);
    addQuestion(db, attemptId, "q-1", { finalCorrect: false });
    const res = await postBatch(
      app,
      cookie,
      requestBody(attemptId, ["q-1"], { question: "长".repeat(2001) }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("AI_TEXT_TOO_LONG");
  });

  it("超大 body 入口预检 413（与 /ai/tasks 小信封同族），不进解析不落库", async () => {
    const { app, db, cookie, studentId } = world();
    insertAiConnectionFixture(db, studentId);
    const attemptId = submittedAttempt(db, studentId);
    addQuestion(db, attemptId, "q-1", { finalCorrect: false });
    // 与 /ai/tasks 限额测试同口径：显式伪造 content-length 触发入口预检
    const res = await app.request(BATCH_PATH, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "content-length": String(64 * 1024 + 1),
      },
      body: JSON.stringify(requestBody(attemptId, ["q-1"])),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("AI_TEXT_TOO_LONG");
    expect(db.select().from(aiTasks).all()).toHaveLength(0);
  });
});

describe("SAI-31 批量复盘路由：逐项结果与防泄露", () => {
  it("混合批响应过契约与 assertNoLeak；伪造判对项逐项拒绝", async () => {
    const { app, db, cookie, studentId } = world();
    insertAiConnectionFixture(db, studentId);
    const attemptId = submittedAttempt(db, studentId);
    addQuestion(db, attemptId, "q-wrong", { finalCorrect: false });
    addQuestion(db, attemptId, "q-right", { finalCorrect: true });

    const res = await postBatch(app, cookie, {
      ...requestBody(attemptId, ["q-wrong", "q-right"]),
    });
    expect(res.status).toBe(200);
    const body = aiBatchCreateOkSchema.parse(await res.json());
    assertNoLeak(body);
    assertNoLeak(body, { forbid: ["stemMd", "question", "snapshot"] });
    const data: AiBatchCreateData = body.data;
    expect(data.summary).toEqual({
      created: 1,
      alreadyExists: 0,
      paused: 0,
      failed: 1,
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("解析-");
    expect(raw).not.toContain("题面-");

    // 同请求重放（同 mutationId）：全部 already_exists，不重复创建
    const replay = await postBatch(app, cookie, {
      ...requestBody(attemptId, ["q-wrong", "q-right"]),
    });
    const replayBody = aiBatchCreateOkSchema.parse(await replay.json());
    expect(replayBody.data.summary).toEqual({
      created: 0,
      alreadyExists: 1,
      paused: 0,
      failed: 1,
    });
    expect(db.select().from(aiTasks).all()).toHaveLength(1);
  });
});

describe("SAI-31 批量复盘路由：link 通道交付面（先测⑤⑥）", () => {
  it("link 任务停 created 等外部；票据正文含本题哨兵不含他题，无「已回复」语义", async () => {
    const { app, db, cookie, studentId } = world();
    insertAiConnectionFixture(db, studentId);
    const attemptId = submittedAttempt(db, studentId);
    addQuestion(db, attemptId, "q-a", {
      finalCorrect: false,
      stem: `题面${SENTINEL_A}原文`,
    });
    addQuestion(db, attemptId, "q-b", {
      finalCorrect: false,
      stem: `题面${SENTINEL_B}原文`,
    });

    const res = await postBatch(app, cookie, {
      ...requestBody(attemptId, ["q-a", "q-b"], { channel: "link" }),
    });
    expect(res.status).toBe(200);
    const body = aiBatchCreateOkSchema.parse(await res.json());
    expect(body.data.summary.created).toBe(2);

    const rows = db.select().from(aiTasks).all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.channel).toBe("link");
      // 等待外部：停在 created，不冒充已回复
      expect(row.status).toBe("created");
    }

    // 学生为第一题生成票据后，公开正文只含本题哨兵（一题一份上下文）
    const taskA = rows.find((row) => row.questionId === "q-a");
    expect(taskA).toBeDefined();
    if (taskA === undefined) return;
    const ticket = createAiShareTicket(db, {
      studentId,
      taskId: taskA.id,
    });
    const shareRes = await app.request(`/api/public/ai/share/${ticket.token}`);
    expect(shareRes.status).toBe(200);
    const html = await shareRes.text();
    expect(html).toContain(SENTINEL_A);
    expect(html).not.toContain(SENTINEL_B);
    // 批量创建 ≠ 已回复：正文没有「已回复」口径（正文本身也不该出现该词）
    expect(html).not.toContain("已回复");
  });
});
