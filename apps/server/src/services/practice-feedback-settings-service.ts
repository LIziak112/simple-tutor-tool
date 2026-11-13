import type {
  TeacherPracticeFeedbackPolicy,
  TeacherPracticeFeedbackSettings,
  TeacherPracticeFeedbackSettingsUpdateRequest,
} from "@tutor/contract";
import { teacherPracticeFeedbackPolicySchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { teachers } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";

/**
 * 教师练习反馈与学生自评设置。自评开关在建卷时读取。
 *
 * 语义：
 * - 列 NULL = 未配置——仅对新普通自由练习（course/wrong 建卷）由 resolver
 *   按 student_choice 缺省处理，本服务原样返回 null，设置页展示有效默认值；
 * - 写侧已过契约校验；读侧对异常持久化值（手工改库等）兜底 after_attempt
 *   ——保守一侧（不意外授权逐题反馈），与 capabilityProfile 的「多给辅助」
 *   兜底方向相反，本字段是权限相关默认；
 * - 更新按 teacherId 定位，仅写请求中提供的设置。
 */

/** 列值 → policy（NULL 原样；非法值兜底 after_attempt，不抛错） */
export function policyOfColumn(
  value: string | null | undefined,
): TeacherPracticeFeedbackPolicy | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = teacherPracticeFeedbackPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : "after_attempt";
}

/** 读取当前教师的策略设置（教师不存在 → 404） */
export function getPracticeFeedbackSettings(
  db: Db,
  teacherId: string,
): TeacherPracticeFeedbackSettings {
  const row = db
    .select({
      policy: teachers.practiceFeedbackPolicy,
      studentSelfReviewEnabled: teachers.studentSelfReviewEnabled,
    })
    .from(teachers)
    .where(eq(teachers.id, teacherId))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "NOT_FOUND", "教师不存在");
  }
  return {
    practiceFeedbackPolicy: policyOfColumn(row.policy),
    studentSelfReviewEnabled: row.studentSelfReviewEnabled,
  };
}

/** 部分更新（入参已过契约校验；返回值即新设置） */
export function updatePracticeFeedbackSettings(
  db: Db,
  teacherId: string,
  request: TeacherPracticeFeedbackSettingsUpdateRequest,
): TeacherPracticeFeedbackSettings {
  const updated = db
    .update(teachers)
    .set(request)
    .where(eq(teachers.id, teacherId))
    .returning({
      policy: teachers.practiceFeedbackPolicy,
      studentSelfReviewEnabled: teachers.studentSelfReviewEnabled,
    })
    .get();
  if (updated === undefined) {
    throw new HttpError(404, "NOT_FOUND", "教师不存在");
  }
  return {
    practiceFeedbackPolicy: policyOfColumn(updated.policy),
    studentSelfReviewEnabled: updated.studentSelfReviewEnabled,
  };
}

/** 开卷时读取所属教师的自评设置。 */
export function studentSelfReviewEnabledOf(
  db: Db,
  teacherId: string | null,
): boolean {
  if (teacherId === null) return false;
  return (
    db
      .select({ enabled: teachers.studentSelfReviewEnabled })
      .from(teachers)
      .where(eq(teachers.id, teacherId))
      .get()?.enabled === true
  );
}
