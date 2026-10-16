import { randomUUID } from "node:crypto";
import type { ApiErr } from "@tutor/contract";
import {
  AI_QUESTION_MAX_CHARS,
  AI_TURNS_MAX,
  aiTaskFollowupOkSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import {
  aiMessages,
  aiPolicyOverrides,
  aiTasks,
  responses,
  students,
  teachers,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import {
  beginInappDispatch,
  completeInappDispatch,
} from "../services/ai-companion/student-ai-queue.ts";
import {
  insertAiConnectionFixture,
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";

/**
 * SAI-21 追问路由测试（B11；需求 §7.4/§8、技术方案 §3.3）：
 * - 追问绑定同题对话：只追加本题 ai_messages，不换快照、不采新稿
 *   （新稿 = 新任务新快照，旧任务显示「回复基于之前发送的材料」）；
 * - 网络重试幂等：同文追问在途（created/dispatching/uncertain）不重复
 *   追加、不重复计费出站；
 * - 非 replied 态拒绝；同题对话轮次上限 AI_TURNS_LIMIT；
 * - 教师刚改模式立即生效：当前不可用 → 403，消息零落库；
 * - 跨账号 404 同文案（防枚举）。
 */

const active: ReturnType<typeof createTestDb>[] = [];
function world() {
  const db = createTestDb();
  active.push(db);
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  for (const id of ["s-a", "s-b"])
    db.insert(students)
      .values({
        id,
        teacherId: TEST_TEACHER_ID,
        displayName: id,
        loginName: id,
        linkToken: id,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
  const attemptId = insertAttempt(db, { studentId: "s-a" });
  const questionId = "q-alpha";
  insertResponse(db, attemptId, questionId);
  // s-a 持一条 active 连接（create 知情门只看存在性）
  insertAiConnectionFixture(db, "s-a");
  // 同卷邻题哨兵：followup 响应不得混入其他题内容
  db.insert(responses)
    .values({
      id: randomUUID(),
      attemptId,
      questionId: "q-beta",
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: JSON.stringify({
        type: "choice",
        difficulty: 3,
        knowledge: ["其他题考点哨兵BETA"],
        stemMd: "其他题干哨兵BETA",
        options: [{ text: "甲" }, { text: "乙" }],
        answers: { kind: "choice", index: 0 },
        hints: [],
        solutionMd: "其他题解析哨兵BETA",
        sourceMd: "",
        id: "q-beta",
      }),
      answerJson: null,
      submittedAt: null,
      teacherComment: null,
    })
    .run();
  const dataDir = createTestDir();
  const app = createApp({
    db,
    dataDir,
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const cookie = (id: string) =>
    `tutor_student_session=${createStudentSession(db, id).token}`;
  return {
    app,
    db,
    attemptId,
    questionId,
    a: cookie("s-a"),
    b: cookie("s-b"),
  };
}
afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

async function req(
  app: ReturnType<typeof createApp>,
  method: "GET" | "POST",
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createTaskViaRoute(
  w: ReturnType<typeof world>,
): Promise<string> {
  const res = await req(w.app, "POST", "/api/student/ai/tasks", w.a, {
    attemptId: w.attemptId,
    questionId: w.questionId,
    question: "这道题的思路是什么？",
    channel: "inapp",
    materials: { annotation: false, draft: false, formalInk: false },
    mutationId: randomUUID(),
  });
  expect(res.status).toBe(201);
  const json = z
    .object({ data: z.object({ id: z.string() }) })
    .parse(await res.json());
  return json.data.id;
}

/** 经服务入口把任务推到 replied（真实 begin→complete 链，不改库直插） */
async function replyTask(
  w: ReturnType<typeof world>,
  taskId: string,
  replyMd = "先从已知条件出发：",
): Promise<void> {
  const { generation } = beginInappDispatch(w.db, {
    studentId: "s-a",
    taskId,
  });
  completeInappDispatch(w.db, {
    studentId: "s-a",
    taskId,
    generation,
    replyMd,
  });
}

function followupBody(question: string): Record<string, unknown> {
  return { question, mutationId: randomUUID() };
}

it("replied 任务追问成功：追加本题学生消息、任务回 created 待再发送、对话完整", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  await replyTask(w, taskId);
  const before = w.db
    .select()
    .from(aiTasks)
    .where(eq(aiTasks.id, taskId))
    .get();
  if (before === undefined) throw new Error("任务行缺失");

  const res = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/followup`,
    w.a,
    followupBody("第二步为什么会消去分母？"),
  );
  expect(res.status).toBe(200);
  const json = aiTaskFollowupOkSchema.parse(await res.json());
  expect(json.data.task.status).toBe("created");
  expect(json.data.task.hasReply).toBe(true); // 旧回信仍在（历史可见）
  // 对话顺序：首问 → 回信 → 追问；不含其他题内容
  expect(json.data.messages.map((message) => message.role)).toEqual([
    "student",
    "assistant",
    "student",
  ]);
  expect(json.data.messages[2]?.contentMd).toBe("第二步为什么会消去分母？");
  const texts = JSON.stringify(json.data.messages);
  expect(texts).not.toContain("哨兵BETA");

  // 快照不覆盖：追问不重新装配材料（新稿 = 新任务），快照原文与版本锚定不变
  const after = w.db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).get();
  if (after === undefined) throw new Error("任务行缺失");
  expect(after.contextSnapshotJson).toBe(before.contextSnapshotJson);
  expect(after.questionRevisionId).toBe(before.questionRevisionId);
  expect(after.updatedAt >= before.updatedAt).toBe(true);
});

it("网络重试幂等：同文追问在途（created）不重复追加消息", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  await replyTask(w, taskId);
  const first = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/followup`,
    w.a,
    followupBody("再讲一遍可以吗？"),
  );
  expect(first.status).toBe(200);
  // 客户端网络超时重发同一追问（任务已回 created 在途）
  const retry = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/followup`,
    w.a,
    followupBody("再讲一遍可以吗？"),
  );
  expect(retry.status).toBe(200);
  const json = aiTaskFollowupOkSchema.parse(await retry.json());
  expect(json.data.messages).toHaveLength(3);
  const count = w.db
    .select({ id: aiMessages.id })
    .from(aiMessages)
    .where(eq(aiMessages.taskId, taskId))
    .all().length;
  expect(count).toBe(3);
});

it("非 replied 态拒绝追问（created 未回信）与跨账号 404", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  const res = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/followup`,
    w.a,
    followupBody("追问"),
  );
  expect(res.status).toBe(409);
  expect(((await res.json()) as ApiErr).error).toBe("AI_STATE_CONFLICT");

  await replyTask(w, taskId);
  const foreign = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/followup`,
    w.b,
    followupBody("别人家的追问"),
  );
  expect(foreign.status).toBe(404);
  expect(((await foreign.json()) as ApiErr).error).toBe("NOT_FOUND");
});

it("追问超长（>AI_QUESTION_MAX_CHARS）→ 400 AI_TEXT_TOO_LONG，消息零落库", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  await replyTask(w, taskId);
  const res = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/followup`,
    w.a,
    followupBody("长".repeat(AI_QUESTION_MAX_CHARS + 1)),
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as ApiErr).error).toBe("AI_TEXT_TOO_LONG");
  const count = w.db
    .select({ id: aiMessages.id })
    .from(aiMessages)
    .where(eq(aiMessages.taskId, taskId))
    .all().length;
  expect(count).toBe(2); // 首问 + 回信，超长追问未落库
});

it("同题对话轮次上限：学生消息数达 AI_TURNS_MAX 后追问被拒（AI_TURNS_LIMIT）", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  await replyTask(w, taskId);
  // 直插补足轮次（服务路径逐轮追问过慢；一轮 = 一条学生消息）
  for (let index = 0; index < AI_TURNS_MAX - 1; index += 1) {
    w.db
      .insert(aiMessages)
      .values({
        id: randomUUID(),
        taskId,
        role: "student",
        contentMd: `补齐轮次 ${index}`,
        createdAt: new Date(Date.now() + index + 1).toISOString(),
      })
      .run();
  }
  const res = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/followup`,
    w.a,
    followupBody("还想再问一句"),
  );
  expect(res.status).toBe(409);
  expect(((await res.json()) as ApiErr).error).toBe("AI_TURNS_LIMIT");
});

it("教师刚改为完成后可用：未完成题追问被拒（403），消息零落库", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  await replyTask(w, taskId);
  w.db
    .insert(aiPolicyOverrides)
    .values({
      subjectType: "student",
      subjectId: "s-a",
      mode: "post_submit_only",
      updatedAt: new Date().toISOString(),
    })
    .run();
  const res = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/followup`,
    w.a,
    followupBody("模式变了之后再问"),
  );
  expect(res.status).toBe(403);
  expect(((await res.json()) as ApiErr).error).toBe("AI_POLICY_DISABLED");
  const count = w.db
    .select({ id: aiMessages.id })
    .from(aiMessages)
    .where(and(eq(aiMessages.taskId, taskId)))
    .all().length;
  expect(count).toBe(2); // 首问 + 回信，追问未落库
});
