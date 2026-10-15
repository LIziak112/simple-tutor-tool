import type {
  AiPolicyInheritableMode,
  AiPolicyOverrideData,
  AiTeacherSettingsData,
  AiTeacherSettingsPutRequest,
} from "@tutor/contract";
import { DEFAULT_AI_TEACHER_MODE } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  aiPolicyOverrides,
  aiTeacherSettings,
  assignments,
  students,
} from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { sqliteAiPolicyConfigSource } from "./ai-policy-config-source.ts";
import { resolveAiPolicy } from "./teaching-policy-service.ts";

/**
 * SAI-06 教学配置服务（B02）：教师全局设置与学生/作业策略覆盖的读写。
 *
 * 边界（批次「完成条件」）：
 * - 本模块是这些接口的唯一业务落点，路由只做契约解析与错误码分流；
 * - 有效裁决恒经 resolveAiPolicy（SAI-04 唯一策略服务）+ sqliteAiPolicyConfigSource
 *   （SAI-05 唯一读取实现）推导，UI 不自行运算一套规则；
 * - 教师域以会话为准：teacherId 形参来自 c.var.teacher.id，目标学生/作业
 *   归属校验沿用防探测口径（他人学生/作业 → 404 STUDENT_NOT_FOUND /
 *   ASSIGNMENT_NOT_FOUND，不暴露存在性，也不读出配置）；
 * - 版本并发：PUT /ai/settings 用 baseUpdatedAt 锚点，不一致 → 409
 *   AI_SETTINGS_STALE 保留服务器值（契约 student-ai-policy.ts；后台重取
 *   不覆盖本地编辑）；
 * - 恢复默认只改指定范围：模板 null = 置 NULL（删自定义），不改其他模板、
 *   不触碰学生覆盖行；覆盖改回 inherit = 删行（SAI-05 存储语义）。
 */

/** 「未设置」状态的版本锚点：GET 返回它，PUT 回传它时若无并发写即通过 */
const AI_SETTINGS_UNSET_UPDATED_AT = "1970-01-01T00:00:00.000Z";

// ---------- 教师全局设置（默认模式 + 三模板） ----------

/** 读教师设置（无行 = 未设置 → 默认值 + 锚点时刻，不物化行） */
export function getTeacherAiSettings(
  db: Db,
  teacherId: string,
): AiTeacherSettingsData {
  const row = db
    .select()
    .from(aiTeacherSettings)
    .where(eq(aiTeacherSettings.teacherId, teacherId))
    .get();
  if (row === undefined) {
    return {
      defaultMode: DEFAULT_AI_TEACHER_MODE,
      promptsOpen: null,
      promptsGuided: null,
      promptsReview: null,
      updatedAt: AI_SETTINGS_UNSET_UPDATED_AT,
    };
  }
  return {
    defaultMode: row.defaultMode,
    promptsOpen: row.promptsOpen,
    promptsGuided: row.promptsGuided,
    promptsReview: row.promptsReview,
    updatedAt: row.updatedAt,
  };
}

/**
 * 部分更新教师设置（缺省 = 不改；prompts null = 恢复该模板默认）。
 *
 * 版本并发：baseUpdatedAt 提供时严格比对（无行比对锚点），不一致 → 409
 * AI_SETTINGS_STALE；缺省 = 跳过检测（契约可选字段，UI 常规路径恒携带）。
 * 无行且合并结果仍是全默认（如显式保存默认值/恢复未自定义过的模板）时
 * 不物化行——「未设置」与「显式开放」的可区分性是 SAI-05 迁移立场，
 * 两者对裁决结果无差异（都是 open_study），不为了落行而落行。
 */
export function updateTeacherAiSettings(
  db: Db,
  teacherId: string,
  body: AiTeacherSettingsPutRequest,
): AiTeacherSettingsData {
  const row = db
    .select()
    .from(aiTeacherSettings)
    .where(eq(aiTeacherSettings.teacherId, teacherId))
    .get();
  const currentUpdatedAt = row?.updatedAt ?? AI_SETTINGS_UNSET_UPDATED_AT;
  if (
    body.baseUpdatedAt !== undefined &&
    body.baseUpdatedAt !== currentUpdatedAt
  ) {
    throw new HttpError(
      409,
      "AI_SETTINGS_STALE",
      "AI 设置已在其他页面被修改，请刷新后重试",
    );
  }
  const next = {
    defaultMode:
      body.defaultMode ?? row?.defaultMode ?? DEFAULT_AI_TEACHER_MODE,
    promptsOpen:
      body.promptsOpen === undefined
        ? (row?.promptsOpen ?? null)
        : body.promptsOpen,
    promptsGuided:
      body.promptsGuided === undefined
        ? (row?.promptsGuided ?? null)
        : body.promptsGuided,
    promptsReview:
      body.promptsReview === undefined
        ? (row?.promptsReview ?? null)
        : body.promptsReview,
  };
  const stillAllDefault =
    next.defaultMode === DEFAULT_AI_TEACHER_MODE &&
    next.promptsOpen === null &&
    next.promptsGuided === null &&
    next.promptsReview === null;
  if (row === undefined && stillAllDefault) {
    return getTeacherAiSettings(db, teacherId);
  }
  const updatedAt = new Date().toISOString();
  db.insert(aiTeacherSettings)
    .values({ teacherId, ...next, updatedAt })
    .onConflictDoUpdate({
      target: aiTeacherSettings.teacherId,
      set: { ...next, updatedAt },
    })
    .run();
  return { ...next, updatedAt };
}

// ---------- 学生 / 作业策略覆盖 ----------

/** 覆盖对象：subjectType 多态指向 students / assignments（无外键，域校验在本模块） */
export type AiPolicySubject =
  | { type: "student"; id: string }
  | { type: "assignment"; id: string };

/**
 * 域校验：目标学生/作业必须归属会话教师，否则 404 防探测口径
 * （与 student-service / assignment-service 同文案，不暴露存在性）。
 */
function requireSubjectInTeacherDomain(
  db: Db,
  teacherId: string,
  subject: AiPolicySubject,
): void {
  if (subject.type === "student") {
    const row = db
      .select({ id: students.id })
      .from(students)
      .where(
        and(eq(students.teacherId, teacherId), eq(students.id, subject.id)),
      )
      .get();
    if (row === undefined) {
      throw new HttpError(404, "STUDENT_NOT_FOUND", "学生不存在");
    }
    return;
  }
  const row = db
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(eq(assignments.teacherId, teacherId), eq(assignments.id, subject.id)),
    )
    .get();
  if (row === undefined) {
    throw new HttpError(404, "ASSIGNMENT_NOT_FOUND", "作业不存在");
  }
}

/** 读覆盖存储值（无行 = 继承） */
function storedOverrideMode(
  db: Db,
  subject: AiPolicySubject,
): AiPolicyInheritableMode {
  const row = db
    .select({ mode: aiPolicyOverrides.mode })
    .from(aiPolicyOverrides)
    .where(
      and(
        eq(aiPolicyOverrides.subjectType, subject.type),
        eq(aiPolicyOverrides.subjectId, subject.id),
      ),
    )
    .get();
  return row?.mode ?? "inherit";
}

/**
 * 保存后即刻有效裁决预览（契约 aiPolicyOverrideDataSchema.resolution）。
 *
 * 预览口径：配置页展示「本层设置后的合并结果」，另一层按继承处理——
 * 学生策略页不假设任何一份作业的覆盖（一个学生对多份作业，各有不同），
 * 作业策略页不假设某个学生的覆盖（一份作业对多个学生）。真实逐题裁决
 * 仍由 resolveAttemptQuestionAiPolicy 按三层实际值计算，本预览不改写它。
 * completed 恒 false：配置预览是作答中视角（完成后恒开放复盘是读侧规则）。
 */
function previewResolution(
  db: Db,
  teacherId: string,
  subject: AiPolicySubject,
  mode: AiPolicyInheritableMode,
): AiPolicyOverrideData["resolution"] {
  return resolveAiPolicy({
    teacherDefault: sqliteAiPolicyConfigSource.teacherDefaultMode(
      db,
      teacherId,
    ),
    studentMode: subject.type === "student" ? mode : "inherit",
    assignmentMode: subject.type === "assignment" ? mode : "inherit",
    completed: false,
  });
}

/** 读学生/作业覆盖 + 有效裁决预览（域校验先行，他人对象 404 不读出配置） */
export function getAiPolicyOverride(
  db: Db,
  teacherId: string,
  subject: AiPolicySubject,
): AiPolicyOverrideData {
  requireSubjectInTeacherDomain(db, teacherId, subject);
  const mode = storedOverrideMode(db, subject);
  return {
    mode,
    resolution: previewResolution(db, teacherId, subject, mode),
  };
}

/**
 * 写覆盖：inherit = 删行（回到继承，SAI-05 存储语义）；三显式值 = upsert。
 * 只改 (subjectType, subjectId) 这一行，不触碰教师设置或其他对象。
 */
export function putAiPolicyOverride(
  db: Db,
  teacherId: string,
  subject: AiPolicySubject,
  mode: AiPolicyInheritableMode,
): AiPolicyOverrideData {
  requireSubjectInTeacherDomain(db, teacherId, subject);
  if (mode === "inherit") {
    db.delete(aiPolicyOverrides)
      .where(
        and(
          eq(aiPolicyOverrides.subjectType, subject.type),
          eq(aiPolicyOverrides.subjectId, subject.id),
        ),
      )
      .run();
  } else {
    db.insert(aiPolicyOverrides)
      .values({
        subjectType: subject.type,
        subjectId: subject.id,
        mode,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [aiPolicyOverrides.subjectType, aiPolicyOverrides.subjectId],
        set: { mode, updatedAt: new Date().toISOString() },
      })
      .run();
  }
  return {
    mode,
    resolution: previewResolution(db, teacherId, subject, mode),
  };
}
