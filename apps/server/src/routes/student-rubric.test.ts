import { randomUUID } from "node:crypto";
import type { ApiErr, RubricReview } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { createTestDb, createTestDir } from "../db/test-utils";
import { taskOf } from "../services/ai-companion/student-ai-materials.ts";
import {
  beginInappDispatch,
  completeInappDispatch,
} from "../services/ai-companion/student-ai-queue.ts";
import { outboundAssemblyOfTask } from "../services/ai-companion/student-ai-worker.ts";
import { inappReplyPlanOf } from "../services/rubric-agent-record.ts";
import {
  callToolJson,
  connectMcpClientViaApp,
} from "../test/mcp-test-utils.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * 模块 3「通用量表判卷」服务级验收：
 * - `:::rubric` 随导入进冻结快照，作答视图公开下发（评价项无参考内容）；
 * - 自评 / 裁定端点校验链（未交卷 403、无量表题 403、档位缺项 400）；
 * - Agent 路径复用 ai_tasks：purpose=rubric_opinion 进快照，出站数据段带量表段，
 *   MCP submit_rubric_opinion 走同一租约、写 rubric_agent_json、回信入伴学栏；
 * - 三份记录互不覆盖；量表分不碰 finalCorrect / 总分。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-m3";
const STUDENT_PASSWORD = "stu-pass-m3";

const RUBRIC_MD = `---
kind: practice
unit: 量表判卷
topic: 开放题
---

::::question{type=solve difficulty=3 knowledge="短评"}
请就「终身学习」写一段 200 字以内的短评。
:::rubric
- 要点覆盖：是否点明观点并给出理由
- 结构：开头结尾是否完整
- 字数：是否在 200 字以内
- 语言：是否通顺
:::
:::answer
参考要点：观点明确、理由两条、结尾回扣。
:::
::::

::::question{type=solve difficulty=2 knowledge="无量表"}
用一句话说说你的看法。
::::`;

const Q = { rubric: "量表判卷-1", plain: "量表判卷-2" } as const;
const FULL_RATINGS = [
  { id: "r1", level: 4, evidence: "开头点明观点" },
  { id: "r2", level: 3 },
  { id: "r3", level: 4 },
  { id: "r4", level: 2, evidence: "有两处句子不通" },
];

type App = ReturnType<typeof createApp>;

interface World {
  app: App;
  db: Db;
  aCookie: string;
  attemptId: string;
}

function tokenOf(res: Response, cookie: string): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${cookie}=`));
  if (!line) throw new Error(`响应中没有 ${cookie} cookie`);
  return line.slice(`${cookie}=`.length).split(";")[0] ?? "";
}

async function postJson(
  app: App,
  path: string,
  cookie: string | undefined,
  body: unknown,
  method = "POST",
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie !== undefined ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** 教师导入带量表练习 → 学生 → 作业 → 开卷（新协议）；不交卷 */
async function makeWorld(
  assignment: {
    answerRelease?: "on_submit" | "after_due";
    dueAt?: string;
  } = {},
): Promise<World> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir: createTestDir(),
  });
  const setup = await postJson(app, "/api/public/teacher/setup", undefined, {
    loginName: "teacher",
    password: TEACHER_PASSWORD,
  });
  const tCookie = `tutor_session=${tokenOf(setup, "tutor_session")}`;
  const imported = await postJson(app, "/api/teacher/import/commit", tCookie, {
    markdown: RUBRIC_MD,
    filename: "量表判卷.md",
  });
  if (imported.status !== 200) {
    throw new Error(`夹具导入失败：${JSON.stringify(await imported.json())}`);
  }
  const unitId = (
    (await imported.json()) as { data: { units: { id: string }[] } }
  ).data.units[0]?.id;
  if (unitId === undefined) throw new Error("夹具导入未产出单元");
  const created = await postJson(app, "/api/teacher/students", tCookie, {
    displayName: "张三",
    loginName: "zhangsan",
    password: STUDENT_PASSWORD,
  });
  expect(created.status).toBe(201);
  const studentId = (
    (await created.json()) as { data: { student: { id: string } } }
  ).data.student.id;
  const assigned = await postJson(app, "/api/teacher/assignments", tCookie, {
    unitIds: [unitId],
    studentIds: [studentId],
    ...assignment,
  });
  expect(assigned.status).toBe(201);
  const assignmentId = (
    (await assigned.json()) as { data: { assignments: { id: string }[] } }
  ).data.assignments[0]?.id;
  if (assignmentId === undefined) throw new Error("布置作业缺 id");
  const login = await postJson(app, "/api/public/student/login", undefined, {
    loginName: "zhangsan",
    password: STUDENT_PASSWORD,
  });
  expect(login.status).toBe(200);
  const aCookie = `tutor_student_session=${tokenOf(login, "tutor_student_session")}`;
  const started = await postJson(
    app,
    `/api/student/assignments/${assignmentId}/attempt`,
    aCookie,
    { workflowVersion: 1 },
  );
  expect(started.status).toBe(200);
  const attemptId = ((await started.json()) as { data: { id: string } }).data
    .id;
  return { app, db, aCookie, attemptId };
}

async function questionsOf(
  w: World,
): Promise<Record<string, Record<string, unknown>>> {
  const res = await w.app.request(`/api/student/attempts/${w.attemptId}`, {
    headers: { cookie: w.aCookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { units: { questions: Record<string, unknown>[] }[] };
  };
  const map: Record<string, Record<string, unknown>> = {};
  for (const unit of body.data.units) {
    // 草稿视图键 id、结果视图键 questionId
    for (const q of unit.questions) map[String(q.questionId ?? q.id)] = q;
  }
  return map;
}

async function answerAndSubmit(w: World): Promise<void> {
  for (const [questionId, text] of [
    [Q.rubric, "终身学习让人跟上时代。理由一……理由二……所以要坚持学习。"],
    [Q.plain, "赞成。"],
  ] as const) {
    const res = await postJson(
      w.app,
      `/api/student/attempts/${w.attemptId}/answers/${encodeURIComponent(questionId)}`,
      w.aCookie,
      { answer: { kind: "final", finalAnswer: text } },
      "PUT",
    );
    expect(res.status).toBe(200);
  }
  const submitted = await submitAttemptRequest(w.app, w.aCookie, w.attemptId);
  expect(submitted.status).toBe(200);
}

/** 跨过首次知情门（任一 active 连接即可）：建一条 MCP 连接并返回其令牌 */
async function ensureInformed(w: World): Promise<string> {
  const conn = await postJson(w.app, "/api/student/ai/connections", w.aCookie, {
    channel: "mcp",
  });
  const token = (
    (await conn.json()) as { data: { credential: { token: string } | null } }
  ).data.credential?.token;
  if (token === undefined) throw new Error("mcp token 创建失败");
  return token;
}

function rubricPath(w: World, questionId: string, leaf: "self" | "final") {
  return `/api/student/attempts/${w.attemptId}/questions/${encodeURIComponent(questionId)}/rubric/${leaf}`;
}

async function errOf(res: Response): Promise<ApiErr> {
  return (await res.json()) as ApiErr;
}

describe("模块 3：量表随快照公开下发，自评 / 裁定校验链", () => {
  it("作答视图带 rubric（四项 r1–r4、4 档）但不带参考；交卷公布后结果视图带 rubricReview 空记录", async () => {
    const w = await makeWorld();
    const draft = await questionsOf(w);
    const rubric = draft[Q.rubric]?.rubric as {
      items: { id: string; title: string; desc?: string }[];
      levels: number;
    };
    expect(rubric.levels).toBe(4);
    expect(rubric.items.map((item) => item.id)).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
    ]);
    expect(rubric.items[0]).toEqual({
      id: "r1",
      title: "要点覆盖",
      desc: "是否点明观点并给出理由",
    });
    expect(draft[Q.rubric]).not.toHaveProperty("answers");
    expect(draft[Q.rubric]).not.toHaveProperty("solutionMd");
    expect(draft[Q.plain]).not.toHaveProperty("rubric");

    // 未交卷：自评 403（不是 404——题存在，只是还不到评价阶段）
    const early = await postJson(
      w.app,
      rubricPath(w, Q.rubric, "self"),
      w.aCookie,
      { ratings: FULL_RATINGS, note: "" },
      "PUT",
    );
    expect(early.status).toBe(403);
    expect((await errOf(early)).error).toBe("RUBRIC_NOT_AVAILABLE");

    await answerAndSubmit(w);
    const result = await questionsOf(w);
    const review = result[Q.rubric]?.rubricReview as RubricReview;
    expect(review.rubric.items).toHaveLength(4);
    expect(review.self).toBeNull();
    expect(review.agent).toBeNull();
    expect(review.final).toBeNull();
    expect(review.pendingAgentTaskId).toBeNull();
    expect(result[Q.plain]).not.toHaveProperty("rubricReview");
  });

  it("自评：缺项 400；无量表题 403；成功后结果视图回显；裁定三态各走各的前提", async () => {
    const w = await makeWorld();
    await answerAndSubmit(w);

    const missing = await postJson(
      w.app,
      rubricPath(w, Q.rubric, "self"),
      w.aCookie,
      { ratings: FULL_RATINGS.slice(0, 3), note: "漏一项" },
      "PUT",
    );
    expect(missing.status).toBe(400);
    expect((await errOf(missing)).error).toBe("RUBRIC_RATINGS_INVALID");

    const plain = await postJson(
      w.app,
      rubricPath(w, Q.plain, "self"),
      w.aCookie,
      { ratings: FULL_RATINGS, note: "" },
      "PUT",
    );
    expect(plain.status).toBe(403);
    expect((await errOf(plain)).message).toBe("这道题没有量表");

    // 还没有 Agent 意见就「采纳 Agent」→ 409
    const adoptEarly = await postJson(
      w.app,
      rubricPath(w, Q.rubric, "final"),
      w.aCookie,
      { decision: "agent", note: "" },
      "PUT",
    );
    expect(adoptEarly.status).toBe(409);

    const before = (await questionsOf(w))[Q.rubric];
    const self = await postJson(
      w.app,
      rubricPath(w, Q.rubric, "self"),
      w.aCookie,
      { ratings: FULL_RATINGS, note: "自己觉得结构一般" },
      "PUT",
    );
    expect(self.status).toBe(200);
    const selfBody = (await self.json()) as { data: RubricReview };
    expect(selfBody.data.self?.source).toBe("self");
    expect(selfBody.data.self?.ratings).toEqual(FULL_RATINGS);
    expect(selfBody.data.self?.note).toBe("自己觉得结构一般");

    const keep = await postJson(
      w.app,
      rubricPath(w, Q.rubric, "final"),
      w.aCookie,
      { decision: "self", note: "保留我的" },
      "PUT",
    );
    expect(keep.status).toBe(200);
    const kept = (await keep.json()) as { data: RubricReview };
    expect(kept.data.final?.decision).toBe("self");
    expect(kept.data.final?.ratings).toEqual(FULL_RATINGS);

    const custom = await postJson(
      w.app,
      rubricPath(w, Q.rubric, "final"),
      w.aCookie,
      {
        decision: "custom",
        ratings: FULL_RATINGS.map((r) => ({ id: r.id, level: 1 })),
        note: "重判",
      },
      "PUT",
    );
    expect(custom.status).toBe(200);
    const result = await questionsOf(w);
    const review = result[Q.rubric]?.rubricReview as RubricReview;
    expect(review.final?.decision).toBe("custom");
    expect(review.final?.ratings.every((r) => r.level === 1)).toBe(true);
    // 自评记录原样保留，不被裁定覆盖；量表不碰判分事实
    expect(review.self?.ratings).toEqual(FULL_RATINGS);
    expect(result[Q.rubric]?.finalCorrect).toBe(before?.finalCorrect);
    expect(result[Q.rubric]?.selfReview).toEqual(before?.selfReview);
  });
});

describe("模块 3：Agent 判卷走既有 AI 任务 + MCP submit_rubric_opinion", () => {
  it("purpose=rubric_opinion 进快照与出站数据段；写回落 agent 记录、pending 归零；无量表题拒绝", async () => {
    const w = await makeWorld();
    await answerAndSubmit(w);
    const token = await ensureInformed(w);

    const makeTask = (questionId: string) =>
      postJson(w.app, "/api/student/ai/tasks", w.aCookie, {
        attemptId: w.attemptId,
        questionId,
        question: "请按量表帮我判一下这段短评。",
        channel: "mcp",
        materials: { annotation: false, draft: false, formalInk: false },
        mutationId: randomUUID(),
        purpose: "rubric_opinion",
      });
    const created = await makeTask(Q.rubric);
    expect(created.status).toBe(201);
    const taskId = ((await created.json()) as { data: { id: string } }).data.id;

    // 在途判卷任务 → 结果视图 pendingAgentTaskId 指向它
    const pending = (await questionsOf(w))[Q.rubric]
      ?.rubricReview as RubricReview;
    expect(pending.pendingAgentTaskId).toBe(taskId);

    const client = await connectMcpClientViaApp(
      w.app,
      "/mcp/student",
      token,
      "m3-rubric-test",
    );
    try {
      const claimed = await callToolJson(client, "claim_ai_task", {
        taskId,
        includeImages: false,
      });
      expect(claimed.isError).toBe(false);
      const contextDataMd = String(claimed.data.contextDataMd);
      expect(contextDataMd).toContain("## 量表");
      expect(contextDataMd).toContain("r1 要点覆盖:是否点明观点并给出理由");
      expect(contextDataMd).toContain("submit_rubric_opinion");
      // 交卷后判卷：参考要点随数据段下发给 Agent（Q14 预设）
      expect(contextDataMd).toContain("参考要点：观点明确");
      const leaseToken = String(claimed.data.leaseToken);

      const bad = await callToolJson(client, "submit_rubric_opinion", {
        taskId,
        leaseToken,
        ratings: [{ id: "r9", level: 4 }],
        note: "乱填",
      });
      expect(bad.isError).toBe(true);
      expect(String(bad.data.error)).toBe("RUBRIC_RATINGS_INVALID");

      const agentRatings = [
        { id: "r1", level: 3, evidence: "观点有但理由只有一条" },
        { id: "r2", level: 3 },
        { id: "r3", level: 4 },
        { id: "r4", level: 3 },
      ];
      const ok = await callToolJson(client, "submit_rubric_opinion", {
        taskId,
        leaseToken,
        ratings: agentRatings,
        note: "整体达标，理由可再补一条。",
      });
      expect(ok.isError).toBe(false);
      expect(ok.data.submitted).toBe(true);
      expect(ok.data.duplicate).toBe(false);

      const after = (await questionsOf(w))[Q.rubric]
        ?.rubricReview as RubricReview;
      expect(after.agent?.source).toBe("agent");
      expect(after.agent?.taskId).toBe(taskId);
      expect(after.agent?.ratings).toEqual(agentRatings);
      expect(after.pendingAgentTaskId).toBeNull();
      expect(after.self).toBeNull();

      // 回信照常进伴学栏（学习者在对话里也能读到）
      const thread = await w.app.request(`/api/student/ai/tasks/${taskId}`, {
        headers: { cookie: w.aCookie },
      });
      expect(thread.status).toBe(200);
      expect(JSON.stringify(await thread.json())).toContain("量表意见");

      // 采纳 Agent → final 复制 agent 档位
      const adopt = await postJson(
        w.app,
        rubricPath(w, Q.rubric, "final"),
        w.aCookie,
        { decision: "agent", note: "同意" },
        "PUT",
      );
      expect(adopt.status).toBe(200);
      expect(
        ((await adopt.json()) as { data: RubricReview }).data.final?.ratings,
      ).toEqual(agentRatings);

      // 无量表题的任务：工具拒绝并指回 submit_ai_reply
      const plainTask = await makeTask(Q.plain);
      expect(plainTask.status).toBe(201);
      const plainId = ((await plainTask.json()) as { data: { id: string } })
        .data.id;
      const plainClaim = await callToolJson(client, "claim_ai_task", {
        taskId: plainId,
        includeImages: false,
      });
      const rejected = await callToolJson(client, "submit_rubric_opinion", {
        taskId: plainId,
        leaseToken: String(plainClaim.data.leaseToken),
        ratings: agentRatings,
        note: "x",
      });
      expect(rejected.isError).toBe(true);
      expect(String(rejected.data.error)).toBe("RUBRIC_NOT_AVAILABLE");

      // 审查 #99-03：普通求助任务（purpose 缺省）即使题有量表，也不能写回结构化意见
      const helpTask = await postJson(
        w.app,
        "/api/student/ai/tasks",
        w.aCookie,
        {
          attemptId: w.attemptId,
          questionId: Q.rubric,
          question: "这题的论证结构怎么改？",
          channel: "mcp",
          materials: { annotation: false, draft: false, formalInk: false },
          mutationId: randomUUID(),
        },
      );
      expect(helpTask.status).toBe(201);
      const helpId = ((await helpTask.json()) as { data: { id: string } }).data
        .id;
      const helpClaim = await callToolJson(client, "claim_ai_task", {
        taskId: helpId,
        includeImages: false,
      });
      const notPurpose = await callToolJson(client, "submit_rubric_opinion", {
        taskId: helpId,
        leaseToken: String(helpClaim.data.leaseToken),
        ratings: agentRatings,
        note: "x",
      });
      expect(notPurpose.isError).toBe(true);
      expect(String(notPurpose.data.error)).toBe("RUBRIC_NOT_AVAILABLE");
      // 结果页的 agent 记录仍是最初那份（没被普通求助任务覆盖）
      const still = (await questionsOf(w))[Q.rubric]
        ?.rubricReview as RubricReview;
      expect(still.agent?.taskId).toBe(taskId);
    } finally {
      await client.close();
    }
  });

  it("审查 #99-07：同 mutationId 换 purpose 不是重放，409 而不是拿回旧任务", async () => {
    const w = await makeWorld();
    await answerAndSubmit(w);
    await ensureInformed(w);
    const mutationId = randomUUID();
    const body = {
      attemptId: w.attemptId,
      questionId: Q.rubric,
      question: "请按量表帮我判一下。",
      channel: "mcp",
      materials: { annotation: false, draft: false, formalInk: false },
      mutationId,
    };
    const first = await postJson(w.app, "/api/student/ai/tasks", w.aCookie, {
      ...body,
      purpose: "rubric_opinion",
    });
    expect(first.status).toBe(201);
    const replay = await postJson(w.app, "/api/student/ai/tasks", w.aCookie, {
      ...body,
      purpose: "rubric_opinion",
    });
    expect(replay.status).toBe(200);
    const changed = await postJson(w.app, "/api/student/ai/tasks", w.aCookie, {
      ...body,
      purpose: "help",
    });
    expect(changed.status).toBe(409);
    expect((await errOf(changed)).error).toBe("AI_STATE_CONFLICT");
  });
});

describe("模块 3：公布门禁（审查 #99-01 / #99-03）", () => {
  it("截止后公布且未到期：结果视图不带 rubricReview，MCP 写回量表意见被拒", async () => {
    const dueAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const w = await makeWorld({ answerRelease: "after_due", dueAt });
    await answerAndSubmit(w);
    const result = await questionsOf(w);
    const question = result[Q.rubric];
    expect(question).toBeDefined();
    // 受限形态：答案与对错都不下发，量表三份记录同样不下发（rubric 本身在作答视图里仍可见）
    expect(question?.answers).toBeNull();
    expect(question?.rubricReview ?? null).toBeNull();

    const token = await ensureInformed(w);
    const created = await postJson(w.app, "/api/student/ai/tasks", w.aCookie, {
      attemptId: w.attemptId,
      questionId: Q.rubric,
      question: "请按量表帮我判一下。",
      channel: "mcp",
      materials: { annotation: false, draft: false, formalInk: false },
      mutationId: randomUUID(),
      purpose: "rubric_opinion",
    });
    expect(created.status).toBe(201);
    const taskId = ((await created.json()) as { data: { id: string } }).data.id;
    const client = await connectMcpClientViaApp(
      w.app,
      "/mcp/student",
      token,
      "m3-rubric-gate-test",
    );
    try {
      const claimed = await callToolJson(client, "claim_ai_task", {
        taskId,
        includeImages: false,
      });
      const leaseToken = String(claimed.data.leaseToken);
      const rejected = await callToolJson(client, "submit_rubric_opinion", {
        taskId,
        leaseToken,
        ratings: FULL_RATINGS,
        note: "先于公布的意见",
      });
      expect(rejected.isError).toBe(true);
      expect(String(rejected.data.error)).toBe("RUBRIC_NOT_AVAILABLE");
      // 普通回信仍可写回（Agent 按提示退回 submit_ai_reply）
      const plain = await callToolJson(client, "submit_ai_reply", {
        taskId,
        leaseToken,
        replyMarkdown: "答案公布后再按量表细看。",
      });
      expect(plain.isError).toBe(false);
    } finally {
      await client.close();
    }
  });
});

describe("模块 3：页内通道的结构化意见（审查 #99-02）", () => {
  it("出站指引按通道给；回信末尾的 rubric-opinion 块落 agent 记录并替换成可读段", async () => {
    const w = await makeWorld();
    await answerAndSubmit(w);
    await ensureInformed(w);
    const created = await postJson(w.app, "/api/student/ai/tasks", w.aCookie, {
      attemptId: w.attemptId,
      questionId: Q.rubric,
      question: "请按量表帮我判一下。",
      channel: "inapp",
      materials: { annotation: false, draft: false, formalInk: false },
      mutationId: randomUUID(),
      purpose: "rubric_opinion",
    });
    expect(created.status).toBe(201);
    const taskId = ((await created.json()) as { data: { id: string } }).data.id;
    const task = taskOf(w.db, taskId);
    if (task === undefined) throw new Error("任务行缺失");
    // 页内通道没有 MCP 工具：指引改为附 rubric-opinion 块
    const assembly = outboundAssemblyOfTask(w.db, task);
    expect(assembly.contextDataMd).toContain("```rubric-opinion");
    expect(assembly.contextDataMd).not.toContain("submit_rubric_opinion");

    const agentRatings = [
      { id: "r1", level: 3, evidence: "理由只有一条" },
      { id: "r2", level: 3 },
      { id: "r3", level: 4 },
      { id: "r4", level: 3 },
    ];
    const replyMd = `观点清楚，论证还可以更充分。\n\n\`\`\`rubric-opinion\n${JSON.stringify(
      { ratings: agentRatings, note: "整体达标。" },
    )}\n\`\`\``;
    const now = new Date();
    const { generation } = beginInappDispatch(
      w.db,
      { studentId: task.studentId, taskId },
      { now },
    );
    const plan = inappReplyPlanOf(w.db, task, replyMd, now);
    expect(plan.onDelivered).toBeDefined();
    completeInappDispatch(
      w.db,
      {
        studentId: task.studentId,
        taskId,
        generation,
        replyMd: plan.replyMd,
        ...(plan.onDelivered !== undefined
          ? { onDelivered: plan.onDelivered }
          : {}),
      },
      { now },
    );
    const after = (await questionsOf(w))[Q.rubric]
      ?.rubricReview as RubricReview;
    expect(after.agent?.taskId).toBe(taskId);
    expect(after.agent?.ratings).toEqual(agentRatings);
    expect(after.pendingAgentTaskId).toBeNull();
    const thread = await w.app.request(`/api/student/ai/tasks/${taskId}`, {
      headers: { cookie: w.aCookie },
    });
    const threadText = JSON.stringify(await thread.json());
    expect(threadText).toContain("量表意见");
    expect(threadText).toContain("观点清楚");
    expect(threadText).not.toContain("rubric-opinion");

    // 没有块 / 块与量表对不上：原文照发、不落记录
    const plainPlan = inappReplyPlanOf(w.db, task, "只有正文", now);
    expect(plainPlan).toEqual({ replyMd: "只有正文" });
    const badPlan = inappReplyPlanOf(
      w.db,
      task,
      `\`\`\`rubric-opinion\n${JSON.stringify({
        ratings: [{ id: "r9", level: 1 }],
        note: "x",
      })}\n\`\`\``,
      now,
    );
    expect(badPlan.onDelivered).toBeUndefined();
  });
});
