import { randomUUID } from "node:crypto";
import type {
  AiPolicyInheritableMode,
  AiPolicyReason,
  AiTeachingMode,
} from "@tutor/contract";
import {
  aiPolicyResolutionSchema,
  DEFAULT_AI_TEACHER_MODE,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../../db/client.ts";
import {
  aiPolicyOverrides,
  aiTeacherSettings,
  assignments,
  attempts,
  courseStudents,
  courses,
  responses,
  students,
  teachers,
} from "../../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../../db/test-utils.ts";
import { HttpError } from "../../lib/http-error.ts";
import { makeStudent } from "../../test/note-fixtures.ts";
import { answersReleased } from "../attempt-service.ts";
import { sqliteAiPolicyConfigSource } from "./ai-policy-config-source.ts";
import {
  type AiPolicyConfigSource,
  questionPhaseOf,
  resolveAiPolicy,
  resolveAttemptQuestionAiPolicy,
} from "./teaching-policy-service.ts";

/**
 * SAI-04 统一教学策略裁决测试（B02；技术方案 §2 两步合并算法 + §2.3 阶段识别）。
 *
 * 覆盖（批次失败测试矩阵逐条 + §2.2 关键真值行）：
 * - 纯函数 48 组合参数化全覆盖（教师 3 × 学生 4 × 作业 4，作答中）；
 *   明确关闭不可被另一开放覆盖（关闭优先级：学生 > 作业 > 教师默认继承）；
 * - 完成态恒 open_study 复盘（含全部明确关闭组合——作答中不可用完成后自动开放）；
 * - 四来源完成判定：assignment/course/wrong 按 attempt.status（M4-D1 起 v1
 *   逐题卷例外，按行级 submittedAt）、lesson 按题级 submittedAt；
 *   过截止不算完成；wrong/重开新卷不继承以前完成；
 * - 统一入口：归属/越权/作废/课程失权沿用 requireUsableAttempt 口径，
 *   双教师同 questionId 与跨学生按 (attemptId, questionId) 冻结行隔离；
 * - AI 复盘与 answersReleased 相互独立（已交卷未到公布时间仍可复盘，
 *   且原 answersReleased 函数行为未被改动）。
 *
 * 配置来源以夹具注入（AI 配置表 SAI-05 才建）；全部时间为固定常量，
 * 纯函数不读库不读全局时钟。
 */

const NOW = "2026-06-01T00:00:00.000Z";
const FROZEN_AT = "2026-05-01T00:00:00.000Z";

// ---------- 夹具：直插行（内存库，与生产建卷形态一致——frozenAt 建卷即写） ----------

function insertAttempt(
  db: Db,
  row: {
    studentId: string;
    sourceType?: "assignment" | "course" | "wrong" | "lesson";
    status?: "draft" | "submitted" | "graded";
    assignmentId?: string | null;
    courseId?: string | null;
    unitId?: string | null;
    lectureId?: string | null;
    abandonedAt?: string | null;
    /** M4-D1：新协议卷工作流列（缺省不写 = 历史旧协议卷，两列恒 null） */
    practiceWorkflowVersion?: 1;
    feedbackMode?: "per_question" | "after_attempt";
  },
): string {
  const id = randomUUID();
  db.insert(attempts)
    .values({
      id,
      studentId: row.studentId,
      sourceType: row.sourceType ?? "assignment",
      assignmentId: row.assignmentId ?? null,
      courseId: row.courseId ?? null,
      unitId: row.unitId ?? null,
      lectureId: row.lectureId ?? null,
      attemptNo: 1,
      status: row.status ?? "draft",
      startedAt: NOW,
      frozenAt: FROZEN_AT,
      legacyUnverified: false,
      abandonedAt: row.abandonedAt ?? null,
      ...(row.practiceWorkflowVersion !== undefined && {
        practiceWorkflowVersion: row.practiceWorkflowVersion,
      }),
      ...(row.feedbackMode !== undefined && { feedbackMode: row.feedbackMode }),
    })
    .run();
  return id;
}

/** M2 单题提交的行级事实（responses.submittedAt 落值；attempt 保持 draft） */
function markResponseSubmitted(
  db: Db,
  attemptId: string,
  questionId: string,
): void {
  db.update(responses)
    .set({ submittedAt: NOW })
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .run();
}

function insertResponse(
  db: Db,
  attemptId: string,
  questionId: string,
  opts?: { submittedAt?: string | null },
): string {
  const id = randomUUID();
  db.insert(responses)
    .values({
      id,
      attemptId,
      questionId,
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: JSON.stringify({ id: questionId }),
      submittedAt: opts?.submittedAt ?? null,
    })
    .run();
  return id;
}

function insertAssignment(
  db: Db,
  opts?: {
    dueAt?: string | null;
    answerRelease?: "on_submit" | "after_due";
    teacherId?: string;
  },
): string {
  const id = randomUUID();
  db.insert(assignments)
    .values({
      id,
      teacherId: opts?.teacherId ?? TEST_TEACHER_ID,
      title: "作业",
      dueAt: opts?.dueAt ?? null,
      answerRelease: opts?.answerRelease ?? "on_submit",
      createdAt: NOW,
    })
    .run();
  return id;
}

function insertTeacher(db: Db, loginName: string): string {
  const id = randomUUID();
  db.insert(teachers)
    .values({
      id,
      loginName,
      isAdmin: false,
      disabledAt: null,
      passwordHash: null,
      apiToken: null,
      createdAt: NOW,
    })
    .run();
  return id;
}

function insertCourse(db: Db, opts?: { archivedAt?: string | null }): string {
  const id = randomUUID();
  db.insert(courses)
    .values({
      id,
      teacherId: TEST_TEACHER_ID,
      title: "课程",
      order: 0,
      archivedAt: opts?.archivedAt ?? null,
      createdAt: NOW,
    })
    .run();
  return id;
}

function addCourseMember(db: Db, courseId: string, studentId: string): void {
  db.insert(courseStudents)
    .values({ courseId, studentId, joinedAt: NOW })
    .run();
}

/** 配置来源测试夹具：内存 Map 实现 SAI-04 定义的读取接口（无行 = 默认/继承语义） */
class FakeConfigSource implements AiPolicyConfigSource {
  readonly teacherDefaults = new Map<string, AiTeachingMode>();
  readonly studentOverrides = new Map<string, AiPolicyInheritableMode>();
  readonly assignmentOverrides = new Map<string, AiPolicyInheritableMode>();
  /** 记录作业覆盖读取（锁定非 assignment 来源恒不查作业覆盖） */
  readonly assignmentReads: string[] = [];

  teacherDefaultMode(_db: Db, teacherId: string): AiTeachingMode {
    return this.teacherDefaults.get(teacherId) ?? DEFAULT_AI_TEACHER_MODE;
  }

  studentOverrideMode(_db: Db, studentId: string): AiPolicyInheritableMode {
    return this.studentOverrides.get(studentId) ?? "inherit";
  }

  assignmentOverrideMode(
    _db: Db,
    assignmentId: string,
  ): AiPolicyInheritableMode {
    this.assignmentReads.push(assignmentId);
    return this.assignmentOverrides.get(assignmentId) ?? "inherit";
  }
}

function expectHttpError(
  fn: () => unknown,
  status: number,
  code: string,
): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const httpError = error as HttpError;
    expect(httpError.status).toBe(status);
    expect(httpError.code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 HttpError ${status} ${code}，实际未抛出`);
}

// ---------- 纯函数 48 组合期望表（技术方案 §2.2 两步算法的规范期望，硬编码独立于实现） ----------

interface ExpectedResolution {
  usable: boolean;
  mode?: AiTeachingMode;
  reason: AiPolicyReason;
}

/** 键 = `${teacherDefault}|${studentMode}|${assignmentMode}`（completed=false 作答中矩阵） */
const ANSWERING_TABLE: Record<string, ExpectedResolution> = {
  // 教师默认 open_study
  "open_study|inherit|inherit": {
    usable: true,
    mode: "open_study",
    reason: "teacher_default",
  },
  "open_study|inherit|open_study": {
    usable: true,
    mode: "open_study",
    reason: "assignment_override",
  },
  "open_study|inherit|guided_only": {
    usable: true,
    mode: "guided_only",
    reason: "assignment_override",
  },
  "open_study|inherit|post_submit_only": {
    usable: false,
    reason: "assignment_closed",
  },
  "open_study|open_study|inherit": {
    usable: true,
    mode: "open_study",
    reason: "student_override",
  },
  "open_study|open_study|open_study": {
    usable: true,
    mode: "open_study",
    reason: "assignment_override",
  },
  "open_study|open_study|guided_only": {
    usable: true,
    mode: "guided_only",
    reason: "assignment_override",
  },
  "open_study|open_study|post_submit_only": {
    usable: false,
    reason: "assignment_closed",
  },
  "open_study|guided_only|inherit": {
    usable: true,
    mode: "guided_only",
    reason: "student_override",
  },
  "open_study|guided_only|open_study": {
    usable: true,
    mode: "open_study",
    reason: "assignment_override",
  },
  "open_study|guided_only|guided_only": {
    usable: true,
    mode: "guided_only",
    reason: "assignment_override",
  },
  "open_study|guided_only|post_submit_only": {
    usable: false,
    reason: "assignment_closed",
  },
  "open_study|post_submit_only|inherit": {
    usable: false,
    reason: "student_closed",
  },
  "open_study|post_submit_only|open_study": {
    usable: false,
    reason: "student_closed",
  },
  "open_study|post_submit_only|guided_only": {
    usable: false,
    reason: "student_closed",
  },
  "open_study|post_submit_only|post_submit_only": {
    usable: false,
    reason: "student_closed",
  },
  // 教师默认 guided_only
  "guided_only|inherit|inherit": {
    usable: true,
    mode: "guided_only",
    reason: "teacher_default",
  },
  "guided_only|inherit|open_study": {
    usable: true,
    mode: "open_study",
    reason: "assignment_override",
  },
  "guided_only|inherit|guided_only": {
    usable: true,
    mode: "guided_only",
    reason: "assignment_override",
  },
  "guided_only|inherit|post_submit_only": {
    usable: false,
    reason: "assignment_closed",
  },
  "guided_only|open_study|inherit": {
    usable: true,
    mode: "open_study",
    reason: "student_override",
  },
  "guided_only|open_study|open_study": {
    usable: true,
    mode: "open_study",
    reason: "assignment_override",
  },
  "guided_only|open_study|guided_only": {
    usable: true,
    mode: "guided_only",
    reason: "assignment_override",
  },
  "guided_only|open_study|post_submit_only": {
    usable: false,
    reason: "assignment_closed",
  },
  "guided_only|guided_only|inherit": {
    usable: true,
    mode: "guided_only",
    reason: "student_override",
  },
  "guided_only|guided_only|open_study": {
    usable: true,
    mode: "open_study",
    reason: "assignment_override",
  },
  "guided_only|guided_only|guided_only": {
    usable: true,
    mode: "guided_only",
    reason: "assignment_override",
  },
  "guided_only|guided_only|post_submit_only": {
    usable: false,
    reason: "assignment_closed",
  },
  "guided_only|post_submit_only|inherit": {
    usable: false,
    reason: "student_closed",
  },
  "guided_only|post_submit_only|open_study": {
    usable: false,
    reason: "student_closed",
  },
  "guided_only|post_submit_only|guided_only": {
    usable: false,
    reason: "student_closed",
  },
  "guided_only|post_submit_only|post_submit_only": {
    usable: false,
    reason: "student_closed",
  },
  // 教师默认 post_submit_only
  "post_submit_only|inherit|inherit": {
    usable: false,
    reason: "teacher_default_closed",
  },
  "post_submit_only|inherit|open_study": {
    usable: true,
    mode: "open_study",
    reason: "assignment_override",
  },
  "post_submit_only|inherit|guided_only": {
    usable: true,
    mode: "guided_only",
    reason: "assignment_override",
  },
  "post_submit_only|inherit|post_submit_only": {
    usable: false,
    reason: "assignment_closed",
  },
  "post_submit_only|open_study|inherit": {
    usable: true,
    mode: "open_study",
    reason: "student_override",
  },
  "post_submit_only|open_study|open_study": {
    usable: true,
    mode: "open_study",
    reason: "assignment_override",
  },
  "post_submit_only|open_study|guided_only": {
    usable: true,
    mode: "guided_only",
    reason: "assignment_override",
  },
  "post_submit_only|open_study|post_submit_only": {
    usable: false,
    reason: "assignment_closed",
  },
  "post_submit_only|guided_only|inherit": {
    usable: true,
    mode: "guided_only",
    reason: "student_override",
  },
  "post_submit_only|guided_only|open_study": {
    usable: true,
    mode: "open_study",
    reason: "assignment_override",
  },
  "post_submit_only|guided_only|guided_only": {
    usable: true,
    mode: "guided_only",
    reason: "assignment_override",
  },
  "post_submit_only|guided_only|post_submit_only": {
    usable: false,
    reason: "assignment_closed",
  },
  "post_submit_only|post_submit_only|inherit": {
    usable: false,
    reason: "student_closed",
  },
  "post_submit_only|post_submit_only|open_study": {
    usable: false,
    reason: "student_closed",
  },
  "post_submit_only|post_submit_only|guided_only": {
    usable: false,
    reason: "student_closed",
  },
  "post_submit_only|post_submit_only|post_submit_only": {
    usable: false,
    reason: "student_closed",
  },
};

const TEACHER_MODES: AiTeachingMode[] = [
  "open_study",
  "guided_only",
  "post_submit_only",
];
const INHERITABLE_MODES: AiPolicyInheritableMode[] = [
  "inherit",
  "open_study",
  "guided_only",
  "post_submit_only",
];

describe("resolveAiPolicy 纯函数（两步合并算法，技术方案 §2.2）", () => {
  it("作答中 48 组合参数化全覆盖（教师 3 × 学生 4 × 作业 4），结果均为确定值且符合契约", () => {
    for (const teacherDefault of TEACHER_MODES) {
      for (const studentMode of INHERITABLE_MODES) {
        for (const assignmentMode of INHERITABLE_MODES) {
          const key = `${teacherDefault}|${studentMode}|${assignmentMode}`;
          const expected = ANSWERING_TABLE[key];
          if (expected === undefined) {
            throw new Error(`期望表缺少组合 ${key}`);
          }
          const resolution = resolveAiPolicy({
            teacherDefault,
            studentMode,
            assignmentMode,
            completed: false,
          });
          expect(resolution, key).toEqual(expected);
          // 输出结构必须通过 B01 契约（usable=false 不携带 mode、true 必带）
          expect(
            () => aiPolicyResolutionSchema.parse(resolution),
            key,
          ).not.toThrow();
        }
      }
    }
    expect(Object.keys(ANSWERING_TABLE)).toHaveLength(48);
  });

  it("关键真值行与技术方案 §2.2 表逐行对应", () => {
    // #1 教师默认 open，全继承 → open_study / 教师默认
    expect(
      resolveAiPolicy({
        teacherDefault: "open_study",
        studentMode: "inherit",
        assignmentMode: "inherit",
        completed: false,
      }),
    ).toEqual({
      usable: true,
      mode: "open_study",
      reason: "teacher_default",
    });
    // #2 教师默认 guided，全继承 → guided_only / 教师默认
    expect(
      resolveAiPolicy({
        teacherDefault: "guided_only",
        studentMode: "inherit",
        assignmentMode: "inherit",
        completed: false,
      }),
    ).toEqual({
      usable: true,
      mode: "guided_only",
      reason: "teacher_default",
    });
    // #3 教师默认 post，全继承 → 作答中不可用（继承 ≠ 明确 open）
    expect(
      resolveAiPolicy({
        teacherDefault: "post_submit_only",
        studentMode: "inherit",
        assignmentMode: "inherit",
        completed: false,
      }),
    ).toEqual({ usable: false, reason: "teacher_default_closed" });
    // #4 作业明确 open 覆盖学生 guided → open_study / 作业覆盖
    expect(
      resolveAiPolicy({
        teacherDefault: "open_study",
        studentMode: "guided_only",
        assignmentMode: "open_study",
        completed: false,
      }),
    ).toEqual({
      usable: true,
      mode: "open_study",
      reason: "assignment_override",
    });
    // #5 学生明确 post，作业 open 不能绕过 → 不可用 / 学生明确关闭
    expect(
      resolveAiPolicy({
        teacherDefault: "open_study",
        studentMode: "post_submit_only",
        assignmentMode: "open_study",
        completed: false,
      }),
    ).toEqual({ usable: false, reason: "student_closed" });
    // #6 作业明确 post → 不可用 / 作业明确关闭
    expect(
      resolveAiPolicy({
        teacherDefault: "open_study",
        studentMode: "open_study",
        assignmentMode: "post_submit_only",
        completed: false,
      }),
    ).toEqual({ usable: false, reason: "assignment_closed" });
    // #7 学生显式 open 覆盖教师默认 post → open_study / 学生显式覆盖
    expect(
      resolveAiPolicy({
        teacherDefault: "post_submit_only",
        studentMode: "open_study",
        assignmentMode: "inherit",
        completed: false,
      }),
    ).toEqual({
      usable: true,
      mode: "open_study",
      reason: "student_override",
    });
  });

  it("多来源同时关闭时 reason 取最具体来源（学生 > 作业 > 教师默认）", () => {
    // 学生 + 作业都明确关闭 → 标注学生（最具体、不可被绕过的主要责任来源）
    expect(
      resolveAiPolicy({
        teacherDefault: "post_submit_only",
        studentMode: "post_submit_only",
        assignmentMode: "post_submit_only",
        completed: false,
      }),
    ).toEqual({ usable: false, reason: "student_closed" });
    // 作业明确关闭 + 教师默认也关闭 → 标注作业（显式优先于继承默认）
    expect(
      resolveAiPolicy({
        teacherDefault: "post_submit_only",
        studentMode: "inherit",
        assignmentMode: "post_submit_only",
        completed: false,
      }),
    ).toEqual({ usable: false, reason: "assignment_closed" });
    // 全继承 + 教师默认关闭 → 标注教师默认继承生效
    expect(
      resolveAiPolicy({
        teacherDefault: "post_submit_only",
        studentMode: "inherit",
        assignmentMode: "inherit",
        completed: false,
      }),
    ).toEqual({ usable: false, reason: "teacher_default_closed" });
  });

  it("本题完成后一律 open_study 复盘（48 组合全部覆盖，含明确关闭组合）", () => {
    for (const teacherDefault of TEACHER_MODES) {
      for (const studentMode of INHERITABLE_MODES) {
        for (const assignmentMode of INHERITABLE_MODES) {
          const key = `${teacherDefault}|${studentMode}|${assignmentMode}`;
          const resolution = resolveAiPolicy({
            teacherDefault,
            studentMode,
            assignmentMode,
            completed: true,
          });
          // 作答中不可用的题在完成后自动开放复盘，无需重连（需求 §2.1 表末行）
          expect(resolution, key).toEqual({
            usable: true,
            mode: "open_study",
            reason: "completed",
          });
          expect(() =>
            aiPolicyResolutionSchema.parse(resolution),
          ).not.toThrow();
        }
      }
    }
  });
});

describe("questionPhaseOf 四来源完成判定（技术方案 §2.3）", () => {
  it("assignment：draft 不算完成，submitted / graded 算完成", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const draft = insertAttempt(db, { studentId, status: "draft" });
    insertResponse(db, draft, "q1");
    expect(questionPhaseOf(db, attemptRow(db, draft), "q1")).toBe("answering");

    const submitted = insertAttempt(db, { studentId, status: "submitted" });
    insertResponse(db, submitted, "q1");
    expect(questionPhaseOf(db, attemptRow(db, submitted), "q1")).toBe(
      "completed",
    );

    const graded = insertAttempt(db, { studentId, status: "graded" });
    insertResponse(db, graded, "q1");
    expect(questionPhaseOf(db, attemptRow(db, graded), "q1")).toBe("completed");
    db.$client.close();
  });

  it("assignment：未交卷已过截止时间仍不算完成（截止不等于交卷）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const assignmentId = insertAssignment(db, {
      dueAt: "2026-01-01T00:00:00.000Z",
      answerRelease: "after_due",
    });
    const draftId = insertAttempt(db, {
      studentId,
      assignmentId,
      status: "draft",
    });
    insertResponse(db, draftId, "q1");
    const nowPastDue = "2026-06-01T00:00:00.000Z";
    expect(questionPhaseOf(db, attemptRow(db, draftId), "q1")).toBe(
      "answering",
    );
    // 对照：普通答案公布口径此时已公布，但 AI 完成判定不读时钟（状态口径）
    expect(answersReleased(assignmentRow(db, assignmentId), nowPastDue)).toBe(
      true,
    );
    db.$client.close();
  });

  it("course：按本次 attempt 状态判定（draft 未完成，submitted 完成）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const courseId = insertCourse(db);
    const draft = insertAttempt(db, {
      studentId,
      sourceType: "course",
      courseId,
      unitId: "unit-1",
      status: "draft",
    });
    insertResponse(db, draft, "q1");
    expect(questionPhaseOf(db, attemptRow(db, draft), "q1")).toBe("answering");

    const submitted = insertAttempt(db, {
      studentId,
      sourceType: "course",
      courseId,
      unitId: "unit-1",
      status: "submitted",
    });
    insertResponse(db, submitted, "q1");
    expect(questionPhaseOf(db, attemptRow(db, submitted), "q1")).toBe(
      "completed",
    );
    db.$client.close();
  });

  it("v1 after_attempt 卷与历史卷不读行级 submittedAt：draft 卷即使行带值也按整卷状态判定", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    // M4-D1 改写（原防御用例「非 lesson 来源不读行级」随协议演进收窄）：行级
    // submittedAt 口径只升 v1 逐题卷；v1 after_attempt 卷与历史旧协议卷
    //（整卷链路）仍只看 attempt.status——行级残留值不改变整卷语义
    const afterAttempt = insertAttempt(db, {
      studentId,
      practiceWorkflowVersion: 1,
      feedbackMode: "after_attempt",
      status: "draft",
    });
    insertResponse(db, afterAttempt, "q1", { submittedAt: NOW });
    expect(questionPhaseOf(db, attemptRow(db, afterAttempt), "q1")).toBe(
      "answering",
    );
    const legacy = insertAttempt(db, { studentId, status: "draft" });
    insertResponse(db, legacy, "q2", { submittedAt: NOW });
    expect(questionPhaseOf(db, attemptRow(db, legacy), "q2")).toBe("answering");
    db.$client.close();
  });

  it("v1 逐题卷按行级 submittedAt 判完成：本题提交即完成，邻题提交不解锁本题", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const attemptId = insertAttempt(db, {
      studentId,
      practiceWorkflowVersion: 1,
      feedbackMode: "per_question",
      status: "draft",
    });
    insertResponse(db, attemptId, "q1", { submittedAt: NOW });
    insertResponse(db, attemptId, "q2");
    // 已单题提交的本题 → 完成（与 lesson 同语义）
    expect(questionPhaseOf(db, attemptRow(db, attemptId), "q1")).toBe(
      "completed",
    );
    // 邻题未提交 → 未完成（一题提交不开放整卷；已选选项/切题不写行值）
    expect(questionPhaseOf(db, attemptRow(db, attemptId), "q2")).toBe(
      "answering",
    );
    db.$client.close();
  });

  it("v1 逐题卷行级为唯一口径（防御：整卷收尾必写行，此处锁口径）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    // 构造防御性行：status=submitted 但该行 submittedAt 为 null（正常不可达
    // ——整卷收尾对剩余行写交卷时刻；口径与 lesson 一致，按题级行值锁定）
    const attemptId = insertAttempt(db, {
      studentId,
      practiceWorkflowVersion: 1,
      feedbackMode: "per_question",
      status: "submitted",
    });
    insertResponse(db, attemptId, "q-late");
    expect(questionPhaseOf(db, attemptRow(db, attemptId), "q-late")).toBe(
      "answering",
    );
    // 对照：行带值的题 → 完成
    insertResponse(db, attemptId, "q-done", { submittedAt: NOW });
    expect(questionPhaseOf(db, attemptRow(db, attemptId), "q-done")).toBe(
      "completed",
    );
    db.$client.close();
  });

  it("v1 逐题卷三来源（assignment/course/wrong）行级判定统一生效", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const courseId = insertCourse(db);
    for (const sourceType of ["assignment", "course", "wrong"] as const) {
      const attemptId = insertAttempt(db, {
        studentId,
        sourceType,
        assignmentId: sourceType === "assignment" ? insertAssignment(db) : null,
        courseId: sourceType === "course" ? courseId : null,
        unitId: sourceType === "course" ? "unit-1" : null,
        practiceWorkflowVersion: 1,
        feedbackMode: "per_question",
        status: "draft",
      });
      insertResponse(db, attemptId, "q1", { submittedAt: NOW });
      insertResponse(db, attemptId, "q2");
      expect(
        questionPhaseOf(db, attemptRow(db, attemptId), "q1"),
        sourceType,
      ).toBe("completed");
      expect(
        questionPhaseOf(db, attemptRow(db, attemptId), "q2"),
        sourceType,
      ).toBe("answering");
    }
    db.$client.close();
  });

  it("wrong：每次 attemptNo 新卷独立判定，不继承以前完成", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    // 旧卷：已提交（以前完成）
    const oldAttempt = insertAttempt(db, {
      studentId,
      sourceType: "wrong",
      status: "submitted",
    });
    insertResponse(db, oldAttempt, "q1", { submittedAt: NOW });
    expect(questionPhaseOf(db, attemptRow(db, oldAttempt), "q1")).toBe(
      "completed",
    );
    // 新卷（重练同一题）：draft → 未完成，即使旧卷已提交
    const newAttempt = insertAttempt(db, {
      studentId,
      sourceType: "wrong",
      status: "draft",
    });
    insertResponse(db, newAttempt, "q1");
    expect(questionPhaseOf(db, attemptRow(db, newAttempt), "q1")).toBe(
      "answering",
    );
    db.$client.close();
  });

  it("lesson：按题级 submittedAt 判定，邻题提交不解锁本题", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const attemptId = insertAttempt(db, {
      studentId,
      sourceType: "lesson",
      lectureId: "lec-1",
      status: "draft",
    });
    insertResponse(db, attemptId, "q1", { submittedAt: NOW });
    insertResponse(db, attemptId, "q2");
    // 已提交当题 → 完成
    expect(questionPhaseOf(db, attemptRow(db, attemptId), "q1")).toBe(
      "completed",
    );
    // 邻题已提交但本题未提交 → 仍未完成（不会一题提交开放整讲义）
    expect(questionPhaseOf(db, attemptRow(db, attemptId), "q2")).toBe(
      "answering",
    );
    db.$client.close();
  });

  it("lesson：以行级 submittedAt 为题级唯一口径（防御：整卷收尾必写行，此处锁口径）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    // 构造防御性行：status=submitted 但该行 submittedAt 为 null（正常不可达——
    // 整卷收尾对剩余行写交卷时刻；口径按题级行值锁定，不受 attempt 级状态影响）
    const attemptId = insertAttempt(db, {
      studentId,
      sourceType: "lesson",
      lectureId: "lec-1",
      status: "submitted",
    });
    insertResponse(db, attemptId, "q-late");
    expect(questionPhaseOf(db, attemptRow(db, attemptId), "q-late")).toBe(
      "answering",
    );
    db.$client.close();
  });

  it("题目不在本卷 responses 行 → 404 QUESTION_NOT_FOUND（全来源统一）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const attemptId = insertAttempt(db, { studentId, status: "draft" });
    insertResponse(db, attemptId, "q1");
    expectHttpError(
      () => questionPhaseOf(db, attemptRow(db, attemptId), "q-other"),
      404,
      "QUESTION_NOT_FOUND",
    );
    db.$client.close();
  });
});

describe("resolveAttemptQuestionAiPolicy 统一入口（多出口共用）", () => {
  it("正常路径：全继承默认 → teacher_default / open_study，未完成", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const assignmentId = insertAssignment(db);
    const attemptId = insertAttempt(db, { studentId, assignmentId });
    const responseId = insertResponse(db, attemptId, "q1");
    const result = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      "q1",
      new FakeConfigSource(),
    );
    expect(result.completed).toBe(false);
    expect(result.resolution).toEqual({
      usable: true,
      mode: "open_study",
      reason: "teacher_default",
    });
    // responseId 即 questionRevisionId（通道创建 SAI-12 复用，不另查）
    expect(result.responseId).toBe(responseId);
    db.$client.close();
  });

  it("三层配置注入生效：学生明确关闭优先于作业开放", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const assignmentId = insertAssignment(db);
    const attemptId = insertAttempt(db, { studentId, assignmentId });
    insertResponse(db, attemptId, "q1");
    const config = new FakeConfigSource();
    config.teacherDefaults.set(TEST_TEACHER_ID, "open_study");
    config.studentOverrides.set(studentId, "post_submit_only");
    config.assignmentOverrides.set(assignmentId, "open_study");
    const result = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      "q1",
      config,
    );
    expect(result.resolution).toEqual({
      usable: false,
      reason: "student_closed",
    });
    db.$client.close();
  });

  it("归属拒绝：attempt 不存在 404，他人 attempt 403 FORBIDDEN", () => {
    const db = createTestDb();
    const studentA = makeStudent(db);
    const studentB = makeStudent(db);
    const attemptB = insertAttempt(db, { studentId: studentB });
    insertResponse(db, attemptB, "q1");
    expectHttpError(
      () =>
        resolveAttemptQuestionAiPolicy(
          db,
          studentA,
          randomUUID(),
          "q1",
          new FakeConfigSource(),
        ),
      404,
      "ATTEMPT_NOT_FOUND",
    );
    // 跨学生 response：A 用 B 的 attemptId 一并被归属拒绝（不读到 B 的冻结行）
    expectHttpError(
      () =>
        resolveAttemptQuestionAiPolicy(
          db,
          studentA,
          attemptB,
          "q1",
          new FakeConfigSource(),
        ),
      403,
      "FORBIDDEN",
    );
    db.$client.close();
  });

  it("作废卷拒绝：409 ATTEMPT_ABANDONED（讲练重开后旧卷一切 AI 读写拒绝）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const oldAttempt = insertAttempt(db, {
      studentId,
      sourceType: "lesson",
      lectureId: "lec-1",
      abandonedAt: NOW,
    });
    insertResponse(db, oldAttempt, "q1", { submittedAt: NOW });
    expectHttpError(
      () =>
        resolveAttemptQuestionAiPolicy(
          db,
          studentId,
          oldAttempt,
          "q1",
          new FakeConfigSource(),
        ),
      409,
      "ATTEMPT_ABANDONED",
    );
    db.$client.close();
  });

  it("讲练重开新卷不继承：新卷未提交题按作答中裁决", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    // 旧卷已作废（见上一用例拒绝），新卷重开同一讲义
    insertAttempt(db, {
      studentId,
      sourceType: "lesson",
      lectureId: "lec-1",
      abandonedAt: NOW,
    });
    const newAttempt = insertAttempt(db, {
      studentId,
      sourceType: "lesson",
      lectureId: "lec-1",
    });
    insertResponse(db, newAttempt, "q1");
    const config = new FakeConfigSource();
    config.teacherDefaults.set(TEST_TEACHER_ID, "post_submit_only");
    const result = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      newAttempt,
      "q1",
      config,
    );
    // 新卷该题未提交：不继承旧卷完成态，按作答中矩阵（教师默认关闭 → 不可用）
    expect(result.completed).toBe(false);
    expect(result.resolution).toEqual({
      usable: false,
      reason: "teacher_default_closed",
    });
    db.$client.close();
  });

  it("课程失权拒绝：非成员 / 学生已归档 / 课程已归档均 403 COURSE_ACCESS_DENIED（沿用 requireUsableAttempt）", () => {
    const db = createTestDb();
    // 非成员
    const stranger = makeStudent(db);
    const courseId = insertCourse(db);
    const strangerAttempt = insertAttempt(db, {
      studentId: stranger,
      sourceType: "course",
      courseId,
      unitId: "unit-1",
      status: "draft",
    });
    insertResponse(db, strangerAttempt, "q1");
    expectHttpError(
      () =>
        resolveAttemptQuestionAiPolicy(
          db,
          stranger,
          strangerAttempt,
          "q1",
          new FakeConfigSource(),
        ),
      403,
      "COURSE_ACCESS_DENIED",
    );
    // 学生已归档（曾是成员）
    const archivedStudent = makeStudent(db);
    addCourseMember(db, courseId, archivedStudent);
    db.update(students)
      .set({ archivedAt: NOW })
      .where(eq(students.id, archivedStudent))
      .run();
    const archivedAttempt = insertAttempt(db, {
      studentId: archivedStudent,
      sourceType: "course",
      courseId,
      unitId: "unit-1",
      status: "draft",
    });
    insertResponse(db, archivedAttempt, "q1");
    expectHttpError(
      () =>
        resolveAttemptQuestionAiPolicy(
          db,
          archivedStudent,
          archivedAttempt,
          "q1",
          new FakeConfigSource(),
        ),
      403,
      "COURSE_ACCESS_DENIED",
    );
    // 课程已归档（仍是成员）
    const memberStudent = makeStudent(db);
    const archivedCourseId = insertCourse(db, { archivedAt: NOW });
    addCourseMember(db, archivedCourseId, memberStudent);
    const memberAttempt = insertAttempt(db, {
      studentId: memberStudent,
      sourceType: "course",
      courseId: archivedCourseId,
      unitId: "unit-1",
      status: "draft",
    });
    insertResponse(db, memberAttempt, "q1");
    expectHttpError(
      () =>
        resolveAttemptQuestionAiPolicy(
          db,
          memberStudent,
          memberAttempt,
          "q1",
          new FakeConfigSource(),
        ),
      403,
      "COURSE_ACCESS_DENIED",
    );
    db.$client.close();
  });

  it("双教师同 questionId：各自 attempt 冻结行互不串（复合主键域隔离不破坏裁决）", () => {
    const db = createTestDb();
    const teacherB = insertTeacher(db, "teacher-b");
    const studentA = makeStudent(db, TEST_TEACHER_ID);
    const studentB = makeStudent(db, teacherB);
    const attemptA = insertAttempt(db, {
      studentId: studentA,
      status: "submitted",
    });
    const attemptB = insertAttempt(db, { studentId: studentB });
    insertResponse(db, attemptA, "shared-q", { submittedAt: NOW });
    insertResponse(db, attemptB, "shared-q");
    // A 的卷已交卷 → 完成（assignment 来源按整卷状态）；B 的卷 draft → 作答中：互不串卷
    const resultA = resolveAttemptQuestionAiPolicy(
      db,
      studentA,
      attemptA,
      "shared-q",
      new FakeConfigSource(),
    );
    expect(resultA.completed).toBe(true);
    expect(resultA.resolution).toEqual({
      usable: true,
      mode: "open_study",
      reason: "completed",
    });
    const configB = new FakeConfigSource();
    configB.teacherDefaults.set(teacherB, "open_study");
    const resultB = resolveAttemptQuestionAiPolicy(
      db,
      studentB,
      attemptB,
      "shared-q",
      configB,
    );
    expect(resultB.completed).toBe(false);
    expect(resultB.resolution).toEqual({
      usable: true,
      mode: "open_study",
      reason: "teacher_default",
    });
    // A 的卷里没有 B 的题目 id 以外内容可读：A 的 attempt + 不在本卷的题 → 404
    expectHttpError(
      () =>
        resolveAttemptQuestionAiPolicy(
          db,
          studentA,
          attemptA,
          "q-only-in-b",
          new FakeConfigSource(),
        ),
      404,
      "QUESTION_NOT_FOUND",
    );
    db.$client.close();
  });

  it("已交卷未到答案公布时间仍可复盘（AI 完成态与 answersReleased 相互独立）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const assignmentId = insertAssignment(db, {
      dueAt: "2026-07-01T00:00:00.000Z",
      answerRelease: "after_due",
    });
    const attemptId = insertAttempt(db, {
      studentId,
      assignmentId,
      status: "submitted",
    });
    insertResponse(db, attemptId, "q1");
    // 教师默认仅启发：完成后仍按 open_study 复盘（自动解除作答中尺度限制）
    const config = new FakeConfigSource();
    config.teacherDefaults.set(TEST_TEACHER_ID, "guided_only");
    const result = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      "q1",
      config,
    );
    expect(result.completed).toBe(true);
    expect(result.resolution).toEqual({
      usable: true,
      mode: "open_study",
      reason: "completed",
    });
    // 普通结果页口径：未到公布时间仍未公布——原函数行为未被本改动影响
    expect(answersReleased(assignmentRow(db, assignmentId), NOW)).toBe(false);
    db.$client.close();
  });

  it("course / wrong / lesson 来源恒不读作业覆盖（assignmentMode 按 inherit 处理）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const config = new FakeConfigSource();
    config.teacherDefaults.set(TEST_TEACHER_ID, "open_study");
    // 作业覆盖里即便存在明确关闭，也不适用于无作业配置的来源
    config.assignmentOverrides.set("some-assignment", "post_submit_only");
    for (const sourceType of ["course", "wrong", "lesson"] as const) {
      // course 用已交卷卷（D7：requireUsableAttempt 对已交卷课程练习不做课程
      // 校验）；course draft 正常路径需完整课程目录夹具，留通道集成测试（SAI-12+）
      const attemptId = insertAttempt(db, {
        studentId,
        sourceType,
        courseId: sourceType === "course" ? insertCourse(db) : null,
        unitId: sourceType === "course" ? "unit-1" : null,
        lectureId: sourceType === "lesson" ? "lec-1" : null,
        status: sourceType === "course" ? "submitted" : "draft",
      });
      insertResponse(db, attemptId, "q1");
      const result = resolveAttemptQuestionAiPolicy(
        db,
        studentId,
        attemptId,
        "q1",
        config,
      );
      // course 已交卷 → completed 复盘；wrong/lesson 作答中全继承 → 教师默认。
      // 两者都不受作业覆盖影响（无 assignment_override / 明确关闭）
      const expected =
        sourceType === "course"
          ? { usable: true, mode: "open_study", reason: "completed" }
          : {
              usable: true,
              mode: "open_study",
              reason: "teacher_default",
            };
      expect(result.resolution, sourceType).toEqual(expected);
    }
    expect(config.assignmentReads).toHaveLength(0);
    db.$client.close();
  });

  it("assignment 来源读作业覆盖用 attempt.assignmentId（不接受客户端指定）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const assignmentId = insertAssignment(db);
    const attemptId = insertAttempt(db, { studentId, assignmentId });
    insertResponse(db, attemptId, "q1");
    const config = new FakeConfigSource();
    config.assignmentOverrides.set(assignmentId, "guided_only");
    const result = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      "q1",
      config,
    );
    expect(result.resolution).toEqual({
      usable: true,
      mode: "guided_only",
      reason: "assignment_override",
    });
    expect(config.assignmentReads).toEqual([assignmentId]);
    db.$client.close();
  });

  it("无教师域异常行：教师默认回落 DEFAULT_AI_TEACHER_MODE（无配置 = 开放伴学）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    // 异常形态：学生行 teacherId 置空（回填后不应存在，防御口径 = 未配置默认）
    db.update(students)
      .set({ teacherId: null })
      .where(eq(students.id, studentId))
      .run();
    const attemptId = insertAttempt(db, { studentId });
    insertResponse(db, attemptId, "q1");
    const config = new FakeConfigSource();
    config.teacherDefaults.set(TEST_TEACHER_ID, "post_submit_only");
    const result = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      "q1",
      config,
    );
    expect(result.resolution).toEqual({
      usable: true,
      mode: "open_study",
      reason: "teacher_default",
    });
    db.$client.close();
  });

  it("v1 逐题卷：post_submit_only 下本题提交即复盘、邻题仍关闭；教师中途切模式即时重校验", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const attemptId = insertAttempt(db, {
      studentId,
      practiceWorkflowVersion: 1,
      feedbackMode: "per_question",
    });
    insertResponse(db, attemptId, "q-main");
    insertResponse(db, attemptId, "q-neighbor");
    const config = new FakeConfigSource();
    config.teacherDefaults.set(TEST_TEACHER_ID, "post_submit_only");
    // 未提交：post_submit_only 作答中关闭（同一任务的创建/领取均不得出站）
    const before = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      "q-main",
      config,
    );
    expect(before.completed).toBe(false);
    expect(before.resolution).toEqual({
      usable: false,
      reason: "teacher_default_closed",
    });
    // 服务端单题提交落库（M2 行级事实）后：本题复盘开放，邻题仍关闭
    markResponseSubmitted(db, attemptId, "q-main");
    const mainAfter = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      "q-main",
      config,
    );
    expect(mainAfter.completed).toBe(true);
    expect(mainAfter.resolution).toEqual({
      usable: true,
      mode: "open_study",
      reason: "completed",
    });
    const neighborAfter = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      "q-neighbor",
      config,
    );
    expect(neighborAfter.completed).toBe(false);
    expect(neighborAfter.resolution).toEqual({
      usable: false,
      reason: "teacher_default_closed",
    });
    // 教师中途切换教学模式（post → guided）：同一任务的下次裁决按新模式 +
    // 新完成态——已完成题恒 open_study 复盘（关闭不能重锁），未提交邻题改按
    // guided 作答中尺度可用（每次调用即重校验，通道不得缓存旧结论）
    config.teacherDefaults.set(TEST_TEACHER_ID, "guided_only");
    const mainRecheck = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      "q-main",
      config,
    );
    expect(mainRecheck.completed).toBe(true);
    expect(mainRecheck.resolution).toEqual({
      usable: true,
      mode: "open_study",
      reason: "completed",
    });
    const neighborRecheck = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      "q-neighbor",
      config,
    );
    expect(neighborRecheck.completed).toBe(false);
    expect(neighborRecheck.resolution).toEqual({
      usable: true,
      mode: "guided_only",
      reason: "teacher_default",
    });
    db.$client.close();
  });
});

/** 按 id 重读 attempt 行（questionPhaseOf 接收数据库行类型，与生产读路径一致） */
function attemptRow(db: Db, attemptId: string) {
  const row = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  if (row === undefined) {
    throw new Error(`测试夹具 attempt ${attemptId} 不存在`);
  }
  return row;
}

/** 按 id 重读作业行（answersReleased 对照断言用，不存在即夹具错误） */
function assignmentRow(db: Db, assignmentId: string) {
  const row = db
    .select()
    .from(assignments)
    .where(eq(assignments.id, assignmentId))
    .get();
  if (row === undefined) {
    throw new Error(`测试夹具 assignment ${assignmentId} 不存在`);
  }
  return row;
}

// ---------- SAI-05：AiPolicyConfigSource 的 sqlite 读取层（真表集成） ----------

describe("sqliteAiPolicyConfigSource 真表读取（SAI-05 落表后的唯一实现）", () => {
  /** 写一行教师默认设置 */
  function setTeacherDefault(
    db: Db,
    teacherId: string,
    defaultMode: AiTeachingMode,
  ): void {
    db.insert(aiTeacherSettings)
      .values({
        teacherId,
        defaultMode,
        promptsOpen: null,
        promptsGuided: null,
        promptsReview: null,
        updatedAt: NOW,
      })
      .run();
  }

  /** 写一行覆盖（student / assignment 两命名空间） */
  function setOverride(
    db: Db,
    subjectType: "student" | "assignment",
    subjectId: string,
    mode: "open_study" | "guided_only" | "post_submit_only",
  ): void {
    db.insert(aiPolicyOverrides)
      .values({ subjectType, subjectId, mode, updatedAt: NOW })
      .run();
  }

  it("无行语义：教师无行 → DEFAULT_AI_TEACHER_MODE，学生/作业无行 → inherit（迁移不回填行）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const assignmentId = insertAssignment(db);
    expect(
      sqliteAiPolicyConfigSource.teacherDefaultMode(db, TEST_TEACHER_ID),
    ).toBe(DEFAULT_AI_TEACHER_MODE);
    expect(sqliteAiPolicyConfigSource.studentOverrideMode(db, studentId)).toBe(
      "inherit",
    );
    expect(
      sqliteAiPolicyConfigSource.assignmentOverrideMode(db, assignmentId),
    ).toBe("inherit");
    // 统一入口真表链路：全无行 → teacher_default / open_study
    const attemptId = insertAttempt(db, { studentId, assignmentId });
    insertResponse(db, attemptId, "q1");
    const result = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      "q1",
      sqliteAiPolicyConfigSource,
    );
    expect(result.resolution).toEqual({
      usable: true,
      mode: "open_study",
      reason: "teacher_default",
    });
    db.$client.close();
  });

  it("真值行 #3 / #7 真表版：教师默认 post + 学生继承 → 关闭；学生显式 open → 覆盖教师默认", () => {
    const db = createTestDb();
    setTeacherDefault(db, TEST_TEACHER_ID, "post_submit_only");
    const inheritStudent = makeStudent(db);
    const inheritAttempt = insertAttempt(db, { studentId: inheritStudent });
    insertResponse(db, inheritAttempt, "q1");
    expect(
      resolveAttemptQuestionAiPolicy(
        db,
        inheritStudent,
        inheritAttempt,
        "q1",
        sqliteAiPolicyConfigSource,
      ).resolution,
    ).toEqual({ usable: false, reason: "teacher_default_closed" });

    setOverride(db, "student", inheritStudent, "open_study");
    expect(
      resolveAttemptQuestionAiPolicy(
        db,
        inheritStudent,
        inheritAttempt,
        "q1",
        sqliteAiPolicyConfigSource,
      ).resolution,
    ).toEqual({
      usable: true,
      mode: "open_study",
      reason: "student_override",
    });
    db.$client.close();
  });

  it("跨教师设置互不影响：教师 B 的默认不改变教师 A 学生的裁决", () => {
    const db = createTestDb();
    const teacherB = insertTeacher(db, "teacher-b");
    setTeacherDefault(db, teacherB, "post_submit_only");
    // 教师 A（TEST_TEACHER_ID）无行 → 默认开放；教师 A 学生不受 B 的设置影响
    const studentA = makeStudent(db, TEST_TEACHER_ID);
    const attemptA = insertAttempt(db, { studentId: studentA });
    insertResponse(db, attemptA, "q1");
    expect(
      resolveAttemptQuestionAiPolicy(
        db,
        studentA,
        attemptA,
        "q1",
        sqliteAiPolicyConfigSource,
      ).resolution,
    ).toEqual({
      usable: true,
      mode: "open_study",
      reason: "teacher_default",
    });
    // 反向：B 的学生按 B 的默认关闭
    const studentB = makeStudent(db, teacherB);
    const attemptB = insertAttempt(db, { studentId: studentB });
    insertResponse(db, attemptB, "q1");
    expect(
      resolveAttemptQuestionAiPolicy(
        db,
        studentB,
        attemptB,
        "q1",
        sqliteAiPolicyConfigSource,
      ).resolution,
    ).toEqual({ usable: false, reason: "teacher_default_closed" });
    db.$client.close();
  });

  it("覆盖命名空间分离：student 覆盖行不被 assignment 读取命中；作业覆盖真表生效", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    // 学生命名空间恰有与作业同 id 的行——assignment 读取不得命中
    const sharedId = randomUUID();
    setOverride(db, "student", sharedId, "post_submit_only");
    expect(
      sqliteAiPolicyConfigSource.assignmentOverrideMode(db, sharedId),
    ).toBe("inherit");

    const assignmentId = insertAssignment(db);
    setOverride(db, "assignment", assignmentId, "guided_only");
    const attemptId = insertAttempt(db, { studentId, assignmentId });
    insertResponse(db, attemptId, "q1");
    expect(
      resolveAttemptQuestionAiPolicy(
        db,
        studentId,
        attemptId,
        "q1",
        sqliteAiPolicyConfigSource,
      ).resolution,
    ).toEqual({
      usable: true,
      mode: "guided_only",
      reason: "assignment_override",
    });
    db.$client.close();
  });
});
