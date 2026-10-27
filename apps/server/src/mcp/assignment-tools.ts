import {
  assignmentAnswerReleaseSchema,
  assignmentDueAtSchema,
  assignmentTitleSchema,
  assignmentUnitGroupingSchema,
} from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { assignments, attempts, students } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  deleteAssignment,
  getAssignmentDetail,
} from "../services/assignment-service";

/**
 * MCP-C（T-PR5）作业写删两件（create_assignment / delete_assignment）的入参
 * schema 与口径 helper。业务一律复用 REST 同款服务（createAssignment /
 * deleteAssignment / getAssignmentDetail），工具层只做：单学生默认、两段式
 * confirm、「未开答才可删」守卫。
 */

/**
 * create_assignment 入参：与 assignmentCreateRequestSchema 字段对齐（该 schema
 * 带 superRefine 无法 extend），仅 studentIds 改为可省——省略时走「单学生默认」；
 * after_due 与 allowPerQuestionFeedback 的组合校验由 createAssignment 服务内
 * 断言兜底（REST 同款）。
 */
export const assignmentToolInputSchema = z
  .object({
    title: assignmentTitleSchema.optional(),
    courseId: z.uuid().nullable().optional(),
    // 与 contract unitIdSchema 同口径（模块内私有，此处镜像）：单元 id 是
    // 导入产物 slug 不是 UUID，不能收 z.uuid()
    unitIds: z
      .array(z.string().min(1, "unitId 不能为空"))
      .min(1, "作业必须至少包含一个练习单元"),
    studentIds: z.array(z.uuid()).min(1, "作业必须至少指派一名学生").optional(),
    dueAt: assignmentDueAtSchema.optional(),
    answerRelease: assignmentAnswerReleaseSchema.optional(),
    unitGrouping: assignmentUnitGroupingSchema.optional(),
    allowPerQuestionFeedback: z.boolean().optional(),
  })
  .strict();

/**
 * studentIds 可省约定（与 MCP-A teacher-queries.resolveToolStudent 同口径；
 * 两 PR 合并后收敛为一份）：显式给出 → 原样返回，归属校验交由
 * createAssignment / checkAssignment 服务逐个做（非本人 404）；省略 → 名下
 * 未归档学生恰 1 名时默认该生，否则 400 STUDENT_AMBIGUOUS 并附 _students 名单。
 */
export function resolveAssignmentStudentIds(
  db: Db,
  teacherId: string,
  studentIds?: string[],
): string[] {
  if (studentIds !== undefined) return studentIds;
  const rows = db
    .select({ id: students.id, displayName: students.displayName })
    .from(students)
    .where(and(eq(students.teacherId, teacherId), isNull(students.archivedAt)))
    .all();
  const only = rows.length === 1 ? rows[0] : undefined;
  if (only !== undefined) return [only.id];
  throw new HttpError(
    400,
    "STUDENT_AMBIGUOUS",
    rows.length === 0
      ? "名下没有未归档学生，无法缺省 studentIds，请先指定要布置给谁"
      : `名下有 ${rows.length} 名未归档学生，请用 studentIds 指定要布置给谁`,
    {
      _students: rows.map((row) => ({
        studentId: row.id,
        displayName: row.displayName,
      })),
    },
  );
}

/** 作业是否存在任一 attempt（含作废卷）——「有人已开答」的事实判定。 */
function assignmentHasAttempts(db: Db, assignmentId: string): boolean {
  return (
    db
      .select({ id: attempts.id })
      .from(attempts)
      .where(eq(attempts.assignmentId, assignmentId))
      .get() !== undefined
  );
}

/**
 * delete_assignment 预览：作业标题 / 名单 / 已开始人数 / 是否有人已开答。
 * 作业不存在、非本人或已软删 → 404 ASSIGNMENT_NOT_FOUND，不暴露存在性。
 */
export function assignmentDeletePreview(
  db: Db,
  teacherId: string,
  assignmentId: string,
): {
  preview: true;
  title: string;
  startedCount: number;
  hasAttempts: boolean;
  roster: { studentId: string; displayName: string }[];
} {
  const row = db
    .select({ deletedAt: assignments.deletedAt })
    .from(assignments)
    .where(
      and(
        eq(assignments.teacherId, teacherId),
        eq(assignments.id, assignmentId),
      ),
    )
    .get();
  if (row === undefined || row.deletedAt !== null) {
    throw new HttpError(404, "ASSIGNMENT_NOT_FOUND", "作业不存在");
  }
  const detail = getAssignmentDetail(db, teacherId, assignmentId);
  return {
    preview: true,
    title: detail.title,
    startedCount: detail.startedCount,
    hasAttempts: assignmentHasAttempts(db, assignmentId),
    roster: detail.roster.map((entry) => ({
      studentId: entry.studentId,
      displayName: entry.displayName,
    })),
  };
}

/**
 * delete_assignment 执行：「未开答才可删」——存在该作业任一 attempt（含作废
 * 卷）→ 409 ASSIGNMENT_ATTEMPT_EXISTS；通过后软删（作答保留、学生端立即不可
 * 见；deleteAssignment 服务幂等口径）。
 */
export function deleteUnstartedAssignment(
  db: Db,
  teacherId: string,
  assignmentId: string,
): void {
  const row = db
    .select({ deletedAt: assignments.deletedAt })
    .from(assignments)
    .where(
      and(
        eq(assignments.teacherId, teacherId),
        eq(assignments.id, assignmentId),
      ),
    )
    .get();
  if (row === undefined || row.deletedAt !== null) {
    throw new HttpError(404, "ASSIGNMENT_NOT_FOUND", "作业不存在");
  }
  if (assignmentHasAttempts(db, assignmentId)) {
    throw new HttpError(
      409,
      "ASSIGNMENT_ATTEMPT_EXISTS",
      "已有学生开始作答，仅未开答的作业可删除",
    );
  }
  deleteAssignment(db, teacherId, assignmentId);
}
