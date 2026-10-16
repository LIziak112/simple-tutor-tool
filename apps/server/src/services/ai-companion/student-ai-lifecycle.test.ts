import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiTeachingMode } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runBackfills } from "../../db/backfill.ts";
import { createDbHandle, type Db, type DbHandle } from "../../db/client.ts";
import { runMigrations } from "../../db/migrate.ts";
import {
  aiFacts,
  aiMessages,
  aiPolicyOverrides,
  aiTasks,
  aiTeacherSettings,
  attempts,
  responses,
  teachers,
} from "../../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../../db/test-utils.ts";
import {
  expectHttpError,
  insertAttempt,
  insertResponse,
} from "../../test/ai-companion-fixtures.ts";
import { makeStudent } from "../../test/note-fixtures.ts";
import {
  saveDraftAnswer,
  submitAttempt,
  submitLessonQuestion,
} from "../attempt-service.ts";
import { buildAiContextBundle } from "./student-ai-context.ts";
import {
  aiTaskContextVersionOf,
  beginInappDispatch,
  claimMcpTask,
  completeInappDispatch,
  createAiTask,
  failInappDispatch,
  getStudentAiTaskDetail,
  listStudentAiTasks,
  openStudentAiReply,
  resumeAiTask,
  retryAiTask,
  submitMcpReply,
} from "./student-ai-queue.ts";

/**
 * SAI-15 提交与禁用生命周期测试（B07；需求规格 §3.3/§8、批次「必须先测的
 * 时序」七条）。与 SAI-14 的事实时序测试互补：本文件用**真实** submitAttempt /
 * submitLessonQuestion 驱动完成态迁移（讲练重开按 restartLessonAttempt 事务
 * 语义直插作废 + 新卷行），逐条锁定：
 * ① enqueue→submit→claim：请求为提交前，外发为提交后，出站按复盘模式重装配
 *   （B04 双阶段装配检查点在队列生命周期 hook 兑现；保留原请求时间）；
 * ② claim→teacher-disable→feedback：存旧事实，不向未完成题新增交付；
 * ③ teacher-enable：任务可继续但未自动外发；
 * ④ submit 失败→claim：仍按未完成限制；
 * ⑤ lesson Q1 submit：Q1 解锁 Q2 未解；重开新卷后旧反馈不能进新 Q1；
 * ⑥ restore 期间 provider 晚到、卸载后换学生：均不串库/账号；
 * ⑦ AI 服务失败不阻塞交卷、不回滚已成功提交与原稿。
 */

const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const SECRET = "lifecycle-test-secret-0001";

/** 测试时刻：T0 + 毫秒偏移（确定性时序） */
function at(ms: number): Date {
  return new Date(T0 + ms);
}

// ---------- 夹具（真实交卷链路 + 队列小世界） ----------

interface World {
  readonly studentId: string;
  readonly attemptId: string;
  readonly questionId: string;
}

/** 基础世界：一名学生 + draft 作业卷 + 一题响应行（真实 submitAttempt 可用） */
function setupWorld(db: Db): World {
  const studentId = makeStudent(db);
  const attemptId = insertAttempt(db, { studentId });
  const questionId = "q1";
  insertResponse(db, attemptId, questionId);
  return { studentId, attemptId, questionId };
}

/** 讲练世界：lesson 来源 draft 卷两题（真实 submitLessonQuestion 可用） */
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

/** 教师全局默认模式（ai_teacher_settings 无行 = open_study；本夹具显式落行） */
function setTeacherDefaultMode(db: Db, mode: AiTeachingMode): void {
  db.insert(aiTeacherSettings)
    .values({
      teacherId: TEST_TEACHER_ID,
      defaultMode: mode,
      promptsOpen: null,
      promptsGuided: null,
      promptsReview: null,
      updatedAt: new Date(T0).toISOString(),
    })
    .onConflictDoUpdate({
      target: aiTeacherSettings.teacherId,
      set: { defaultMode: mode, updatedAt: new Date(T0).toISOString() },
    })
    .run();
}

/** 学生覆盖设为提交后可用（作答中禁用；改回允许 = 删行，SAI-06 同语义） */
function setStudentPostSubmitOnly(db: Db, studentId: string): void {
  db.insert(aiPolicyOverrides)
    .values({
      subjectType: "student",
      subjectId: studentId,
      mode: "post_submit_only",
      updatedAt: new Date(T0).toISOString(),
    })
    .run();
}

function clearStudentOverride(db: Db, studentId: string): void {
  db.delete(aiPolicyOverrides)
    .where(
      and(
        eq(aiPolicyOverrides.subjectType, "student"),
        eq(aiPolicyOverrides.subjectId, studentId),
      ),
    )
    .run();
}

function createTask(
  db: Db,
  world: World,
  opts?: {
    attemptId?: string;
    questionId?: string;
    channel?: "inapp" | "mcp" | "link";
    at?: number;
  },
) {
  return createAiTask(
    db,
    {
      studentId: world.studentId,
      attemptId: opts?.attemptId ?? world.attemptId,
      questionId: opts?.questionId ?? world.questionId,
      question: "请帮我讲解本题",
      channel: opts?.channel ?? "mcp",
      mutationId: randomUUID(),
    },
    { hmacSecret: SECRET, now: at(opts?.at ?? 0) },
  ).task;
}

function taskRow(db: Db, taskId: string) {
  const row = db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).get();
  if (row === undefined) throw new Error("任务行不存在");
  return row;
}

function factsOf(db: Db, taskId: string) {
  return db.select().from(aiFacts).where(eq(aiFacts.taskId, taskId)).all();
}

function snapshotOf(task: { contextSnapshotJson: string }): {
  capturedAt: string;
  promptSnapshotMd: string;
} {
  return JSON.parse(task.contextSnapshotJson) as {
    capturedAt: string;
    promptSnapshotMd: string;
  };
}

/** 当前时点的全新装配（重装配断言的对照单源：buildAiContextBundle 本身） */
function freshBundleOf(
  db: Db,
  world: World,
  questionId: string,
  atMs: number,
  attemptId: string = world.attemptId,
) {
  return buildAiContextBundle(
    db,
    {
      studentId: world.studentId,
      attemptId,
      questionId,
    },
    { now: at(atMs), hmacSecret: SECRET },
  );
}

/** 文件库 + 可重启句柄（⑥ restore 时序用；onOpen 与生产启动同款） */
function createFileDb(): { db: Db; handle: DbHandle } {
  const dir = mkdtempSync(join(tmpdir(), "tutor-ai-epoch-"));
  const handle = createDbHandle(join(dir, "tutor.db"), (fresh) => {
    runMigrations(fresh);
    runBackfills(fresh);
    // restart 会再次执行 onOpen：幂等种入教师行（唯一键冲突即已存在）
    fresh
      .insert(teachers)
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
  });
  return { db: handle.db, handle };
}

// ---------- ① enqueue→submit→claim：外发按复盘模式重装配 ----------

describe("SAI-15 ① enqueue→submit→claim（双阶段装配 + 保留原请求时间）", () => {
  it("MCP 领取：请求为提交前（guided），外发为提交后按复盘模式重装配，createdAt/beforeSubmit 不变", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    setTeacherDefaultMode(db, "guided_only");

    const task = createTask(db, world); // 提交前创建：guided 作答中模板
    const createdRow = taskRow(db, task.id);
    expect(createdRow.modeAtSend).toBe("guided_only");
    const versionAtCreate = aiTaskContextVersionOf(db, createdRow);

    // 真实交卷（服务端确认完成态）
    submitAttempt(db, world.studentId, world.attemptId, at(60_000));

    const claim = claimMcpTask(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(70_000) },
    );
    if (claim === null) throw new Error("MCP 领取应成功");

    // 外发时点重装配：完成后规则 = open_study + review 模板（对照 = 当前时点
    // 全新装配，双阶段各自调用同一装配单源）
    const fresh = freshBundleOf(db, world, world.questionId, 70_000);
    expect(fresh.modeAtSend).toBe("open_study");
    expect(fresh.promptTemplateKey).toBe("review");
    const claimedRow = taskRow(db, task.id);
    expect(claimedRow.modeAtSend).toBe("open_study");
    expect(claimedRow.promptHash).toBe(fresh.promptHash);
    expect(snapshotOf(claimedRow).promptSnapshotMd).toBe(
      fresh.snapshot.promptSnapshotMd,
    );
    // 快照身份随之变化（领取方拿到的是重装配后的 contextVersion）
    expect(claim.contextVersion).not.toBe(versionAtCreate);
    expect(claim.contextVersion).toBe(aiTaskContextVersionOf(db, claimedRow));

    // 保留原请求时间：不覆盖为提交后新请求（时间/创建事实/首条问题原样）
    expect(claimedRow.createdAt).toBe(createdRow.createdAt);
    expect(claimedRow.beforeSubmit).toBe(true);
    const createdFact = factsOf(db, task.id).find(
      (f) => f.type === "task_created",
    );
    if (createdFact === undefined) throw new Error("创建事实未落库");
    expect(createdFact.beforeSubmit).toBe(true);
    const dispatchedFact = factsOf(db, task.id).find(
      (f) => f.type === "dispatched",
    );
    if (dispatchedFact === undefined) throw new Error("外发事实未落库");
    expect(dispatchedFact.beforeSubmit).toBe(false); // 外发为提交后
  });

  it("页内派发同款：提交后 begin 按复盘模式重装配（generation 随新代次递增）", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    setTeacherDefaultMode(db, "guided_only");
    const task = createTask(db, world, { channel: "inapp" });
    expect(taskRow(db, task.id).modeAtSend).toBe("guided_only");

    submitAttempt(db, world.studentId, world.attemptId, at(60_000));
    beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(70_000) },
    );

    const fresh = freshBundleOf(db, world, world.questionId, 70_000);
    const row = taskRow(db, task.id);
    expect(row.modeAtSend).toBe("open_study");
    expect(row.promptHash).toBe(fresh.promptHash);
    expect(row.status).toBe("dispatching");
  });

  it("开放伴学提交后领取：模板档 open→review 仍重装配；数据字段不被追改", () => {
    const db = createTestDb();
    const world = setupWorld(db); // 教师默认 open_study
    const task = createTask(db, world);
    const before = taskRow(db, task.id);

    submitAttempt(db, world.studentId, world.attemptId, at(60_000));
    claimMcpTask(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(70_000) },
    );

    // 模式同为 open_study，但作答中 open 模板 → 完成后 review 模板：仍须重装配
    const fresh = freshBundleOf(db, world, world.questionId, 70_000);
    expect(fresh.promptTemplateKey).toBe("review");
    const after = taskRow(db, task.id);
    expect(after.promptHash).toBe(fresh.promptHash);
    // 数据字段不被追改（capturedAt 保留创建时捕获时刻）
    expect(snapshotOf(after).capturedAt).toBe(snapshotOf(before).capturedAt);
    expect(after.createdAt).toBe(before.createdAt);
  });
});

// ---------- ② claim→teacher-disable→feedback ----------

describe("SAI-15 ② 教师关闭：在途回信收存但不向未完成题交付", () => {
  it("领取后关闭→回信：存旧事实（提交前回信），未完成题不新增交付，完成后恢复可见", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = createTask(db, world);
    const claim = claimMcpTask(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(1000) },
    );
    if (claim === null) throw new Error("MCP 领取应成功");

    // 教师动态变更：开放 → 完成后可用（本题仍在作答中）
    setStudentPostSubmitOnly(db, world.studentId);

    // 在途回信收存：写回成功（不拒收、不丢内容）
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
    const replyFact = factsOf(db, task.id).find(
      (f) => f.type === "reply_received",
    );
    if (replyFact === undefined) throw new Error("回信事实未落库");
    expect(replyFact.beforeSubmit).toBe(true); // 旧事实保留提交前阶段

    // 未完成题不新增交付：详情不含回信正文；打开被拒（已展示的内容才保留可见）
    let detail = getStudentAiTaskDetail(db, {
      studentId: world.studentId,
      taskId: task.id,
    });
    expect(detail.task.hasReply).toBe(true);
    expect(detail.messages.every((m) => m.role === "student")).toBe(true);
    expectHttpError(
      () =>
        openStudentAiReply(
          db,
          { studentId: world.studentId, taskId: task.id },
          { now: at(3000) },
        ),
      403,
      "AI_POLICY_DISABLED",
    );

    // 本题完成后按复盘恢复可见（不假装撤回、不丢回信）
    submitAttempt(db, world.studentId, world.attemptId, at(60_000));
    openStudentAiReply(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(70_000) },
    );
    detail = getStudentAiTaskDetail(db, {
      studentId: world.studentId,
      taskId: task.id,
    });
    expect(
      detail.messages.some(
        (m) => m.role === "assistant" && m.contentMd === "AI 回信正文",
      ),
    ).toBe(true);
  });
});

// ---------- ③ teacher-enable：可继续但不自动外发 ----------

describe("SAI-15 ③ 教师重新开放：任务可继续但未自动外发", () => {
  it("关闭期发送被暂停；重新开放后不自动外发（无 dispatched 事实），学生显式恢复才可再发送", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const task = createTask(db, world, { channel: "inapp" });

    // 关闭后发送：403 + 暂停（未外发，无事实漂移）
    setStudentPostSubmitOnly(db, world.studentId);
    expectHttpError(
      () =>
        beginInappDispatch(
          db,
          { studentId: world.studentId, taskId: task.id },
          { now: at(1000) },
        ),
      403,
      "AI_POLICY_DISABLED",
    );
    expect(taskRow(db, task.id).status).toBe("paused");

    // 重新开放：任务可继续（allowedActions 恢复），但不自动外发
    clearStudentOverride(db, world.studentId);
    const row = taskRow(db, task.id);
    expect(row.status).toBe("paused"); // 不因教师切换而自动发送
    const view = listStudentAiTasks(
      db,
      {
        studentId: world.studentId,
        attemptId: world.attemptId,
        limit: 10,
      },
      { now: at(2500) },
    );
    expect(view.tasks[0]?.status).toBe("paused");
    expect(view.tasks[0]?.allowedActions).toEqual(["resume", "cancel"]);
    expect(factsOf(db, task.id).some((f) => f.type === "dispatched")).toBe(
      false,
    ); // 无外发事实 = 没有自动发送

    // 学生显式恢复 → created；再显式发送才进入派发
    resumeAiTask(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(3000) },
    );
    expect(taskRow(db, task.id).status).toBe("created");
    beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(4000) },
    );
    expect(taskRow(db, task.id).status).toBe("dispatching");
  });
});

// ---------- ④ submit 失败→claim：仍按未完成限制 ----------

describe("SAI-15 ④ 提交失败不解锁", () => {
  it("错版提交 409 后 attempt 仍 draft：领取仍按未完成限制；成功提交后才开放复盘", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    // 开放期创建任务，随后教师改为「完成后可用」（作答中禁用）
    const task = createTask(db, world);
    setStudentPostSubmitOnly(db, world.studentId);

    // 提交失败：错版 revision → 409，attempt 保持 draft（提交中途/失败不解锁）
    expectHttpError(
      () =>
        submitAttempt(db, world.studentId, world.attemptId, at(60_000), [
          { questionId: world.questionId, questionRevisionId: "stale-rev" },
        ]),
      409,
      "QUESTION_REVISION_STALE",
    );
    expect(
      db.select().from(attempts).where(eq(attempts.id, world.attemptId)).get()
        ?.status,
    ).toBe("draft");

    // 仍按未完成限制：显式领取 403、FIFO 无可领取
    expectHttpError(
      () =>
        claimMcpTask(
          db,
          { studentId: world.studentId, taskId: task.id },
          { now: at(70_000) },
        ),
      403,
      "AI_POLICY_DISABLED",
    );
    expect(
      claimMcpTask(db, { studentId: world.studentId }, { now: at(71_000) }),
    ).toBeNull();

    // 成功提交（本题完成）后开放复盘：可领取
    submitAttempt(db, world.studentId, world.attemptId, at(80_000));
    const claim = claimMcpTask(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(90_000) },
    );
    expect(claim).not.toBeNull();
  });
});

// ---------- ⑤ lesson 题级解锁与重开新卷 ----------

describe("SAI-15 ⑤ 讲练题级完成与重开新卷", () => {
  it("Q1 提交：Q1 任务按复盘重装配、Q2 任务仍按作答中；重开新卷后旧反馈不能进新 Q1", () => {
    const db = createTestDb();
    const world = setupLessonWorld(db);
    const revisionId = db
      .select()
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, world.attemptId),
          eq(responses.questionId, world.questionId),
        ),
      )
      .get()?.id;
    if (revisionId === undefined) throw new Error("responses 行未落库");

    // 提交前创建 Q1 任务（教师默认开放 → open 作答中模板）
    const t1 = createTask(db, world, {
      questionId: world.questionId,
      channel: "inapp",
    });
    expect(taskRow(db, t1.id).promptHash).toBe(
      freshBundleOf(db, world, world.questionId, 0).promptHash,
    );

    // 真实单题提交 Q1：Q1 完成，Q2 未解
    submitLessonQuestion(
      db,
      world.studentId,
      world.attemptId,
      world.questionId,
      { questionRevisionId: revisionId },
      at(60_000),
    );

    // Q1 外发按复盘重装配；Q2 新建任务仍按作答中装配
    beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: t1.id },
      { now: at(70_000) },
    );
    const freshQ1 = freshBundleOf(db, world, world.questionId, 70_000);
    expect(freshQ1.promptTemplateKey).toBe("review");
    expect(taskRow(db, t1.id).promptHash).toBe(freshQ1.promptHash);

    const t2 = createTask(db, world, {
      questionId: world.questionId2,
      channel: "inapp",
      at: 80_000,
    });
    const freshQ2 = freshBundleOf(db, world, world.questionId2, 80_000);
    expect(freshQ2.promptTemplateKey).toBe("open"); // Q2 未解：不是复盘
    expect(taskRow(db, t2.id).promptHash).toBe(freshQ2.promptHash);

    // Q1 回信在旧卷收到（尚未打开）
    completeInappDispatch(
      db,
      {
        studentId: world.studentId,
        taskId: t1.id,
        generation: taskRow(db, t1.id).generation,
        replyMd: "Q1 旧回信",
      },
      { now: at(90_000) },
    );

    // 重开新卷（restartLessonAttempt 事务语义：作废旧 draft + 开 attemptNo+1
    // 新卷新冻结行；服务级直插同款行，路由语义详测见 student-lesson.test.ts）
    db.update(attempts)
      .set({ abandonedAt: at(100_000).toISOString() })
      .where(eq(attempts.id, world.attemptId))
      .run();
    const newAttemptId = randomUUID();
    db.insert(attempts)
      .values({
        id: newAttemptId,
        studentId: world.studentId,
        sourceType: "lesson",
        assignmentId: null,
        courseId: null,
        unitId: null,
        lectureId: randomUUID(),
        attemptNo: 2,
        status: "draft",
        startedAt: at(100_000).toISOString(),
        frozenAt: at(100_000).toISOString(),
        legacyUnverified: false,
        abandonedAt: null,
      })
      .run();
    insertResponse(db, newAttemptId, world.questionId);

    // 旧反馈不能进新 Q1：新卷任务列表为空；旧任务回信正文因作废不可见；
    // 旧任务打开被拒（作废卷一切读写拒绝）
    const newList = listStudentAiTasks(
      db,
      {
        studentId: world.studentId,
        attemptId: newAttemptId,
        limit: 10,
      },
      { now: at(105_000) },
    );
    expect(newList.tasks).toEqual([]);
    const oldDetail = getStudentAiTaskDetail(db, {
      studentId: world.studentId,
      taskId: t1.id,
    });
    expect(oldDetail.messages.every((m) => m.role === "student")).toBe(true);
    expectHttpError(
      () =>
        openStudentAiReply(
          db,
          { studentId: world.studentId, taskId: t1.id },
          { now: at(110_000) },
        ),
      409,
      "ATTEMPT_ABANDONED",
    );

    // 新卷上重新求助：新任务绑定新卷，与旧任务互不迁移
    const t1b = createTask(db, world, {
      attemptId: newAttemptId,
      questionId: world.questionId,
      at: 120_000,
    });
    expect(t1b.attemptId).toBe(newAttemptId);
    expect(taskRow(db, t1b.id).promptHash).toBe(
      freshBundleOf(db, world, world.questionId, 0, newAttemptId).promptHash, // 新 Q1 未完成：作答中模板
    );
  });
});

// ---------- ⑥ restore 期间 provider 晚到 / 换学生 ----------

describe("SAI-15 ⑥ 运行代际与账号隔离", () => {
  it("restore 重启句柄后 provider 晚到：同 generation 也不放行（不依赖备份内 generation），只落迟到事实", () => {
    const { db, handle } = createFileDb();
    const world = setupWorld(db);
    const task = createTask(db, world, { channel: "inapp" });
    const begin = beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(1000) },
    );

    // 模拟恢复链路第⑥步（restoreFromBackup 换库后 handle.restart 重开连接）：
    // 本测试不换文件内容，generation 与任务行完全一致——只隔离「旧运行代际」
    handle.restart();

    // 迟到回执：generation 匹配也不得写入（运行代际已失效）
    expectHttpError(
      () =>
        completeInappDispatch(
          db,
          {
            studentId: world.studentId,
            taskId: task.id,
            generation: begin.generation,
            replyMd: "恢复后迟到的回信",
            expectedRuntimeEpoch: begin.runtimeEpoch,
          },
          { now: at(90_000) },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    // 回信未入库（无 assistant 消息）；迟到事实保留（审计不丢）
    const row = taskRow(db, task.id);
    expect(row.status).toBe("dispatching");
    expect(
      db
        .select()
        .from(aiMessages)
        .where(
          and(eq(aiMessages.taskId, task.id), eq(aiMessages.role, "assistant")),
        )
        .all(),
    ).toEqual([]);
    const lateFacts = factsOf(db, task.id).filter(
      (f) => f.type === "late_reply",
    );
    expect(lateFacts).toHaveLength(1);

    // 新运行代际正常运转：重启后新建任务的派发拿到新代（配置也经新连接重取）
    const t2 = createTask(db, world, { channel: "inapp", at: 95_000 });
    const fresh = beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: t2.id },
      { now: at(96_000) },
    );
    expect(fresh.runtimeEpoch).not.toBe(begin.runtimeEpoch);
  });

  it("卸载后换学生：在途回执只能回原任务，不能串入新账号", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    const otherStudentId = makeStudent(db);
    const task = createTask(db, world);
    const claim = claimMcpTask(
      db,
      { studentId: world.studentId, taskId: task.id },
      { now: at(1000) },
    );
    if (claim === null) throw new Error("MCP 领取应成功");

    // 换账号后：他人身份对原任务写回/打开/列表都不可达
    expectHttpError(
      () =>
        submitMcpReply(
          db,
          {
            studentId: otherStudentId,
            taskId: task.id,
            leaseToken: claim.leaseToken,
            replyMarkdown: "串号回信",
          },
          { now: at(2000) },
        ),
      404,
      "NOT_FOUND",
    );
    expectHttpError(
      () =>
        openStudentAiReply(db, {
          studentId: otherStudentId,
          taskId: task.id,
        }),
      404,
      "NOT_FOUND",
    );
    expect(
      listStudentAiTasks(
        db,
        { studentId: otherStudentId, limit: 10 },
        { now: at(3000) },
      ).tasks,
    ).toEqual([]);
    expect(
      claimMcpTask(db, { studentId: otherStudentId }, { now: at(3000) }),
    ).toBeNull();

    // 回执只能回到原任务：原学生写回正常，新账号看不到
    submitMcpReply(
      db,
      {
        studentId: world.studentId,
        taskId: task.id,
        leaseToken: claim.leaseToken,
        replyMarkdown: "原任务回信",
      },
      { now: at(4000) },
    );
    const detail = getStudentAiTaskDetail(db, {
      studentId: world.studentId,
      taskId: task.id,
    });
    expect(detail.messages.some((m) => m.contentMd === "原任务回信")).toBe(
      true,
    );
    expectHttpError(
      () =>
        getStudentAiTaskDetail(db, {
          studentId: otherStudentId,
          taskId: task.id,
        }),
      404,
      "NOT_FOUND",
    );
  });
});

// ---------- ⑦ AI 服务失败不阻塞交卷 ----------

describe("SAI-15 ⑦ AI 失败不阻塞交卷、不回滚提交与原稿", () => {
  it("AI 任务失败/进行中时真实交卷照常成功；提交后 AI 再失败也不回滚", () => {
    const db = createTestDb();
    const world = setupWorld(db);
    // 学生作答（真实草稿保存链路；choice 选正确项与夹具快照答案对齐）
    saveDraftAnswer(db, world.studentId, world.attemptId, world.questionId, {
      kind: "choice",
      index: 1,
    });

    // AI 任务一：页内发送网络失败 → failed
    const t1 = createTask(db, world, { channel: "inapp" });
    const begin = beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: t1.id },
      { now: at(1000) },
    );
    failInappDispatch(
      db,
      {
        studentId: world.studentId,
        taskId: t1.id,
        generation: begin.generation,
        errorText: "供应商网络中断",
        kind: "retryable",
      },
      { now: at(2000) },
    );
    // AI 任务二：MCP 领取后仍在途（真实时钟租约，写回同用真实时钟）
    const t2 = createTask(db, world);
    const claim2 = claimMcpTask(db, {
      studentId: world.studentId,
      taskId: t2.id,
    });
    if (claim2 === null) throw new Error("MCP 领取应成功");

    // 真实交卷：判分/状态/答案原稿均不受 AI 任务影响
    const result = submitAttempt(
      db,
      world.studentId,
      world.attemptId,
      at(60_000),
    );
    expect(result.attempt.status).toBe("graded");
    expect(result.summary.correct).toBe(1);
    expect(result.summary.unanswered).toBe(0);

    // 交卷后 AI 各自状态照常处理：failed 可显式重试；在途回信可写回
    retryAiTask(
      db,
      { studentId: world.studentId, taskId: t1.id },
      { now: at(70_000) },
    );
    submitMcpReply(db, {
      studentId: world.studentId,
      taskId: t2.id,
      leaseToken: claim2.leaseToken,
      replyMarkdown: "提交后写回的在途回信",
    });

    // 提交后的 AI 失败也不回滚已成功提交
    const t3 = createTask(db, world, { channel: "inapp", at: 80_000 });
    const begin3 = beginInappDispatch(
      db,
      { studentId: world.studentId, taskId: t3.id },
      { now: at(81_000) },
    );
    failInappDispatch(
      db,
      {
        studentId: world.studentId,
        taskId: t3.id,
        generation: begin3.generation,
        errorText: "提交后再失败",
        kind: "retryable",
      },
      { now: at(82_000) },
    );
    expect(
      db.select().from(attempts).where(eq(attempts.id, world.attemptId)).get()
        ?.status,
    ).toBe("graded");
  });
});
