import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../../db/client.ts";
import {
  aiFacts,
  aiTasks,
  assignments,
  attempts,
  courses,
  lectures,
  responses,
} from "../../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../../db/test-utils.ts";
import {
  expectHttpError,
  insertResponse,
} from "../../test/ai-companion-fixtures.ts";
import { makeStudent } from "../../test/note-fixtures.ts";
import {
  aiQueueSummaryOf,
  archiveAiTask,
  beginInappDispatch,
  cancelAiTask,
  completeInappDispatch,
  createAiTask,
  failInappDispatch,
  listStudentAiTasks,
} from "./student-ai-queue.ts";

/**
 * SAI-23 全局队列服务测试（B12 批次「先测」服务端侧）：
 * - 账号范围列表（无 attempt/question 过滤）附来源摘要 origins——来源/题号
 *   （建卷冻结序）/标题/作答阶段，导航定位键按来源非空；
 * - 归档是队列管理动作：只加在终态（replied/cancelled），status 与已读态
 *   不动（归档≠已读），append-only 记 archived 事实（§9.1 归档不消除事实）；
 * - archived 过滤三态：exclude（默认队列视图）/ only（已归档分组）/ 缺省
 *   全部（单题对话历史不因整理队列而丢记录）。
 */

const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const SECRET = "queue-test-secret-0023";

function at(ms: number): Date {
  return new Date(T0 + ms);
}

function iso(ms: number): string {
  return at(ms).toISOString();
}

/** 插一条指定来源的作答行（assignments/courses/lectures 行按需补最小列） */
function insertSourcedAttempt(
  db: Db,
  row: {
    studentId: string;
    sourceType: "assignment" | "course" | "wrong" | "lesson";
    attemptNo?: number;
    status?: "draft" | "submitted" | "graded";
    title?: string;
  },
): string {
  const id = randomUUID();
  let assignmentId: string | null = null;
  let courseId: string | null = null;
  let lectureId: string | null = null;
  if (row.sourceType === "assignment") {
    assignmentId = randomUUID();
    db.insert(assignments)
      .values({
        id: assignmentId,
        teacherId: TEST_TEACHER_ID,
        title: row.title ?? "期中作业",
        dueAt: null,
        answerRelease: "on_submit",
        createdAt: iso(0),
      })
      .run();
  } else if (row.sourceType === "course") {
    courseId = randomUUID();
    db.insert(courses)
      .values({
        id: courseId,
        teacherId: TEST_TEACHER_ID,
        title: row.title ?? "初二数学",
        order: 1,
        createdAt: iso(0),
      })
      .run();
  } else if (row.sourceType === "lesson") {
    const lessonLectureId = randomUUID();
    lectureId = lessonLectureId;
    db.insert(lectures)
      .values({
        id: lessonLectureId,
        teacherId: TEST_TEACHER_ID,
        title: row.title ?? "二次函数讲练页",
        markdown: "# 讲练页",
        kind: "lesson",
        order: 1,
        updatedAt: iso(0),
      })
      .run();
  }
  db.insert(attempts)
    .values({
      id,
      studentId: row.studentId,
      sourceType: row.sourceType,
      assignmentId,
      courseId,
      unitId: courseId !== null ? "unit-x" : null,
      lectureId,
      attemptNo: row.attemptNo ?? 1,
      status: row.status ?? "draft",
      startedAt: iso(0),
      frozenAt: iso(0),
      legacyUnverified: false,
      abandonedAt: null,
    })
    .run();
  return id;
}

function mkTask(
  db: Db,
  world: { studentId: string; attemptId: string; questionId: string },
  opts?: { at?: number; channel?: "inapp" | "mcp" },
) {
  const { task } = createAiTask(
    db,
    {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: world.questionId,
      question: "请帮我讲解本题",
      channel: opts?.channel ?? "mcp",
      mutationId: randomUUID(),
    },
    { hmacSecret: SECRET, now: at(opts?.at ?? 0) },
  );
  return task;
}

function factsOf(db: Db, taskId: string) {
  return db.select().from(aiFacts).where(eq(aiFacts.taskId, taskId)).all();
}

describe("SAI-23 全局队列与归档", () => {
  it("账号范围列表附来源摘要：来源/题号（建卷冻结序）/标题/作答阶段，他学生不可见", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    // 作业卷三题（q1 q2 q3 依插入序冻结）+ 讲练卷一题
    const assignmentAttempt = insertSourcedAttempt(db, {
      studentId,
      sourceType: "assignment",
      status: "graded",
      title: "期中作业",
    });
    for (const qid of ["q1", "q2", "q3"]) {
      insertResponse(db, assignmentAttempt, qid);
    }
    const lessonAttempt = insertSourcedAttempt(db, {
      studentId,
      sourceType: "lesson",
      attemptNo: 2,
      status: "submitted",
    });
    insertResponse(db, lessonAttempt, "lq1");
    const assignmentWorld = {
      studentId,
      attemptId: assignmentAttempt,
      questionId: "q2",
    };
    const lessonWorld = {
      studentId,
      attemptId: lessonAttempt,
      questionId: "lq1",
    };
    const t2 = mkTask(db, assignmentWorld, { at: 2000 });
    const tLesson = mkTask(db, lessonWorld, { at: 1000 });
    // 他学生任务不进本人列表（账号范围）
    const strangerId = makeStudent(db);
    const strangerAttempt = insertSourcedAttempt(db, {
      studentId: strangerId,
      sourceType: "assignment",
    });
    insertResponse(db, strangerAttempt, "sq1");
    mkTask(
      db,
      { studentId: strangerId, attemptId: strangerAttempt, questionId: "sq1" },
      { at: 999 },
    );

    const page = listStudentAiTasks(db, { studentId, limit: 20 });
    expect(page.tasks.map((t) => t.id)).toEqual([t2.id, tLesson.id]);
    expect(page.origins).toBeDefined();
    expect(page.origins?.[t2.id]).toMatchObject({
      sourceType: "assignment",
      attemptNo: 1,
      questionNo: 2,
      title: "期中作业",
      attemptStatus: "graded",
    });
    expect(page.origins?.[t2.id]?.assignmentId).not.toBeNull();
    expect(page.origins?.[tLesson.id]).toMatchObject({
      sourceType: "lesson",
      attemptNo: 2,
      questionNo: 1,
      title: "二次函数讲练页",
      attemptStatus: "submitted",
    });
    expect(page.origins?.[tLesson.id]?.lectureId).not.toBeNull();
    // wrong 来源无卷标题（null），题号按卷内序
    const wrongAttempt = insertSourcedAttempt(db, {
      studentId,
      sourceType: "wrong",
      attemptNo: 3,
    });
    insertResponse(db, wrongAttempt, "wq1");
    const tWrong = mkTask(
      db,
      { studentId, attemptId: wrongAttempt, questionId: "wq1" },
      { at: 3000 },
    );
    const page2 = listStudentAiTasks(db, { studentId, limit: 20 });
    expect(page2.origins?.[tWrong.id]).toMatchObject({
      sourceType: "wrong",
      title: null,
      questionNo: 1,
    });
  });

  it("题不在本卷行中（软删/缺失）：questionNo 如实为 null，不伪造题号", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    // 已交卷课程卷：requireUsableAttempt 对已交卷课程练习不再校验成员资格
    const attemptId = insertSourcedAttempt(db, {
      studentId,
      sourceType: "course",
      status: "submitted",
    });
    insertResponse(db, attemptId, "q1");
    const task = mkTask(db, { studentId, attemptId, questionId: "q1" });
    db.delete(responses)
      .where(
        and(eq(responses.attemptId, attemptId), eq(responses.questionId, "q1")),
      )
      .run();
    const page = listStudentAiTasks(db, { studentId, limit: 20 });
    expect(page.origins?.[task.id]?.questionNo).toBeNull();
  });

  it("归档：replied 可归档且不改 status/replyDeliveredAt（归档≠已读），记 archived 事实", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const attemptId = insertSourcedAttempt(db, {
      studentId,
      sourceType: "course",
      status: "submitted",
    });
    insertResponse(db, attemptId, "q1");
    const world = { studentId, attemptId, questionId: "q1" };
    const task = mkTask(db, world, { channel: "inapp" });
    const { generation } = beginInappDispatch(
      db,
      { studentId, taskId: task.id },
      { now: at(1000) },
    );
    completeInappDispatch(
      db,
      { studentId, taskId: task.id, generation, replyMd: "讲解" },
      { now: at(2000) },
    );
    const archived = archiveAiTask(
      db,
      { studentId, taskId: task.id },
      { now: at(3000) },
    );
    expect(archived.status).toBe("replied"); // 不是状态转换
    expect(archived.archivedAt).toBe(iso(3000));
    expect(archived.replyDeliveredAt).toBeNull(); // 归档不等于已读
    expect(factsOf(db, task.id).some((fact) => fact.type === "archived")).toBe(
      true,
    );
    // 重复归档幂等（不重复记事实）
    const again = archiveAiTask(
      db,
      { studentId, taskId: task.id },
      { now: at(4000) },
    );
    expect(again.archivedAt).toBe(iso(3000));
    expect(
      factsOf(db, task.id).filter((fact) => fact.type === "archived"),
    ).toHaveLength(1);
    // 他人任务 404 同文案（防枚举）
    const stranger = makeStudent(db);
    expectHttpError(
      () => archiveAiTask(db, { studentId: stranger, taskId: task.id }),
      404,
      "NOT_FOUND",
    );
  });

  it("归档过滤：exclude 隐藏已归档、only 只看已归档、缺省全部（单题历史不受影响）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const attemptId = insertSourcedAttempt(db, {
      studentId,
      sourceType: "wrong",
    });
    insertResponse(db, attemptId, "q1");
    insertResponse(db, attemptId, "q2");
    const world = { studentId, attemptId, questionId: "q1" };
    const t1 = mkTask(db, world, { at: 1000 });
    // t2（q2）走到 replied 再归档
    const t2 = mkTask(
      db,
      { ...world, questionId: "q2" },
      { at: 2000, channel: "inapp" },
    );
    const { generation } = beginInappDispatch(
      db,
      { studentId, taskId: t2.id },
      { now: at(2500) },
    );
    completeInappDispatch(
      db,
      { studentId, taskId: t2.id, generation, replyMd: "讲解" },
      { now: at(3000) },
    );
    archiveAiTask(db, { studentId, taskId: t2.id }, { now: at(4000) });
    // 默认队列视图
    const queue = listStudentAiTasks(db, {
      studentId,
      limit: 20,
      archived: "exclude",
    });
    expect(queue.tasks.map((t) => t.id)).toEqual([t1.id]);
    // 已归档分组
    const archivedOnly = listStudentAiTasks(db, {
      studentId,
      limit: 20,
      archived: "only",
    });
    expect(archivedOnly.tasks.map((t) => t.id)).toEqual([t2.id]);
    // 缺省 = 全部：本题对话历史仍含已归档（对话记录不因整理队列消失）
    const all = listStudentAiTasks(db, { studentId, limit: 20 });
    expect(all.tasks.map((t) => t.id)).toEqual([t2.id, t1.id]);
    // 队列摘要不受归档影响（未读回信仍计数——归档不替学生「已读」）
    expect(aiQueueSummaryOf(db, studentId).unreadReplyCount).toBe(1);
  });

  it("在途/可重试状态不可归档（409）：created 与 failed 拒绝，终态 cancelled 可归档", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const attemptId = insertSourcedAttempt(db, {
      studentId,
      sourceType: "course",
      status: "submitted",
    });
    insertResponse(db, attemptId, "q1");
    insertResponse(db, attemptId, "q2");
    const world = { studentId, attemptId, questionId: "q1" };
    const created = mkTask(db, world);
    expectHttpError(
      () => archiveAiTask(db, { studentId, taskId: created.id }),
      409,
      "AI_STATE_CONFLICT",
    );
    const failedTask = mkTask(
      db,
      { ...world, questionId: "q2" },
      { at: 2000, channel: "inapp" },
    );
    const { generation } = beginInappDispatch(
      db,
      { studentId, taskId: failedTask.id },
      { now: at(2500) },
    );
    failInappDispatch(
      db,
      {
        studentId,
        taskId: failedTask.id,
        generation,
        errorText: "超时",
        kind: "retryable",
      },
      { now: at(3000) },
    );
    expectHttpError(
      () => archiveAiTask(db, { studentId, taskId: failedTask.id }),
      409,
      "AI_STATE_CONFLICT",
    );
    const cancelled = cancelAiTask(
      db,
      { studentId, taskId: created.id },
      { now: at(4000) },
    );
    expect(cancelled.status).toBe("cancelled");
    const archived = archiveAiTask(
      db,
      { studentId, taskId: created.id },
      { now: at(5000) },
    );
    expect(archived.archivedAt).toBe(iso(5000));
    // 终态任务的 allowedActions 含 archive；可重试任务不含
    const page = listStudentAiTasks(db, { studentId, limit: 20 });
    const byId = new Map(page.tasks.map((t) => [t.id, t]));
    expect(byId.get(cancelled.id)?.allowedActions).toContain("archive");
    expect(byId.get(failedTask.id)?.allowedActions).not.toContain("archive");
  });

  it("任务行携带 archivedAt 列（迁移 0037）：直插行可读回", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    // draft 课程卷要走 requireVisibleCourseUnit 的成员/目录校验（本测试意图
    // 只是列往返，与课程可见性无关）——用无卷来源直接建任务
    const attemptId = insertSourcedAttempt(db, {
      studentId,
      sourceType: "wrong",
    });
    insertResponse(db, attemptId, "q1");
    const task = mkTask(db, { studentId, attemptId, questionId: "q1" });
    db.update(aiTasks)
      .set({ archivedAt: iso(100) })
      .where(eq(aiTasks.id, task.id))
      .run();
    const row = db.select().from(aiTasks).where(eq(aiTasks.id, task.id)).get();
    expect(row?.archivedAt).toBe(iso(100));
  });
});
