import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AI_MCP_LEASE_MINUTES,
  AI_TASK_DAILY_PER_STUDENT,
  AI_TASK_PENDING_PER_STUDENT,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runBackfills } from "../../db/backfill.ts";
import type { Db } from "../../db/client.ts";
import { createDb } from "../../db/client.ts";
import { runMigrations } from "../../db/migrate.ts";
import {
  type AiTaskRow,
  aiFacts,
  aiMessages,
  aiPolicyOverrides,
  aiTasks,
  assignments,
  attempts,
  responses,
  teachers,
} from "../../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../../db/test-utils.ts";
import { HttpError } from "../../lib/http-error.ts";
import { makeStudent } from "../../test/note-fixtures.ts";
import {
  AI_MCP_LEASE_MAX_TOTAL_MS,
  AI_TASK_MAX_RETRY_COUNT,
  AI_TASK_RETRY_BACKOFF_BASE_MS,
  aiQueueSummaryOf,
  aiTaskContextVersionOf,
  beginInappDispatch,
  cancelAiTask,
  claimMcpTask,
  completeInappDispatch,
  createAiTask,
  failInappDispatch,
  listStudentAiTasks,
  markReplyDelivered,
  recoverAiQueue,
  refreshPendingAiTask,
  renewMcpLease,
  resumeAiTask,
  retryAiTask,
  submitMcpReply,
} from "./student-ai-queue.ts";

/**
 * SAI-12 可靠任务队列测试（B06；技术方案 §3.4/§6、需求规格 §8）。
 *
 * 必须先测六条并发风险逐条落测（批次「必须先测」）：
 * ① 两个实际 SQLite 连接同时领取同任务：只有一个有效 lease；同批重放不抢新一批；
 * ② 超时再领后旧 lease 不能回信/续期；同反馈重放成功、不同正文冲突；
 * ③ 取消与完成、更新 pending 与领取、重试与重复创建竞态均有唯一合法结果；
 * ④ 进程关闭/重开后就绪/过期任务可恢复，已完成任务不重复执行；
 * ⑤ 一学生大量排队不长期饿死另一学生；领取 MCP 类型不被 API worker 抢走；
 * ⑥ 当前权限在领取前校验，事务不因 mock 时钟或持锁等待挂死。
 *
 * 多连接用例使用真实临时文件 SQLite（WAL），不用 mock 成功路径。
 */

const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const SECRET = "queue-test-secret-0001";
const LEASE_MS = AI_MCP_LEASE_MINUTES * 60_000;

/** 测试时刻：T0 + 毫秒偏移（FIFO 与租约确定性全靠注入时钟） */
function at(ms: number): Date {
  return new Date(T0 + ms);
}

function iso(ms: number): string {
  return at(ms).toISOString();
}

// ---------- 夹具（直插行，与 student-ai-materials.test.ts 同形态） ----------

function insertAssignment(db: Db): string {
  const id = randomUUID();
  db.insert(assignments)
    .values({
      id,
      teacherId: TEST_TEACHER_ID,
      title: "作业",
      dueAt: null,
      answerRelease: "on_submit",
      createdAt: iso(0),
    })
    .run();
  return id;
}

function insertAttempt(db: Db, studentId: string): string {
  const id = randomUUID();
  db.insert(attempts)
    .values({
      id,
      studentId,
      sourceType: "assignment",
      assignmentId: insertAssignment(db),
      courseId: null,
      unitId: null,
      lectureId: null,
      attemptNo: 1,
      status: "draft",
      startedAt: iso(0),
      frozenAt: iso(0),
      legacyUnverified: false,
      abandonedAt: null,
    })
    .run();
  return id;
}

function insertResponse(db: Db, attemptId: string, questionId: string): string {
  const id = randomUUID();
  db.insert(responses)
    .values({
      id,
      attemptId,
      questionId,
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: JSON.stringify({
        type: "choice",
        difficulty: 3,
        knowledge: ["考点A"],
        stemMd: "题干",
        options: [{ text: "甲" }, { text: "乙" }],
        answers: { kind: "choice", index: 1 },
        hints: [],
        solutionMd: "解析",
        sourceMd: "::::question{type=choice}\n题干\n:::",
        id: questionId,
      }),
      answerJson: null,
      submittedAt: null,
      teacherComment: null,
    })
    .run();
  return id;
}

/** 直插任务行（配额与恢复用例的填充行；服务语义用例走 createAiTask） */
function insertTaskRow(
  db: Db,
  row: {
    studentId: string;
    attemptId: string;
    /** 指定题目（复用既有响应行）；缺省新开独立填充题 */
    questionId?: string;
    status?: AiTaskRow["status"];
    channel?: AiTaskRow["channel"];
    leaseUntil?: string | null;
    leaseToken?: string | null;
    updatedAt?: string;
    createdAt?: string;
  },
): string {
  const id = randomUUID();
  let questionId = row.questionId;
  let responseId: string;
  if (questionId === undefined) {
    questionId = `fill-${id}`;
    responseId = randomUUID();
    db.insert(responses)
      .values({
        id: responseId,
        attemptId: row.attemptId,
        questionId,
        unitId: null,
        questionVersion: 1,
        questionSnapshotJson: "{}",
        answerJson: null,
        submittedAt: null,
        teacherComment: null,
      })
      .run();
  } else {
    const existing = db
      .select({ rid: responses.id })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, row.attemptId),
          eq(responses.questionId, questionId),
        ),
      )
      .get();
    if (existing === undefined) throw new Error("指定题目的响应行不存在");
    responseId = existing.rid;
  }
  db.insert(aiTasks)
    .values({
      id,
      studentId: row.studentId,
      attemptId: row.attemptId,
      questionId,
      questionRevisionId: responseId,
      channel: row.channel ?? "inapp",
      modeAtSend: "open_study",
      promptHash: "0".repeat(64),
      contextSnapshotJson: "{}",
      status: row.status ?? "created",
      beforeSubmit: true,
      mutationId: randomUUID(),
      leaseUntil: row.leaseUntil ?? null,
      leaseToken: row.leaseToken ?? null,
      retryCount: 0,
      generation: 0,
      createdAt: row.createdAt ?? iso(0),
      updatedAt: row.updatedAt ?? iso(0),
    })
    .run();
  return id;
}

/** 基础世界：一名学生 + draft 作业卷 + 一题响应行 */
function setupWorld(db: Db): {
  studentId: string;
  attemptId: string;
  questionId: string;
} {
  const studentId = makeStudent(db);
  const attemptId = insertAttempt(db, studentId);
  const questionId = "q1";
  insertResponse(db, attemptId, questionId);
  return { studentId, attemptId, questionId };
}

/** 服务入口快捷方式：创建 mcp 任务（默认时刻 T0；可换题避开同题配额） */
function mkMcpTask(
  db: Db,
  world: { studentId: string; attemptId: string; questionId: string },
  opts?: {
    question?: string;
    at?: number;
    mutationId?: string;
    questionId?: string | undefined;
  },
): { task: AiTaskRow; created: boolean } {
  return createAiTask(
    db,
    {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: opts?.questionId ?? world.questionId,
      question: opts?.question ?? "请帮我讲解本题",
      channel: "mcp",
      mutationId: opts?.mutationId ?? randomUUID(),
    },
    { hmacSecret: SECRET, now: at(opts?.at ?? 0) },
  );
}

function mkInappTask(
  db: Db,
  world: { studentId: string; attemptId: string; questionId: string },
  opts?: { at?: number; questionId?: string | undefined },
): AiTaskRow {
  return createAiTask(
    db,
    {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: opts?.questionId ?? world.questionId,
      question: "请帮我讲解本题",
      channel: "inapp",
      mutationId: randomUUID(),
    },
    { hmacSecret: SECRET, now: at(opts?.at ?? 0) },
  ).task;
}

/** 批量新开题目（每题一条响应行），返回题号数组（避开同题进行中配额） */
function openQuestions(
  db: Db,
  attemptId: string,
  prefix: string,
  count: number,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const qid = `${prefix}-${i}`;
    insertResponse(db, attemptId, qid);
    ids.push(qid);
  }
  return ids;
}

function expectHttpError(
  fn: () => unknown,
  status: number,
  code: string,
): HttpError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const httpError = error as HttpError;
    expect(httpError.status).toBe(status);
    expect(httpError.code).toBe(code);
    return httpError;
  }
  throw new Error(`期望抛出 HttpError ${status} ${code}，实际未抛出`);
}

function factsOf(db: Db, taskId: string) {
  return db.select().from(aiFacts).where(eq(aiFacts.taskId, taskId)).all();
}

function assistantMessagesOf(db: Db, taskId: string) {
  return db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.taskId, taskId))
    .all()
    .filter((m) => m.role === "assistant");
}

function taskRow(db: Db, taskId: string): AiTaskRow {
  const row = db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).get();
  if (row === undefined) throw new Error("任务行不存在");
  return row;
}

/** 文件库连接（真实临时文件 SQLite；与 createTestDb 同初始化流程） */
function openFileDb(path: string): Db {
  const db = createDb(path);
  runMigrations(db);
  runBackfills(db);
  db.insert(teachers)
    .values({
      id: TEST_TEACHER_ID,
      loginName: "teacher",
      isAdmin: true,
      disabledAt: null,
      passwordHash: null,
      apiToken: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .onConflictDoNothing()
    .run();
  return db;
}

/** 双连接文件世界（并发用例）：两个连接共享同一个真实库文件 */
function openDualWorld(): {
  dir: string;
  path: string;
  db1: Db;
  db2: Db;
  world: { studentId: string; attemptId: string; questionId: string };
  close(): void;
} {
  const dir = createTestDir();
  const path = join(dir, "tutor.db");
  const db1 = openFileDb(path);
  const world = setupWorld(db1);
  const db2 = openFileDb(path);
  return {
    dir,
    path,
    db1,
    db2,
    world,
    close(): void {
      db1.$client.close();
      db2.$client.close();
    },
  };
}

/** 关闭学生策略覆盖（教师恢复开放） */
function clearStudentOverride(db: Db, studentId: string): void {
  db.delete(aiPolicyOverrides)
    .where(eq(aiPolicyOverrides.subjectId, studentId))
    .run();
}

/** 学生设为提交后可用（作答中关闭） */
function setStudentPostSubmitOnly(db: Db, studentId: string): void {
  db.insert(aiPolicyOverrides)
    .values({
      subjectType: "student",
      subjectId: studentId,
      mode: "post_submit_only",
      updatedAt: iso(0),
    })
    .onConflictDoUpdate({
      target: [aiPolicyOverrides.subjectType, aiPolicyOverrides.subjectId],
      set: { mode: "post_submit_only", updatedAt: iso(0) },
    })
    .run();
}

// ---------- 创建：幂等与配额（操作与语义 1/9） ----------

describe("SAI-12 创建幂等与配额", () => {
  it("同学生同 requestId 同内容 → 返回同任务（created=false，单行单事实）", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const mutationId = randomUUID();
    const first = mkMcpTask(db, world, { mutationId });
    const second = createAiTask(
      db,
      {
        studentId: world.studentId,
        attemptId: world.attemptId,
        questionId: world.questionId,
        question: "请帮我讲解本题",
        channel: "mcp",
        mutationId,
      },
      { hmacSecret: SECRET, now: at(5000) },
    );
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(db.select().from(aiTasks).all()).toHaveLength(1);
    const created = factsOf(db, first.task.id).filter(
      (f) => f.type === "task_created",
    );
    expect(created).toHaveLength(1);
  });

  it("同键不同内容 → 409 冲突；不同学生/题目同键不互相去重", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const mutationId = randomUUID();
    const first = mkMcpTask(db, world, { mutationId });
    // 同键不同问题内容
    expectHttpError(
      () =>
        createAiTask(
          db,
          {
            studentId: world.studentId,
            attemptId: world.attemptId,
            questionId: world.questionId,
            question: "换一个问题",
            channel: "mcp",
            mutationId,
          },
          { hmacSecret: SECRET, now: at(1000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    // 另一学生同键：不返回他人任务
    const otherStudent = makeStudent(db);
    const otherAttempt = insertAttempt(db, otherStudent);
    insertResponse(db, otherAttempt, "q1");
    expectHttpError(
      () =>
        createAiTask(
          db,
          {
            studentId: otherStudent,
            attemptId: otherAttempt,
            questionId: "q1",
            question: "请帮我讲解本题",
            channel: "mcp",
            mutationId,
          },
          { hmacSecret: SECRET, now: at(1000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    expect(db.select().from(aiTasks).all()).toHaveLength(1);
    expect(taskRow(db, first.task.id).studentId).toBe(world.studentId);
  });

  it("配额：同题进行中 / 学生待处理 / 学生当日上限，超额不无限创建", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    // 同题进行中：2 条 created + 1 条 replied（终态不计数）= 2 进行中
    for (let i = 0; i < 2; i += 1) {
      insertTaskRow(db, {
        studentId: world.studentId,
        attemptId: world.attemptId,
        questionId: world.questionId,
        status: "created",
      });
    }
    insertTaskRow(db, {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: world.questionId,
      status: "replied",
    });
    // 第 3 条进行中任务：允许（AI_TASK_ACTIVE_PER_QUESTION=3）
    const third = mkMcpTask(db, world, { at: 1000 });
    expect(third.created).toBe(true);
    // 第 4 条：拒绝
    expectHttpError(
      () => mkMcpTask(db, world, { at: 2000 }),
      409,
      "AI_TASK_LIMIT_REACHED",
    );
    // 学生待处理：另开新题，占满 pending 上限
    const otherQuestion = "q2";
    insertResponse(db, world.attemptId, otherQuestion);
    for (let i = 0; i < AI_TASK_PENDING_PER_STUDENT - 1; i += 1) {
      insertTaskRow(db, {
        studentId: world.studentId,
        attemptId: world.attemptId,
        status: "created",
      });
    }
    expectHttpError(
      () =>
        createAiTask(
          db,
          {
            studentId: world.studentId,
            attemptId: world.attemptId,
            questionId: otherQuestion,
            question: "请帮我讲解本题",
            channel: "inapp",
            mutationId: randomUUID(),
          },
          { hmacSecret: SECRET, now: at(3000) },
        ),
      409,
      "AI_TASK_LIMIT_REACHED",
    );
    // 当日上限：填满日额（北京时间自然日）
    const dailyStudent = makeStudent(db);
    const dailyAttempt = insertAttempt(db, dailyStudent);
    for (let i = 0; i < AI_TASK_DAILY_PER_STUDENT; i += 1) {
      insertTaskRow(db, {
        studentId: dailyStudent,
        attemptId: dailyAttempt,
        status: "cancelled",
        createdAt: iso(60_000 + i),
        updatedAt: iso(60_000 + i),
      });
    }
    insertResponse(db, dailyAttempt, "q-daily-new");
    expectHttpError(
      () =>
        createAiTask(
          db,
          {
            studentId: dailyStudent,
            attemptId: dailyAttempt,
            questionId: "q-daily-new",
            question: "请帮我讲解本题",
            channel: "inapp",
            mutationId: randomUUID(),
          },
          { hmacSecret: SECRET, now: at(120_000) },
        ),
      409,
      "AI_TASK_LIMIT_REACHED",
    );
    // 跨北京自然日后恢复额度
    expect(
      createAiTask(
        db,
        {
          studentId: dailyStudent,
          attemptId: dailyAttempt,
          questionId: "q-daily-new",
          question: "请帮我讲解本题",
          channel: "inapp",
          mutationId: randomUUID(),
        },
        { hmacSecret: SECRET, now: at(24 * 3_600_000) },
      ).created,
    ).toBe(true);
  });

  it("配额口径（技术方案 §限额表）：claimed/dispatching/uncertain 占学生待处理额，paused/failed 不占", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    // 占满 10 个在途名额：claimed 3 + dispatching 3 + uncertain 3 + created 1，
    // 分散到 10 个不同题（每题 1 条，避开同题配额 3 的先拦）——pending+processing
    // 桶全集合 = 技术方案「待处理任务/学生」枚举口径
    const mix: AiTaskRow["status"][] = [
      "claimed",
      "claimed",
      "claimed",
      "dispatching",
      "dispatching",
      "dispatching",
      "uncertain",
      "uncertain",
      "uncertain",
      "created",
    ];
    mix.forEach((status, i) => {
      const questionId = `q-mix-${i}`;
      insertResponse(db, world.attemptId, questionId);
      insertTaskRow(db, {
        studentId: world.studentId,
        attemptId: world.attemptId,
        questionId,
        status,
      });
    });
    insertResponse(db, world.attemptId, "q-mix-new");
    expectHttpError(
      () => mkMcpTask(db, world, { questionId: "q-mix-new" }),
      409,
      "AI_TASK_LIMIT_REACHED",
    );
    // paused/failed 不在枚举内：全部暂停/失败时不占学生待处理额（仍受同题
    // 进行中配额约束，故另开新题验证）
    const pausedWorld = setupWorld(db);
    insertResponse(db, pausedWorld.attemptId, "q-paused");
    for (let i = 0; i < AI_TASK_PENDING_PER_STUDENT; i += 1) {
      insertTaskRow(db, {
        studentId: pausedWorld.studentId,
        attemptId: pausedWorld.attemptId,
        questionId: "q-paused",
        status: i % 2 === 0 ? "paused" : "failed",
      });
    }
    expect(mkMcpTask(db, pausedWorld).created).toBe(true);
  });
});

// ---------- 列表与查看独立（操作与语义 2；完成条件②） ----------

describe("SAI-12 列表：本人范围与稳定游标；查看与处理状态独立", () => {
  it("本人 + 按题/作答过滤 + 稳定游标翻页不重不漏；坏游标 400", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const questions = openQuestions(db, world.attemptId, "q-list", 5);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        mkMcpTask(db, world, { at: (i + 1) * 1000, questionId: questions[i] })
          .task.id,
      );
    }
    // 他学生任务不进本人列表
    const other = setupWorld(db);
    mkMcpTask(db, other, { at: 999 });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = listStudentAiTasks(db, {
        studentId: world.studentId,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages += 1;
      seen.push(...page.tasks.map((t) => t.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // 按创建时间倒序
    expect(seen).toEqual([...ids].reverse());
    // 按题过滤（每题一个任务）
    const filtered = listStudentAiTasks(db, {
      studentId: world.studentId,
      questionId: questions[2]!,
      limit: 20,
    });
    expect(filtered.tasks).toHaveLength(1);
    expect(filtered.tasks[0]!.id).toBe(ids[2]);
    // 坏游标 → 400
    expectHttpError(
      () =>
        listStudentAiTasks(db, {
          studentId: world.studentId,
          limit: 2,
          cursor: "!!!bad!!!",
        }),
      400,
      "VALIDATION_ERROR",
    );
  });

  it("查看态独立：markReplyDelivered 不改 replied 状态，重复打开幂等", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = mkInappTask(db, world);
    const { generation } = beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(1000) },
    );
    completeInappDispatch(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        generation,
        replyMd: "讲解内容",
      },
      { now: at(2000) },
    );
    const marked = markReplyDelivered(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(3000) },
    );
    expect(marked.status).toBe("replied"); // 查看不是终结状态，不覆盖 replied
    expect(marked.replyDeliveredAt).toBe(iso(3000));
    markReplyDelivered(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(4000) },
    );
    const deliveredFacts = factsOf(db, task.id).filter(
      (f) => f.type === "reply_delivered",
    );
    expect(deliveredFacts).toHaveLength(1);
  });
});

// ---------- 必须先测①：两个实际 SQLite 连接同时领取 ----------

describe("SAI-12 并发领取（真实双连接文件库）", () => {
  it("两连接领取同任务：只有一个有效 lease，单条 dispatched 事实", () => {
    const ctx = openDualWorld();
    try {
      const { db1, db2, world } = ctx;
      const task = mkMcpTask(db1, world).task;
      const claim1 = claimMcpTask(
        db1,
        { studentId: world.studentId },
        { now: at(0) },
      );
      expect(claim1?.taskId).toBe(task.id);
      // 第二连接此时领取：同任务已非 created → 明确 409，不产生第二个 lease
      expectHttpError(
        () =>
          claimMcpTask(
            db2,
            { studentId: world.studentId, taskId: task.id },
            { now: at(1) },
          ),
        409,
        "AI_STATE_CONFLICT",
      );
      const row = db2
        .select()
        .from(aiTasks)
        .where(eq(aiTasks.id, task.id))
        .get()!;
      expect(row.status).toBe("claimed");
      expect(row.leaseToken).toBe(claim1!.leaseToken);
      expect(
        db1
          .select()
          .from(aiFacts)
          .where(eq(aiFacts.taskId, task.id))
          .all()
          .filter((f) => f.type === "dispatched"),
      ).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("同批重放：重复领取同 taskId 冲突且不抢新一批任务", () => {
    const ctx = openDualWorld();
    try {
      const { db1, db2, world } = ctx;
      const k1 = mkMcpTask(db1, world, { at: 0 }).task;
      const k2 = mkMcpTask(db1, world, { at: 1000 }).task;
      const first = claimMcpTask(
        db1,
        { studentId: world.studentId, taskId: k1.id },
        { now: at(2000) },
      );
      expect(first?.taskId).toBe(k1.id);
      // 网络重放：另一连接重放同批领取（同 taskId）→ 409
      expectHttpError(
        () =>
          claimMcpTask(
            db2,
            { studentId: world.studentId, taskId: k1.id },
            { now: at(2001) },
          ),
        409,
        "AI_STATE_CONFLICT",
      );
      // 重放不得悄悄改抢 k2
      const k2Row = db1
        .select()
        .from(aiTasks)
        .where(eq(aiTasks.id, k2.id))
        .get()!;
      expect(k2Row.status).toBe("created");
      expect(k2Row.leaseToken).toBeNull();
    } finally {
      ctx.close();
    }
  });
});

// ---------- 必须先测②：租约超时与写回幂等 ----------

describe("SAI-12 租约超时与写回", () => {
  function claimedWorld(db: Db): {
    world: { studentId: string; attemptId: string; questionId: string };
    task: AiTaskRow;
    leaseX: { leaseToken: string; generation: number };
  } {
    const world = setupWorld(db);
    const task = mkMcpTask(db, world).task;
    const claim = claimMcpTask(
      db,
      { studentId: world.studentId },
      { now: at(0) },
    )!;
    return {
      world,
      task,
      leaseX: { leaseToken: claim.leaseToken, generation: claim.generation },
    };
  }

  it("超时再领后：旧 lease 不能续期/回信，仅记 late_reply；新持有者可写回", () => {
    const db = createTestDb();
    const { world, task, leaseX } = claimedWorld(db);
    // 租约过期 → 惰性回收回 created
    const recovered = recoverAiQueue(db, { now: at(LEASE_MS + 1000) });
    expect(recovered.expiredLeases).toBe(1);
    expect(taskRow(db, task.id).status).toBe("created");
    // 客户端 Y 再领
    const claimY = claimMcpTask(
      db,
      { studentId: world.studentId },
      { now: at(LEASE_MS + 2000) },
    )!;
    expect(claimY.leaseToken).not.toBe(leaseX.leaseToken);
    // 旧持有者 X：续租被拒
    expectHttpError(
      () =>
        renewMcpLease(
          db,
          {
            studentId: world.studentId,
            taskId: task.id,
            leaseToken: leaseX.leaseToken,
          },
          { now: at(LEASE_MS + 3000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    // 旧持有者 X：写回被拒，仅记 late_reply，不进正文
    expectHttpError(
      () =>
        submitMcpReply(
          db,
          {
            studentId: world.studentId,
            taskId: task.id,
            leaseToken: leaseX.leaseToken,
            replyMarkdown: "旧客户端迟到回信",
          },
          { now: at(LEASE_MS + 3000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    expect(assistantMessagesOf(db, task.id)).toHaveLength(0);
    expect(
      factsOf(db, task.id).filter((f) => f.type === "late_reply"),
    ).toHaveLength(1);
    // 新持有者 Y 正常写回
    const submit = submitMcpReply(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        leaseToken: claimY.leaseToken,
        replyMarkdown: "有效回信",
      },
      { now: at(LEASE_MS + 4000) },
    );
    expect(submit.duplicate).toBe(false);
    expect(taskRow(db, task.id).status).toBe("replied");
    expect(assistantMessagesOf(db, task.id).map((m) => m.contentMd)).toEqual([
      "有效回信",
    ]);
  });

  it("同反馈重放成功（duplicate）；不同正文冲突不覆盖首次成功", () => {
    const db = createTestDb();
    const { world, task, leaseX } = claimedWorld(db);
    const first = submitMcpReply(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        leaseToken: leaseX.leaseToken,
        replyMarkdown: "首次回信",
      },
      { now: at(1000) },
    );
    expect(first.duplicate).toBe(false);
    // 网络重试：同反馈（同内容）重放 → 成功，不重复入库
    const replay = submitMcpReply(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        leaseToken: leaseX.leaseToken,
        replyMarkdown: "首次回信",
      },
      { now: at(2000) },
    );
    expect(replay.duplicate).toBe(true);
    expect(assistantMessagesOf(db, task.id)).toHaveLength(1);
    // 不同正文（迟到回执）→ 冲突，不覆盖首次成功
    expectHttpError(
      () =>
        submitMcpReply(
          db,
          {
            studentId: world.studentId,
            taskId: task.id,
            leaseToken: leaseX.leaseToken,
            replyMarkdown: "不同正文",
          },
          { now: at(3000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    expect(assistantMessagesOf(db, task.id).map((m) => m.contentMd)).toEqual([
      "首次回信",
    ]);
  });

  it("续租：校验持有者/状态/总时长，超总上限拒绝", () => {
    const db = createTestDb();
    const { world, task, leaseX } = claimedWorld(db);
    // 错误 token → 409
    expectHttpError(
      () =>
        renewMcpLease(
          db,
          {
            studentId: world.studentId,
            taskId: task.id,
            leaseToken: "not-the-token",
          },
          { now: at(1000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    // 正常续租：延长
    const renewed = renewMcpLease(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        leaseToken: leaseX.leaseToken,
      },
      { now: at(5 * 60_000) },
    );
    expect(renewed.leaseUntil).toBe(iso(5 * 60_000 + LEASE_MS));
    // 超过总时长上限：拒绝（不能无限占用）
    expectHttpError(
      () =>
        renewMcpLease(
          db,
          {
            studentId: world.studentId,
            taskId: task.id,
            leaseToken: leaseX.leaseToken,
          },
          { now: at(AI_MCP_LEASE_MAX_TOTAL_MS + 60_000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    expect(taskRow(db, task.id).status).toBe("claimed");
  });
});

// ---------- 必须先测③：取消/更新 pending/重试与重复创建竞态 ----------

describe("SAI-12 状态竞态唯一合法结果", () => {
  it("取消与完成：claimed 取消 → 迟到回信仅记事实；replied 不可取消；出站事实保留", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = mkMcpTask(db, world).task;
    const claim = claimMcpTask(
      db,
      { studentId: world.studentId },
      { now: at(0) },
    )!;
    const cancelled = cancelAiTask(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(1000) },
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelRequestedAt).toBe(iso(1000));
    // 取消不能撤回出站：dispatched 事实保留
    expect(factsOf(db, task.id).some((f) => f.type === "dispatched")).toBe(
      true,
    );
    expect(factsOf(db, task.id).some((f) => f.type === "cancelled")).toBe(true);
    // 迟到回信：仅记事实
    expectHttpError(
      () =>
        submitMcpReply(
          db,
          {
            studentId: world.studentId,
            taskId: task.id,
            leaseToken: claim.leaseToken,
            replyMarkdown: "取消后迟到回信",
          },
          { now: at(2000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    expect(
      factsOf(db, task.id).filter((f) => f.type === "late_reply"),
    ).toHaveLength(1);
    // 终态重复取消 → 409
    expectHttpError(
      () =>
        cancelAiTask(
          db,
          { studentId: world.studentId, taskId: task.id },
          { now: at(3000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    // replied 不可取消（AI 已回信是事实）
    const task2 = mkInappTask(db, world);
    const { generation } = beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: task2.id },
      { now: at(1000) },
    );
    completeInappDispatch(
      db,
      {
        studentId: world.studentId,
        taskId: task2.id,
        generation,
        replyMd: "回信",
      },
      { now: at(2000) },
    );
    expectHttpError(
      () =>
        cancelAiTask(
          db,
          { studentId: world.studentId, taskId: task2.id },
          { now: at(3000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    expect(taskRow(db, task2.id).status).toBe("replied");
  });

  it("更新 pending：已领取拒绝替换；更新后领取拿到新上下文版本", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = mkMcpTask(db, world).task;
    const v1 = aiTaskContextVersionOf(db, task);
    const claim = claimMcpTask(
      db,
      { studentId: world.studentId },
      { now: at(0) },
    )!;
    // 已领取 → 拒绝替换输入
    expectHttpError(
      () =>
        refreshPendingAiTask(
          db,
          { studentId: world.studentId, taskId: task.id },
          { hmacSecret: SECRET, now: at(1000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    // 过期回收后显式更新：题目实质变化 → 新上下文版本
    recoverAiQueue(db, { now: at(LEASE_MS + 1000) });
    const response = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, world.attemptId))
      .get()!;
    if (response.questionSnapshotJson === null) {
      throw new Error("夹具响应行缺少题快照");
    }
    db.update(responses)
      .set({
        questionSnapshotJson: JSON.stringify({
          ...JSON.parse(response.questionSnapshotJson),
          stemMd: "教师改后的新题干",
        }),
      })
      .where(eq(responses.id, response.id))
      .run();
    const refreshed = refreshPendingAiTask(
      db,
      { studentId: world.studentId, taskId: task.id },
      { hmacSecret: SECRET, now: at(LEASE_MS + 2000) },
    );
    const v2 = aiTaskContextVersionOf(db, refreshed);
    expect(v2).not.toBe(v1);
    // 再领取：拿到新版本
    const claim2 = claimMcpTask(
      db,
      { studentId: world.studentId },
      { now: at(LEASE_MS + 3000) },
    )!;
    expect(claim2.contextVersion).toBe(v2);
    // 旧持有者带旧版本写回 → 拒绝
    expectHttpError(
      () =>
        submitMcpReply(
          db,
          {
            studentId: world.studentId,
            taskId: task.id,
            leaseToken: claim.leaseToken,
            replyMarkdown: "旧版本回信",
            expectedContextVersion: v1,
          },
          { now: at(LEASE_MS + 4000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
  });

  it("重试：有界次数 + nextRunAt 退避；重复创建仍命中原任务", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const mutationId = randomUUID();
    const task = createAiTask(
      db,
      {
        studentId: world.studentId,
        attemptId: world.attemptId,
        questionId: world.questionId,
        question: "请帮我讲解本题",
        channel: "inapp",
        mutationId,
      },
      { hmacSecret: SECRET, now: at(0) },
    ).task;
    // 第一次失败
    const g1 = beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(1000) },
    ).generation;
    failInappDispatch(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        generation: g1,
        errorText: "网络超时",
        kind: "retryable",
      },
      { now: at(2000) },
    );
    expect(taskRow(db, task.id).status).toBe("failed");
    // 未到退避窗口 → 拒绝（nextRunAt）
    expectHttpError(
      () =>
        retryAiTask(
          db,
          { studentId: world.studentId, taskId: task.id },
          { now: at(3000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    // 到窗口 → 重试成功，retryCount +1
    const retried = retryAiTask(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(2000 + AI_TASK_RETRY_BACKOFF_BASE_MS + 1000) },
    );
    expect(retried.status).toBe("created");
    expect(retried.retryCount).toBe(1);
    // 重复创建（同幂等键）→ 命中原任务，不产生新行（重试不换任务）
    const again = createAiTask(
      db,
      {
        studentId: world.studentId,
        attemptId: world.attemptId,
        questionId: world.questionId,
        question: "请帮我讲解本题",
        channel: "inapp",
        mutationId,
      },
      { hmacSecret: SECRET, now: at(9000) },
    );
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(task.id);
    expect(db.select().from(aiTasks).all()).toHaveLength(1);
    // 耗尽重试次数 → 拒绝（首重试已用 1 次，再补 MAX-1 次到上限）
    let last = retried;
    for (let i = 0; i < AI_TASK_MAX_RETRY_COUNT - 1; i += 1) {
      const g = beginInappDispatch(
        db,
        { studentId: world.studentId, taskId: task.id },
        { now: at(20_000 + i * 200_000) },
      ).generation;
      failInappDispatch(
        db,
        {
          studentId: world.studentId,
          taskId: task.id,
          generation: g,
          errorText: "再次失败",
          kind: "retryable",
        },
        { now: at(21_000 + i * 200_000) },
      );
      last = retryAiTask(
        db,
        { studentId: world.studentId, taskId: task.id },
        { now: at(21_000 + i * 200_000 + 250_000) },
      );
    }
    const gFinal = beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(900_000) },
    ).generation;
    failInappDispatch(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        generation: gFinal,
        errorText: "最后一次失败",
        kind: "retryable",
      },
      { now: at(901_000) },
    );
    expectHttpError(
      () =>
        retryAiTask(
          db,
          { studentId: world.studentId, taskId: task.id },
          { now: at(901_000 + AI_TASK_RETRY_BACKOFF_BASE_MS * 8) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    expect(taskRow(db, task.id).retryCount).toBe(last.retryCount);
  });
});

// ---------- 必须先测④：进程关闭/重开恢复 ----------

describe("SAI-12 重启恢复（真实文件库关闭重开）", () => {
  it("就绪/过期任务可恢复；已完成不重复执行", () => {
    const dir = createTestDir();
    const path = join(dir, "tutor.db");
    const db1 = openFileDb(path);
    const world = setupWorld(db1);
    const ready = mkMcpTask(db1, world, { at: 0 }).task;
    // 过期租约任务：领取后推进时钟
    const expired = mkMcpTask(db1, world, { at: 100 }).task;
    claimMcpTask(
      db1,
      { studentId: world.studentId, taskId: expired.id },
      { now: at(200) },
    );
    // 超时 dispatching 任务（直插：updatedAt 老于出站超时）
    const staleDispatching = insertTaskRow(db1, {
      studentId: world.studentId,
      attemptId: world.attemptId,
      status: "dispatching",
      updatedAt: iso(1000),
    });
    // 已完成任务
    const done = mkInappTask(db1, world, { at: 200 });
    const g = beginInappDispatch(
      db1,
      { studentId: world.studentId, taskId: done.id },
      { now: at(300) },
    ).generation;
    completeInappDispatch(
      db1,
      {
        studentId: world.studentId,
        taskId: done.id,
        generation: g,
        replyMd: "已完成回信",
      },
      { now: at(400) },
    );
    db1.$client.close();

    // 进程重开：全新连接同一文件
    const db2 = openFileDb(path);
    const result = recoverAiQueue(db2, { now: at(11 * 60_000) });
    expect(result.expiredLeases).toBe(1);
    expect(result.staleDispatching).toBe(1);
    expect(taskRow(db2, ready.id).status).toBe("created");
    expect(taskRow(db2, expired.id).status).toBe("created"); // 失联过期可再次领取
    expect(taskRow(db2, staleDispatching).status).toBe("uncertain");
    // 已完成不重复执行：状态/代次不变，迟到回执仅记事实
    const doneRow = taskRow(db2, done.id);
    expect(doneRow.status).toBe("replied");
    expect(doneRow.generation).toBe(g);
    expectHttpError(
      () =>
        completeInappDispatch(
          db2,
          {
            studentId: world.studentId,
            taskId: done.id,
            generation: g,
            replyMd: "重开后的重复回执",
          },
          { now: at(11 * 60_000 + 1000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    // 恢复后的就绪任务可正常领取
    const claim = claimMcpTask(
      db2,
      { studentId: world.studentId, taskId: ready.id },
      { now: at(11 * 60_000 + 2000) },
    );
    expect(claim?.taskId).toBe(ready.id);
    db2.$client.close();
  });
});

// ---------- 必须先测⑤：公平性与通道隔离 ----------

describe("SAI-12 公平性与通道隔离", () => {
  it("一学生大量排队不饿死另一学生（领取域隔离 + 域内 FIFO）", () => {
    const db = createTestDb();
    const worldA = setupWorld(db);
    const studentB = makeStudent(db);
    const attemptB = insertAttempt(db, studentB);
    insertResponse(db, attemptB, "q1");
    const worldB = {
      studentId: studentB,
      attemptId: attemptB,
      questionId: "q1",
    };
    // A 先堆 5 条，B 只晚 1 条，A 再补 5 条（A 的待处理数到达上限 10）
    const aQuestions = openQuestions(db, worldA.attemptId, "q-a", 10);
    const aIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      aIds.push(
        mkMcpTask(db, worldA, { at: i * 100, questionId: aQuestions[i] }).task
          .id,
      );
    }
    const bTask = mkMcpTask(db, worldB, { at: 1000 }).task;
    for (let i = 0; i < 5; i += 1) {
      mkMcpTask(db, worldA, {
        at: 2000 + i * 100,
        questionId: aQuestions[5 + i],
      });
    }
    // B 的领取不被 A 的 15 条阻塞：立即拿到自己的任务
    const claimB = claimMcpTask(
      db,
      { studentId: studentB },
      { now: at(3000) },
    )!;
    expect(claimB.taskId).toBe(bTask.id);
    // A 域内 FIFO：晚创建的不插队
    const claimA1 = claimMcpTask(
      db,
      { studentId: worldA.studentId },
      { now: at(3001) },
    )!;
    expect(claimA1.taskId).toBe(aIds[0]);
    const claimA2 = claimMcpTask(
      db,
      { studentId: worldA.studentId },
      { now: at(3002) },
    )!;
    expect(claimA2.taskId).toBe(aIds[1]);
  });

  it("领取 MCP 类型不被 API worker 抢走（双向通道守卫）", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const mcpTask = mkMcpTask(db, world).task;
    const inappTask = mkInappTask(db, world);
    // API worker（页内派发）不能处理 mcp 任务
    expectHttpError(
      () =>
        beginInappDispatch(
          db,
          { studentId: world.studentId, taskId: mcpTask.id },
          { now: at(0) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    expect(taskRow(db, mcpTask.id).status).toBe("created");
    // MCP 领取不拿页内任务
    const claim = claimMcpTask(
      db,
      { studentId: world.studentId },
      { now: at(0) },
    );
    expect(claim?.taskId).toBe(mcpTask.id);
    expect(taskRow(db, inappTask.id).status).toBe("created");
    expect(taskRow(db, inappTask.id).leaseToken).toBeNull();
  });
});

// ---------- 必须先测⑥：领取前权限校验与事务健壮性 ----------

describe("SAI-12 领取前权限校验与事务健壮性", () => {
  it("教师改 post_submit_only：领取/派发前实时拦截；恢复开放不自动发送", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const mcpTask = mkMcpTask(db, world).task;
    const inappTask = mkInappTask(db, world);
    setStudentPostSubmitOnly(db, world.studentId);
    // 指定任务领取 → 403（当前权限在领取前校验）
    expectHttpError(
      () =>
        claimMcpTask(
          db,
          { studentId: world.studentId, taskId: mcpTask.id },
          { now: at(1000) },
        ),
      403,
      "AI_POLICY_DISABLED",
    );
    // FIFO 扫描领取：跳过不可用任务（返回 null，状态不变）
    expect(
      claimMcpTask(db, { studentId: world.studentId }, { now: at(1001) }),
    ).toBeNull();
    expect(taskRow(db, mcpTask.id).status).toBe("created");
    // 页内派发：出站前校验失败 → paused（T2 场景：未出站，无事实漂移）
    expectHttpError(
      () =>
        beginInappDispatch(
          db,
          { studentId: world.studentId, taskId: inappTask.id },
          { now: at(1002) },
        ),
      403,
      "AI_POLICY_DISABLED",
    );
    expect(taskRow(db, inappTask.id).status).toBe("paused");
    expect(factsOf(db, inappTask.id).some((f) => f.type === "paused")).toBe(
      true,
    );
    // 教师恢复开放 → 学生显式继续：回 created，不自动发送
    clearStudentOverride(db, world.studentId);
    const resumed = resumeAiTask(
      db,
      { studentId: world.studentId, taskId: inappTask.id },
      { now: at(2000) },
    );
    expect(resumed.status).toBe("created");
    expect(resumed.generation).toBe(0); // 未自动出站
    expect(factsOf(db, inappTask.id).some((f) => f.type === "dispatched")).toBe(
      false,
    );
    expect(factsOf(db, inappTask.id).some((f) => f.type === "resumed")).toBe(
      true,
    );
    // 恢复后可正常领取
    const claim = claimMcpTask(
      db,
      { studentId: world.studentId, taskId: mcpTask.id },
      { now: at(3000) },
    );
    expect(claim?.taskId).toBe(mcpTask.id);
  });

  it("事务不因持锁等待挂死：写锁被占时快速失败，释放后重试成功", () => {
    const ctx = openDualWorld();
    try {
      const { db1, db2, world } = ctx;
      const task = mkMcpTask(db1, world).task;
      db2.$client.pragma("busy_timeout = 300");
      // 连接 1 持有写事务
      db1.$client.exec("BEGIN IMMEDIATE");
      const started = Date.now();
      let threw = false;
      try {
        claimMcpTask(
          db2,
          { studentId: world.studentId, taskId: task.id },
          { now: at(0) },
        );
      } catch {
        threw = true; // SQLITE_BUSY：快速失败而非无限等待
      }
      const elapsed = Date.now() - started;
      expect(threw).toBe(true);
      expect(elapsed).toBeLessThan(5000);
      db1.$client.exec("COMMIT");
      // 锁释放后重试成功（同任务仍可领取）
      const claim = claimMcpTask(
        db2,
        { studentId: world.studentId, taskId: task.id },
        { now: at(1) },
      );
      expect(claim?.taskId).toBe(task.id);
    } finally {
      ctx.close();
    }
  });
});

// ---------- 队列摘要（操作与语义 2 的计数口径） ----------

describe("SAI-12 队列摘要计数", () => {
  it("待领取/处理中/未读三计数含义分开", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const questions = openQuestions(db, world.attemptId, "q-sum", 4);
    mkMcpTask(db, world, { at: 0, questionId: questions[0] });
    mkMcpTask(db, world, { at: 100, questionId: questions[1] });
    const t3 = mkMcpTask(db, world, { at: 200, questionId: questions[2] }).task;
    claimMcpTask(
      db,
      { studentId: world.studentId, taskId: t3.id },
      { now: at(300) },
    );
    const t4 = mkInappTask(db, world, { questionId: questions[3] });
    const g = beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: t4.id },
      { now: at(400) },
    ).generation;
    completeInappDispatch(
      db,
      {
        studentId: world.studentId,
        taskId: t4.id,
        generation: g,
        replyMd: "回信",
      },
      { now: at(500) },
    );
    const summary = aiQueueSummaryOf(db, world.studentId);
    expect(summary.pendingCount).toBe(2); // t1 t2
    expect(summary.processingCount).toBe(1); // t3 claimed
    expect(summary.unreadReplyCount).toBe(1); // t4 replied 未读
    markReplyDelivered(
      db,
      { studentId: world.studentId, taskId: t4.id },
      { now: at(600) },
    );
    expect(aiQueueSummaryOf(db, world.studentId).unreadReplyCount).toBe(0);
  });
});
