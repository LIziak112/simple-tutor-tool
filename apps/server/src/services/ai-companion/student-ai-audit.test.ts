import { randomUUID } from "node:crypto";
import { AI_TASK_ACTIVE_PER_QUESTION } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../../db/client.ts";
import {
  aiFacts,
  aiPolicyOverrides,
  aiTasks,
  attempts,
  responses,
} from "../../db/schema.ts";
import { createTestDb } from "../../db/test-utils.ts";
import {
  expectHttpError,
  insertAttempt,
  insertResponse,
} from "../../test/ai-companion-fixtures.ts";
import { makeStudent } from "../../test/note-fixtures.ts";
import {
  aiHelpFactsSummariesOf,
  aiHelpQuestionFactsOf,
  recordShareBodyRead,
  recordShareTicketGenerated,
} from "./student-ai-audit.ts";
import {
  aiQueueSummaryOf,
  beginInappDispatch,
  cancelAiTask,
  claimMcpTask,
  completeInappDispatch,
  createAiTask,
  failInappDispatch,
  getStudentAiTaskDetail,
  listStudentAiTasks,
  markReplyDelivered,
  openStudentAiReply,
  recoverAiQueue,
  submitMcpReply,
} from "./student-ai-queue.ts";

/**
 * SAI-14 求助事实记录测试（B07；技术方案 §3.5、需求规格 §9.1/§9.2）。
 *
 * 必须先测六条逐条落测（批次「必须先测」）：
 * ① 打开 AI 栏无求助；请求失败无成功；只入队未外发不能说学生已获帮助；
 * ② 供应商网络中断状态不明，不写「已回复」或「确定未收费」；
 * ③ 回信收到但未打开与平台打开分开；重复打开不重复增题数；
 * ④ 链接 HEAD 不记正文访问，GET 读取只记来源未知，不是已读/AI 辅导；
 * ⑤ 提交前请求、提交后领取/打开按各自实际时点保留；迟到客户端不能改阶段；
 * ⑥ 跨账号与教师私注不进入摘要/日志。
 *
 * 完成条件：队列事实和处理状态可解释一致但互不代替；摘要不生成
 * 「独立正确/重度盲区」等心理结论标签。
 */

const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const SECRET = "audit-test-secret-0001";

/** 测试时刻：T0 + 毫秒偏移（确定性事实时序） */
function at(ms: number): Date {
  return new Date(T0 + ms);
}

// ---------- 夹具（同文件内小世界；lesson/交卷形态本批新增） ----------

interface World {
  readonly studentId: string;
  readonly attemptId: string;
  readonly questionId: string;
}

/** 基础世界：一名学生 + draft 作业卷 + 一题响应行 */
function setupWorld(db: Db): World {
  const studentId = makeStudent(db);
  const attemptId = insertAttempt(db, { studentId });
  const questionId = "q1";
  insertResponse(db, attemptId, questionId);
  return { studentId, attemptId, questionId };
}

/** 讲练世界：lesson 来源 draft 卷（题级完成判定走 responses.submittedAt） */
function setupLessonWorld(db: Db): World & { readonly questionId2: string } {
  const studentId = makeStudent(db);
  const attemptId = randomUUID();
  db.insert(attempts)
    .values({
      id: attemptId,
      studentId,
      sourceType: "lesson",
      assignmentId: null,
      courseId: null,
      unitId: null,
      lectureId: randomUUID(),
      attemptNo: 1,
      status: "draft",
      startedAt: new Date(T0).toISOString(),
      frozenAt: new Date(T0).toISOString(),
      legacyUnverified: false,
      abandonedAt: null,
    })
    .run();
  const questionId = "lq1";
  const questionId2 = "lq2";
  insertResponse(db, attemptId, questionId);
  insertResponse(db, attemptId, questionId2);
  return { studentId, attemptId, questionId, questionId2 };
}

/** 整卷交卷（普通卷完成口径：attempt.status ∈ {submitted, graded}） */
function submitAttempt(db: Db, attemptId: string): void {
  db.update(attempts)
    .set({
      status: "submitted",
      submittedAt: new Date(T0 + 60_000).toISOString(),
    })
    .where(eq(attempts.id, attemptId))
    .run();
}

/** 讲练单题行提交（题级完成口径：responses.submittedAt ≠ null） */
function submitLessonQuestion(
  db: Db,
  attemptId: string,
  questionId: string,
): void {
  db.update(responses)
    .set({ submittedAt: new Date(T0 + 60_000).toISOString() })
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .run();
}

/** 学生设为提交后可用（作答中禁用；教师恢复开放用 clearStudentOverride 同款删除） */
function setStudentPostSubmitOnly(db: Db, studentId: string): void {
  db.insert(aiPolicyOverrides)
    .values({
      subjectType: "student",
      subjectId: studentId,
      mode: "post_submit_only",
      updatedAt: new Date(T0).toISOString(),
    })
    .onConflictDoUpdate({
      target: [aiPolicyOverrides.subjectType, aiPolicyOverrides.subjectId],
      set: { mode: "post_submit_only" },
    })
    .run();
}

/** 教师私注哨兵：写入本题 responses.teacherComment（事实与摘要永不含此值） */
const TEACHER_COMMENT_SENTINEL = "教师私注-绝不外泄-SENTINEL";

function setTeacherComment(
  db: Db,
  attemptId: string,
  questionId: string,
): void {
  db.update(responses)
    .set({ teacherComment: TEACHER_COMMENT_SENTINEL })
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .run();
}

function createTask(
  db: Db,
  world: World,
  opts?: {
    questionId?: string;
    channel?: "inapp" | "mcp" | "link";
    at?: number;
  },
) {
  return createAiTask(
    db,
    {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: opts?.questionId ?? world.questionId,
      question: "请帮我讲解本题",
      channel: opts?.channel ?? "mcp",
      mutationId: randomUUID(),
    },
    { hmacSecret: SECRET, now: at(opts?.at ?? 0) },
  ).task;
}

/** MCP 全流程：创建 → 领取 → 写回（返回任务 id 与租约） */
function mcpLifecycle(db: Db, world: World, questionId?: string) {
  const task =
    questionId === undefined
      ? createTask(db, world)
      : createTask(db, world, { questionId });
  const claim = claimMcpTask(
    db,
    { studentId: world.studentId, taskId: task.id },
    { now: at(1000) },
  );
  if (claim === null) throw new Error("领取失败");
  submitMcpReply(
    db,
    {
      studentId: world.studentId,
      taskId: task.id,
      leaseToken: claim.leaseToken,
      replyMarkdown: "AI 回信正文",
    },
    { now: at(2000) },
  );
  return task;
}

function factsOf(db: Db, taskId: string) {
  return db.select().from(aiFacts).where(eq(aiFacts.taskId, taskId)).all();
}

function taskRow(db: Db, taskId: string) {
  const row = db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).get();
  if (row === undefined) throw new Error("任务行不存在");
  return row;
}

/** 摘要字段固定清单：锁定「不发明结论标签」——新增字段必须改本断言逐条评审 */
const SUMMARY_KEYS = [
  "attemptId",
  "dispatched",
  "dispatchedBeforeSubmit",
  "externalViewedUnknown",
  "outboundStatusUnknown",
  "platformOpened",
  "platformOpenedBeforeSubmit",
  "questionId",
  "queuedOnly",
  "replyReceived",
  "repliedBeforeSubmit",
  "requested",
  "requestedBeforeSubmit",
  "taskCount",
] as const;

// ---------- 派生事实摘要（实施步骤 5；需求 §9.1/§9.2） ----------

describe("SAI-14 派生事实摘要", () => {
  it("无记录 = 全 false 零态：不生成「独立完成/重度盲区」类结论标签", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(Object.keys(summary).sort()).toEqual([...SUMMARY_KEYS].sort());
    expect(summary.requested).toBe(false);
    expect(summary.taskCount).toBe(0);
    expect(summary.queuedOnly).toBe(false); // 无请求就无所谓「仅入队」
    expect(summary.dispatched).toBe(false);
    expect(summary.replyReceived).toBe(false);
    expect(summary.platformOpened).toBe(false);
    expect(summary.externalViewedUnknown).toBe(false);
    expect(aiHelpFactsSummariesOf(db, { attemptId: world.attemptId })).toEqual(
      [],
    );
  });

  it("只入队未外发：仅记「发起过求助」，不能说学生已获帮助", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    createTask(db, world);
    const summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.requested).toBe(true);
    expect(summary.queuedOnly).toBe(true);
    expect(summary.dispatched).toBe(false);
    expect(summary.replyReceived).toBe(false);
    expect(summary.platformOpened).toBe(false);
    // 摘要键集不含任何「已获帮助/独立/盲区」结论字段（字段清单即契约）
    expect(Object.keys(summary).sort()).toEqual([...SUMMARY_KEYS].sort());
  });

  it("外发/回信/打开三级分开：领取≠回信，回信≠学生已读", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = createTask(db, world);
    const claim = claimMcpTask(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(1000) },
    );
    expect(claim).not.toBeNull();
    let summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.queuedOnly).toBe(false);
    expect(summary.dispatched).toBe(true);
    expect(summary.replyReceived).toBe(false); // 领取≠回信
    expect(summary.platformOpened).toBe(false);

    submitMcpReply(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        leaseToken: claim!.leaseToken,
        replyMarkdown: "AI 回信正文",
      },
      { now: at(2000) },
    );
    summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.replyReceived).toBe(true);
    expect(summary.platformOpened).toBe(false); // 收到≠已打开

    markReplyDelivered(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(3000) },
    );
    summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.platformOpened).toBe(true);
  });

  it("统计按 distinct 本题范围：同题重试/再求助不增加题数", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    insertResponse(db, world.attemptId, "q2");
    // q1：一次取消后再发（cancelled 不占同题进行中配额）
    const first = createTask(db, world);
    cancelAiTask(
      db,
      { studentId: world.studentId, taskId: first.id },
      { now: at(1000) },
    );
    createTask(db, world);
    // q2：独立一题
    createTask(db, world, { questionId: "q2" });

    const summaries = aiHelpFactsSummariesOf(db, {
      attemptId: world.attemptId,
    });
    expect(summaries).toHaveLength(2); // distinct 题：q1、q2
    const q1 = summaries.find((s) => s.questionId === "q1");
    expect(q1?.taskCount).toBe(2); // 重试不增题数，只累计任务数
    expect(q1?.requested).toBe(true); // 取消也保留发起事实
    expect(q1?.queuedOnly).toBe(true); // 未外发取消 → 仍仅入队口径
  });

  it("摘要必须按 attemptId 或 studentId 限定：裸调用拒绝", () => {
    const db = createTestDb();
    expectHttpError(
      () => aiHelpFactsSummariesOf(db, {}),
      400,
      "VALIDATION_ERROR",
    );
  });

  it("跨账号不进入摘要：按学生与按卷都只含本人题目", () => {
    const db = createTestDb();
    const worldA = setupWorld(db);
    const worldB = setupWorld(db);
    createTask(db, worldA);
    createTask(db, worldB);

    const byStudent = aiHelpFactsSummariesOf(db, {
      studentId: worldA.studentId,
    });
    expect(byStudent).toHaveLength(1);
    expect(byStudent[0]!.attemptId).toBe(worldA.attemptId);

    const byAttempt = aiHelpFactsSummariesOf(db, {
      attemptId: worldA.attemptId,
    });
    expect(byAttempt).toHaveLength(1);
    expect(byAttempt[0]!.questionId).toBe(worldA.questionId);
  });

  it("出站状态未知（dispatching/uncertain）不算仅入队，也不算已外发", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = createTask(db, world, { channel: "inapp" });
    // 模拟出站已发出但结果未回写：直接置 dispatching（begin 之后的崩溃窗口）
    db.update(aiTasks)
      .set({ status: "dispatching", generation: 1 })
      .where(eq(aiTasks.id, task.id))
      .run();
    let summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.outboundStatusUnknown).toBe(true);
    expect(summary.queuedOnly).toBe(false); // 不能说仅入队
    expect(summary.dispatched).toBe(false); // 也不能说已成功外发

    db.update(aiTasks)
      .set({ status: "uncertain" })
      .where(eq(aiTasks.id, task.id))
      .run();
    summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.outboundStatusUnknown).toBe(true);
    expect(summary.queuedOnly).toBe(false);
  });
});

// ---------- 预留通道 hook（上下文链接；B15 接线，本批只定语义不接路由） ----------

describe("SAI-14 链接通道预留 hook", () => {
  it("票据生成记 link_generated，不算正文被读取", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = createTask(db, world, { channel: "link" });
    recordShareTicketGenerated(
      db,
      {
        task,
        ticketId: randomUUID(),
        expiresAt: new Date(T0 + 86_400_000).toISOString(),
      },
      { now: at(1000) },
    );
    const types = factsOf(db, task.id).map((f) => f.type);
    expect(types).toContain("link_generated");
    expect(types).not.toContain("link_viewed"); // 生成 ≠ 读取
    const summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.externalViewedUnknown).toBe(false);
  });

  it("正文实际返回才记 link_viewed：来源未知，不是学生已读/AI 已辅导", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = createTask(db, world, { channel: "link" });
    recordShareBodyRead(db, { task }, { now: at(1000) });

    const viewed = factsOf(db, task.id).filter((f) => f.type === "link_viewed");
    expect(viewed).toHaveLength(1);
    const detail = JSON.parse(viewed[0]!.detailJson ?? "{}") as Record<
      string,
      unknown
    >;
    expect(detail.source).toBe("unknown"); // 谁读未知
    const detailText = JSON.stringify(detail);
    expect(detailText).not.toContain("已读");
    expect(detailText).not.toContain("已辅导");
    expect(detailText).not.toContain("reader");

    const summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.externalViewedUnknown).toBe(true); // 外部读取过
    expect(summary.platformOpened).toBe(false); // ≠ 学生打开平台回信
    expect(summary.replyReceived).toBe(false); // ≠ AI 已回复
  });

  it("教师私注与题面答案不进事实详情与摘要（detail 只存引用与状态）", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    setTeacherComment(db, world.attemptId, world.questionId);
    const task = mcpLifecycle(db, world);
    recordShareTicketGenerated(
      db,
      {
        task,
        ticketId: randomUUID(),
        expiresAt: new Date(T0 + 86_400_000).toISOString(),
      },
      { now: at(3000) },
    );
    recordShareBodyRead(db, { task }, { now: at(4000) });

    const detailText = factsOf(db, task.id)
      .map((f) => f.detailJson ?? "")
      .join("\n");
    expect(detailText).not.toContain(TEACHER_COMMENT_SENTINEL);
    expect(detailText).not.toContain("题干"); // 快照题干不入事实详情
    expect(detailText).not.toContain("解析"); // 官方解析不入事实详情

    const summaryText = JSON.stringify(
      aiHelpQuestionFactsOf(db, {
        attemptId: world.attemptId,
        questionId: world.questionId,
      }),
    );
    expect(summaryText).not.toContain(TEACHER_COMMENT_SENTINEL);
  });
});

// ---------- 队列接入：读路径零副作用与创建原子一致（必须先测 ①） ----------

describe("SAI-14 打开/浏览无求助事实", () => {
  it("读路径零事实：摘要/列表/详情/派生摘要都不写事实；读详情≠打开回信", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = mcpLifecycle(db, world); // 创建→领取→写回
    const before = factsOf(db, task.id).map((f) => f.type);
    expect(before).toEqual(["task_created", "dispatched", "reply_received"]);

    // 「打开 AI 栏」只是浏览：所有读路径不新增任何事实
    aiQueueSummaryOf(db, world.studentId);
    listStudentAiTasks(db, {
      studentId: world.studentId,
      attemptId: world.attemptId,
      limit: 20,
    });
    const detail = getStudentAiTaskDetail(db, {
      studentId: world.studentId,
      taskId: task.id,
    });
    expect(detail.facts.map((f) => f.type)).toEqual(before); // 读详情不标已读
    aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });

    expect(factsOf(db, task.id).map((f) => f.type)).toEqual(before);
    // 显式打开才产生 reply_delivered
    openStudentAiReply(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(5000) },
    );
    expect(factsOf(db, task.id).map((f) => f.type)).toEqual([
      "task_created",
      "dispatched",
      "reply_received",
      "reply_delivered",
    ]);
  });

  it("重复打开幂等：只落一条 reply_delivered，不重复增题数", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = mcpLifecycle(db, world);
    openStudentAiReply(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(5000) },
    );
    openStudentAiReply(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(6000) },
    );
    const delivered = factsOf(db, task.id).filter(
      (f) => f.type === "reply_delivered",
    );
    expect(delivered).toHaveLength(1);
    expect(
      aiHelpFactsSummariesOf(db, { attemptId: world.attemptId }),
    ).toHaveLength(1);
  });
});

describe("SAI-14 创建事实原子一致（入队成功才有事实；失败不记成功）", () => {
  it("入队成功与 task_created 同事务落库：恰一条，携带通道/模式/模板哈希引用", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = createTask(db, world);
    const facts = factsOf(db, task.id);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.type).toBe("task_created");
    const detail = JSON.parse(facts[0]!.detailJson ?? "{}") as Record<
      string,
      unknown
    >;
    expect(detail.channel).toBe("mcp");
    expect(detail.modeAtSend).toBe("open_study");
    expect(typeof detail.promptHash).toBe("string"); // 模板引用（哈希，非正文）
  });

  it("同 mutationId 重放不写两次 task_created（误触重复点击只产生一次）", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const input = {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: world.questionId,
      question: "请帮我讲解本题",
      channel: "mcp" as const,
      mutationId: randomUUID(),
    };
    const first = createAiTask(db, input, { hmacSecret: SECRET, now: at(0) });
    const replay = createAiTask(db, input, {
      hmacSecret: SECRET,
      now: at(1000),
    });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(factsOf(db, first.task.id)).toHaveLength(1);
  });

  it("请求失败无成功事实：配额满与策略禁用都零任务零事实", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    for (let i = 0; i < AI_TASK_ACTIVE_PER_QUESTION; i += 1) {
      createTask(db, world, { at: i * 100 });
    }
    // 同题进行中配额满 → 第四次创建拒绝，无新任务无新事实
    expectHttpError(
      () => createTask(db, world, { at: 90_000 }),
      409,
      "AI_TASK_LIMIT_REACHED",
    );
    const summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.taskCount).toBe(AI_TASK_ACTIVE_PER_QUESTION);

    // 策略禁用（作答中 post_submit_only）→ 创建直接拒绝，零副作用
    const world2 = setupWorld(db);
    setStudentPostSubmitOnly(db, world2.studentId);
    expectHttpError(() => createTask(db, world2), 403, "AI_POLICY_DISABLED");
    expect(
      db
        .select()
        .from(aiFacts)
        .all()
        .filter((f) => f.attemptId === world2.attemptId),
    ).toEqual([]);
  });
});

// ---------- 供应商中断与出站未知（必须先测 ②） ----------

describe("SAI-14 出站结果不明不写已回复", () => {
  it("网络中断报失败：记 failed 与错误摘要，不写 dispatched/reply_received，不断言收费结果", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = createTask(db, world, { channel: "inapp" });
    const begin = beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(1000) },
    );
    failInappDispatch(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        generation: begin.generation,
        errorText: "供应商网络中断，出站结果未知",
        kind: "retryable",
      },
      { now: at(2000) },
    );
    const facts = factsOf(db, task.id);
    expect(facts.map((f) => f.type)).toEqual(["task_created", "failed"]);
    const detailText = facts
      .filter((f) => f.type === "failed")
      .map((f) => f.detailJson ?? "")
      .join();
    expect(detailText).toContain("网络中断");
    expect(detailText).not.toContain("已回复");
    expect(detailText).not.toContain("未收费");
    expect(detailText).not.toContain("notCharged");
    // 摘要：无外发事实、无回信事实——不能说学生已获帮助
    const summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.dispatched).toBe(false);
    expect(summary.replyReceived).toBe(false);
  });

  it("崩溃窗口转 uncertain：状态说「结果待确认」，事实仍无已回复，摘要标记出站未知", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = createTask(db, world, { channel: "inapp" });
    beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(1000) },
    );
    // fetch 发出后进程崩溃 → 超时恢复为 uncertain（显式重试，绝不自动重发）
    recoverAiQueue(db, { now: at(120_000) });
    expect(taskRow(db, task.id).status).toBe("uncertain");
    expect(factsOf(db, task.id).map((f) => f.type)).toEqual(["task_created"]);
    const summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.outboundStatusUnknown).toBe(true);
    expect(summary.dispatched).toBe(false); // 无已确认外发事实
    expect(summary.replyReceived).toBe(false);
    expect(summary.queuedOnly).toBe(false); // 也不能说仅入队
  });
});

// ---------- 阶段按实际时点，迟到客户端不能改阶段（必须先测 ⑤） ----------

describe("SAI-14 提交前后按各自实际时点", () => {
  it("普通卷：提交前创建、提交后领取/写回/打开——各事实独立判定，任务行保留创建时判定", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = createTask(db, world, { at: 0 }); // draft 期创建
    expect(
      factsOf(db, task.id).find((f) => f.type === "task_created")!.beforeSubmit,
    ).toBe(true);

    submitAttempt(db, world.attemptId); // 整卷交卷（服务端口径）

    const claim = claimMcpTask(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(70_000) },
    );
    expect(claim).not.toBeNull();
    submitMcpReply(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        leaseToken: claim!.leaseToken,
        replyMarkdown: "复盘回信",
      },
      { now: at(80_000) },
    );
    openStudentAiReply(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(90_000) },
    );

    const byType = new Map(
      factsOf(db, task.id).map((f) => [f.type, f.beforeSubmit]),
    );
    expect(byType.get("dispatched")).toBe(false); // 提交后领取
    expect(byType.get("reply_received")).toBe(false); // 提交后回信
    expect(byType.get("reply_delivered")).toBe(false); // 提交后打开
    // 任务行 beforeSubmit 保持创建时判定：两套口径并存、互不代替
    expect(taskRow(db, task.id).beforeSubmit).toBe(true);
    // 摘要同时保留两段：提交前发起 + 提交后外发（教师看到「完成后才实际外发」）
    const summary = aiHelpQuestionFactsOf(db, {
      attemptId: world.attemptId,
      questionId: world.questionId,
    });
    expect(summary.requestedBeforeSubmit).toBe(true);
    expect(summary.dispatchedBeforeSubmit).toBe(false);
  });

  it("讲练按题行提交时刻：未交题创建为提交前，交卷行提交后外发记提交后", () => {
    const db = createTestDb();
    const world = setupLessonWorld(db);
    submitLessonQuestion(db, world.attemptId, world.questionId2); // lq2 已交

    const t1 = createTask(db, world, {
      questionId: world.questionId,
      channel: "inapp",
    }); // lq1 未交
    const t2 = createTask(db, world, { questionId: world.questionId2 }); // lq2 已交
    expect(
      factsOf(db, t1.id).find((f) => f.type === "task_created")!.beforeSubmit,
    ).toBe(true);
    expect(
      factsOf(db, t2.id).find((f) => f.type === "task_created")!.beforeSubmit,
    ).toBe(false);

    // lq1 提交后再页内发送：创建是提交前、外发是提交后，各自保留
    submitLessonQuestion(db, world.attemptId, world.questionId);
    const begin = beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: t1.id },
      { now: at(70_000) },
    );
    completeInappDispatch(
      db,
      {
        studentId: world.studentId,
        taskId: t1.id,
        generation: begin.generation,
        replyMd: "回信",
      },
      { now: at(80_000) },
    );
    const byType = new Map(
      factsOf(db, t1.id).map((f) => [f.type, f.beforeSubmit]),
    );
    expect(byType.get("task_created")).toBe(true);
    expect(byType.get("dispatched")).toBe(false);
    expect(byType.get("reply_received")).toBe(false);
  });

  it("迟到客户端不能改阶段：交卷后打开记提交后，已确认的提交前事实不被抹去", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = mcpLifecycle(db, world); // 全部发生在 draft 期
    submitAttempt(db, world.attemptId);
    // 迟到的客户端动作（过时本地状态重复上报打开）只能落在提交后：
    // 记录方法不接收客户端时间/阶段，服务端按当时完成态判定
    markReplyDelivered(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(90_000) },
    );
    const delivered = factsOf(db, task.id).find(
      (f) => f.type === "reply_delivered",
    )!;
    expect(delivered.beforeSubmit).toBe(false);
    expect(taskRow(db, task.id).beforeSubmit).toBe(true); // 任务行口径不变
    expect(
      factsOf(db, task.id).find((f) => f.type === "task_created")!.beforeSubmit,
    ).toBe(true);
  });
});
