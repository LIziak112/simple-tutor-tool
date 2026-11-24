import { z } from "zod";

/**
 * 批注与待批队列错误码：
 * - RESPONSE_NOT_FOUND：response 不存在或非本教师学生的作答（404，不暴露存在性，
 *   与 ATTEMPT_NOT_FOUND 同口径）；
 * - NOT_SUBMITTED：对 draft attempt 批注（409——未交卷的题没有可批改的冻结行）；
 * - ATTEMPT_ABANDONED：作答已作废，不能批改（409）；
 * - VERDICT_CONFLICT / OPERATION_CONFLICT：修订落后或操作键已被其他内容占用（409）；
 * - KERNEL_MARK_PENDING：同一道题存在未确认的批改（409）；
 * - FORBIDDEN：操作确认前教师的写入授权已撤销（403）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义（401 / 400）。
 */
export const teacherMarkErrorCodeSchema = z.enum([
  "RESPONSE_NOT_FOUND",
  "NOT_SUBMITTED",
  "ATTEMPT_ABANDONED",
  "VERDICT_CONFLICT",
  "OPERATION_CONFLICT",
  "KERNEL_MARK_PENDING",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);
