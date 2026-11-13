import { z } from "zod";
import { ATTEMPT_QUESTION_LIMIT_EXCEEDED } from "./attempt-errors.ts";

/**
 * 作业模块错误码（UPPER_SNAKE_CODE 固定子集；T2A.7 追加 4 个）：
 * - ASSIGNMENT_NOT_FOUND：目标作业不存在（含已删除的按需接口）（404）；
 * - UNIT_NOT_FOUND：unitIds 中存在未知单元（404）；
 * - COURSE_NOT_FOUND：courseId 不存在（404，T2A.7）；
 * - COURSE_ROSTER_CHANGED：按课程指派的学生已移出课程（409）；
 * - STUDENT_NOT_FOUND：studentIds 中存在未知学生 id（404）；
 * - DUPLICATE_UNIT：unitIds 重复（同一作业单元不可重复，400，D12/T2A.7）；
 * - ATTEMPT_QUESTION_LIMIT_EXCEEDED：作业的有效题数超过开卷上限（400）；
 * - ASSIGNMENT_CONTENT_LOCKED：已锁定（有 attempt）后修改 unitIds
 *   （409，D14/T2A.7）；
 * - CONFIRM_REQUIRED：移出已开始作答的学生未带 confirmStarted（409，D13/T2A.7；
 *   错误壳附带 _students: [{studentId, displayName}]）；
 * - FORBIDDEN：学生请求未被指派给自己的作业（403）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义（401 / 400）。
 */
export const assignmentErrorCodeSchema = z.enum([
  "ASSIGNMENT_NOT_FOUND",
  "UNIT_NOT_FOUND",
  "COURSE_NOT_FOUND",
  "COURSE_ROSTER_CHANGED",
  "STUDENT_NOT_FOUND",
  "DUPLICATE_UNIT",
  ATTEMPT_QUESTION_LIMIT_EXCEEDED,
  "ASSIGNMENT_CONTENT_LOCKED",
  "CONFIRM_REQUIRED",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);
