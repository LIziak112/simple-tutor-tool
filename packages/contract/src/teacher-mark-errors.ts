import { z } from "zod";

/**
 * 批注与待批队列错误码：
 * - RESPONSE_NOT_FOUND：response 不存在或非本教师学生的作答（404，不暴露存在性，
 *   与 ATTEMPT_NOT_FOUND 同口径）；
 * - NOT_SUBMITTED：对 draft attempt 批注（409——未交卷的题没有可批改的冻结行）；
 * - ATTEMPT_ABANDONED：作答已作废，不能批改（409）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义（401 / 400）。
 */
export const teacherMarkErrorCodeSchema = z.enum([
  "RESPONSE_NOT_FOUND",
  "NOT_SUBMITTED",
  "ATTEMPT_ABANDONED",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);
