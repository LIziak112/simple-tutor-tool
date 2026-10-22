import type {
  PracticeFeedbackMode,
  PracticeQuestionProgress,
  PracticeWorkflow,
  TeacherPracticeFeedbackPolicy,
} from "@tutor/contract";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  assignments,
  attempts,
  responses,
  students,
  teachers,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { requireVisibleCourseUnit } from "./course-service";
import { policyOfColumn } from "./practice-feedback-settings-service";
import {
  type AssignmentFeedbackGrant,
  type PracticeWorkflowSource,
  resolvePracticeWorkflow,
  type StoredPracticeWorkflow,
} from "./practice-workflow-service";

/**
 * M1b 工作流接线层：把纯裁决器接到数据库事实上（建卷写入列 + 读侧投影 +
 * PATCH workflow 的事务 CAS）。授权结论仍只来自服务端 resolver；本文件不做
 * 逐题提交/答案释放（M2 范围）。
 */

/**
 * 学生所属教师的当前策略：NULL = 未配置（resolver 按 student_choice 缺省，
 * 仅对新普通自由练习生效）；异常持久化值兜底 after_attempt（保守不授权）；
 * 学生不存在/无教师域/教师行缺失 → after_attempt（fail closed，不给缺省授权）。
 */
function teacherPolicyOfStudent(
  db: Db,
  studentId: string,
): TeacherPracticeFeedbackPolicy | null {
  const row = db
    .select({
      teacherId: students.teacherId,
      policy: teachers.practiceFeedbackPolicy,
    })
    .from(students)
    .leftJoin(teachers, eq(teachers.id, students.teacherId))
    .where(eq(students.id, studentId))
    .get();
  if (row === undefined || row.teacherId === null) {
    return "after_attempt";
  }
  if (row.policy === undefined) {
    // leftJoin 未命中教师行（异常数据）：保守收紧
    return "after_attempt";
  }
  return policyOfColumn(row.policy);
}

/** 作业授权事实（行缺失 → null：assignment 来源交给 resolver fail closed 抛错） */
function assignmentGrantOf(
  db: Db,
  assignmentId: string | null,
): AssignmentFeedbackGrant | null {
  if (assignmentId === null) return null;
  const row = db
    .select({
      answerRelease: assignments.answerRelease,
      allow: assignments.allowPerQuestionFeedback,
      dueAt: assignments.dueAt,
    })
    .from(assignments)
    .where(eq(assignments.id, assignmentId))
    .get();
  if (row === undefined) return null;
  return {
    answerRelease: row.answerRelease,
    allowPerQuestionFeedback: row.allow,
  };
}

/** 作业截止时间（仅复制到 releaseAt；行缺失 null） */
function assignmentDueOf(db: Db, assignmentId: string | null): string | null {
  if (assignmentId === null) return null;
  return (
    db
      .select({ dueAt: assignments.dueAt })
      .from(assignments)
      .where(eq(assignments.id, assignmentId))
      .get()?.dueAt ?? null
  );
}

/** 建卷时写入 attempts 的工作流三列（新协议；调用方已确认请求显式 v1） */
export interface NewAttemptWorkflowColumns {
  practiceWorkflowVersion: 1;
  feedbackMode: PracticeFeedbackMode;
  workflowRevision: 0;
}

/**
 * 新建卷裁决：按当前教师规则/作业授权 + 学生显式选择决定新协议列
 * （不信任学生参数越权——不允许的选择收敛到 after_attempt）。
 * sourceType 仅普通三来源（lesson 不经本函数）。
 */
export function resolveNewAttemptWorkflow(
  db: Db,
  input: {
    sourceType: PracticeWorkflowSource;
    studentId: string;
    assignmentId: string | null;
    /** 学生显式选择（请求 feedbackMode）；未传 null */
    studentChoice: PracticeFeedbackMode | null;
  },
): NewAttemptWorkflowColumns {
  const grant =
    input.sourceType === "assignment"
      ? assignmentGrantOf(db, input.assignmentId)
      : null;
  const workflow = resolvePracticeWorkflow({
    sourceType: input.sourceType,
    lifecycle: "new",
    studentChoice: input.studentChoice,
    assignment: grant,
    teacherPolicy:
      input.sourceType === "assignment"
        ? null
        : teacherPolicyOfStudent(db, input.studentId),
    dueAt: assignmentDueOf(db, input.assignmentId),
  });
  return {
    practiceWorkflowVersion: 1,
    feedbackMode: workflow.feedbackMode,
    workflowRevision: 0,
  };
}

/** 读侧统一视图（新协议 draft 卷；旧协议/lesson 返回 null——缺失 = 旧协议） */
export interface AttemptWorkflowView {
  practiceWorkflow: PracticeWorkflow;
  questionProgress: PracticeQuestionProgress[];
}

/** 已存卷的工作流事实（responses 聚合在调用方查询后传入，减少重复查询） */
function storedOf(
  attempt: Attempt,
  hasSubmittedQuestion: boolean,
): StoredPracticeWorkflow | null {
  if (attempt.practiceWorkflowVersion !== 1 || attempt.feedbackMode === null) {
    return null;
  }
  return {
    feedbackMode: attempt.feedbackMode,
    revision: attempt.workflowRevision,
    hasSubmittedQuestion,
    attemptSubmitted: attempt.submittedAt !== null,
  };
}

/**
 * 读侧投影（草稿视图 / PATCH 回执共用）：服务端按**当前**教师规则/作业授权
 * 重算可提交状态；已选 feedbackMode 不因收紧/放宽改写（resolver 语义）。
 * lesson 或历史卷（无工作流版本）→ null，响应缺失两字段 = 整卷旧协议。
 */
export function attemptWorkflowView(
  db: Db,
  attempt: Attempt,
): AttemptWorkflowView | null {
  if (attempt.sourceType === "lesson") return null;
  const rows = db
    .select({
      questionId: responses.questionId,
      submittedAt: responses.submittedAt,
    })
    .from(responses)
    .where(eq(responses.attemptId, attempt.id))
    .all();
  const hasSubmittedQuestion = rows.some((row) => row.submittedAt !== null);
  const stored = storedOf(attempt, hasSubmittedQuestion);
  if (stored === null) return null;
  const workflow = resolvePracticeWorkflow({
    sourceType: attempt.sourceType,
    lifecycle: "existing",
    stored,
    assignment:
      attempt.sourceType === "assignment"
        ? assignmentGrantOf(db, attempt.assignmentId)
        : null,
    teacherPolicy:
      attempt.sourceType === "assignment"
        ? null
        : teacherPolicyOfStudent(db, attempt.studentId),
    dueAt: assignmentDueOf(db, attempt.assignmentId),
  });
  const perQuestionReadable =
    workflow.canSubmitQuestion && workflow.feedbackMode === "per_question";
  return {
    practiceWorkflow: workflow,
    questionProgress: rows.map((row) => ({
      questionId: row.questionId,
      submittedAt: row.submittedAt,
      feedbackReadable: row.submittedAt !== null && perQuestionReadable,
    })),
  };
}

/**
 * PATCH /api/student/attempts/:id/workflow：首次任何提交前更改反馈节奏。
 * 全程单事务：重取 attempt 工作流列/教师规则/题级提交事实，CAS 拒陈旧
 * revision（不是纯 === 比对——update 带 WHERE workflowRevision 兜并发）。
 * 拒绝：不存在/跨学生 404、作废 409、lesson 或历史卷 409 WORKFLOW_LEGACY、
 * 已整卷交 409 ALREADY_SUBMITTED、任一题已交 409 QUESTION_ALREADY_SUBMITTED、
 * 课程失权（requireVisibleCourseUnit 分态 403/404）、不允许模式 400。
 */
export function updateAttemptWorkflow(
  db: Db,
  studentId: string,
  attemptId: string,
  request: { feedbackMode: PracticeFeedbackMode; workflowRevision: number },
): AttemptWorkflowView {
  return db.transaction((tx) => {
    const attempt = tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.id, attemptId), eq(attempts.studentId, studentId)))
      .get();
    if (attempt === undefined) {
      throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答不存在");
    }
    if (attempt.abandonedAt !== null) {
      throw new HttpError(409, "ATTEMPT_ABANDONED", "这份作答已作废");
    }
    // lesson 走独立适配路径；历史卷（无工作流版本）不可变更——都不暴露存在性差异
    if (
      attempt.sourceType === "lesson" ||
      attempt.practiceWorkflowVersion !== 1 ||
      attempt.feedbackMode === null
    ) {
      throw new HttpError(
        409,
        "WORKFLOW_LEGACY",
        "这份作答不支持更改反馈节奏（旧协议或讲练作答）",
      );
    }
    if (attempt.status !== "draft") {
      throw new HttpError(
        409,
        "ALREADY_SUBMITTED",
        "已交卷的作答不能更改反馈节奏",
      );
    }
    if (attempt.sourceType === "course") {
      // 课程失权分态校验（403/404），与取卷同口径（同步连接，事务内读一致）
      requireVisibleCourseUnit(
        db,
        studentId,
        attempt.courseId ?? "",
        attempt.unitId ?? "",
      );
    }
    const submittedCount = tx
      .select({ n: sql<number>`count(*)` })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attemptId),
          isNotNull(responses.submittedAt),
        ),
      )
      .get();
    if ((submittedCount?.n ?? 0) > 0) {
      throw new HttpError(
        409,
        "QUESTION_ALREADY_SUBMITTED",
        "已有题目提交，反馈节奏已固定",
      );
    }
    const view = attemptWorkflowView(db, attempt);
    if (view === null) {
      throw new HttpError(500, "INTERNAL", "工作流投影缺失（不应发生）");
    }
    if (
      !view.practiceWorkflow.allowedFeedbackModes.includes(request.feedbackMode)
    ) {
      throw new HttpError(
        400,
        "WORKFLOW_MODE_NOT_ALLOWED",
        "当前规则不允许该反馈节奏",
      );
    }
    if (attempt.workflowRevision !== request.workflowRevision) {
      throw new HttpError(
        409,
        "WORKFLOW_REVISION_STALE",
        "反馈节奏已在其他设备修改，请刷新后重试",
      );
    }
    const updated = tx
      .update(attempts)
      .set({
        feedbackMode: request.feedbackMode,
        workflowRevision: attempt.workflowRevision + 1,
      })
      .where(
        and(
          eq(attempts.id, attemptId),
          eq(attempts.workflowRevision, request.workflowRevision),
        ),
      )
      .returning({ id: attempts.id })
      .get();
    if (updated === undefined) {
      throw new HttpError(
        409,
        "WORKFLOW_REVISION_STALE",
        "反馈节奏已在其他设备修改，请刷新后重试",
      );
    }
    const fresh = tx
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    if (fresh === undefined) {
      throw new HttpError(500, "INTERNAL", "工作流更新后读取失败");
    }
    const freshView = attemptWorkflowView(db, fresh);
    if (freshView === null) {
      throw new HttpError(500, "INTERNAL", "工作流投影缺失（不应发生）");
    }
    return freshView;
  });
}
