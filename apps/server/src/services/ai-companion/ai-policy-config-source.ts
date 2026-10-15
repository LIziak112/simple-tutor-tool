import { DEFAULT_AI_TEACHER_MODE } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { aiPolicyOverrides, aiTeacherSettings } from "../../db/schema.ts";
import type { AiPolicyConfigSource } from "./teaching-policy-service.ts";

/**
 * SAI-05：AiPolicyConfigSource 的唯一数据库实现（teaching-policy-service
 * 定义的读取接口；通道不得旁路本实现另查 ai_teacher_settings /
 * ai_policy_overrides）。
 *
 * 无行语义（技术方案 §2.1 存储形态，与迁移行为一致——不回填行）：
 * - ai_teacher_settings 无行 = 教师未设置 → DEFAULT_AI_TEACHER_MODE
 *   （open_study；「无配置」与「显式开放」经无行/有行天然可区分，不统一
 *   写成显式开放导致继承语义消失）；
 * - ai_policy_overrides 无行 = 继承 → "inherit"（改回继承 = 删行，
 *   inherit 不入库）。
 *
 * 读取按主键等值查（teacherId PK / (subjectType, subjectId) 复合 PK），
 * 不需要额外索引；每次裁决实时读行——教师刚改设置立即生效（§2.4），
 * 通道不得缓存结果跨事件使用。
 */
export const sqliteAiPolicyConfigSource: AiPolicyConfigSource = {
  teacherDefaultMode(db: Db, teacherId: string) {
    const row = db
      .select({ defaultMode: aiTeacherSettings.defaultMode })
      .from(aiTeacherSettings)
      .where(eq(aiTeacherSettings.teacherId, teacherId))
      .get();
    return row?.defaultMode ?? DEFAULT_AI_TEACHER_MODE;
  },

  studentOverrideMode(db: Db, studentId: string) {
    const row = db
      .select({ mode: aiPolicyOverrides.mode })
      .from(aiPolicyOverrides)
      .where(
        and(
          eq(aiPolicyOverrides.subjectType, "student"),
          eq(aiPolicyOverrides.subjectId, studentId),
        ),
      )
      .get();
    return row?.mode ?? "inherit";
  },

  assignmentOverrideMode(db: Db, assignmentId: string) {
    const row = db
      .select({ mode: aiPolicyOverrides.mode })
      .from(aiPolicyOverrides)
      .where(
        and(
          eq(aiPolicyOverrides.subjectType, "assignment"),
          eq(aiPolicyOverrides.subjectId, assignmentId),
        ),
      )
      .get();
    return row?.mode ?? "inherit";
  },
};
