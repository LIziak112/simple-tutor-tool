import { z } from "zod";

/**
 * 学生端做题方式与反馈节奏共享契约（M1a 起为权威定义，依据
 * docs/superpowers/plans/2026-10-22-student-practice-feedback-upgrade.md §5/§6.1）：
 * 布局/反馈枚举、本设备学习偏好（strict v1）、服务器返回的 practiceWorkflow
 * 裁决投影、题级公开进度白名单、教师反馈策略与节奏修改（CAS）请求。
 * 本文件不依赖 attempt.ts / assignment.ts（避免循环导入）；所有对外类型由
 * Zod 推导，禁止前后端各自抄写。
 */

/** 做题方式：列表连续下滑 / 单题专注（呈现维度，不是权限） */
export const practiceLayoutSchema = z.enum(["list", "single"]);

/** 反馈节奏：每题提交后查看 / 交卷后统一查看 */
export const practiceFeedbackModeSchema = z.enum([
  "per_question",
  "after_attempt",
]);

/**
 * 教师反馈策略（教师域独立配置，未配置按缺省 student_choice 处理）：
 * - student_choice：学生可在两种反馈节奏中选择；
 * - after_attempt：固定交卷后公布（教师限制）。
 */
export const teacherPracticeFeedbackPolicySchema = z.enum([
  "student_choice",
  "after_attempt",
]);

/**
 * 受限原因（仅描述规则，不含任何题目秘密）：
 * - teacher_after_attempt：教师当前规则要求交卷后公布；
 * - teacher_after_due：教师当前规则要求截止后公布（含 after_due + 逐题授权
 *   的异常历史组合，读侧 fail closed）；
 * - legacy_attempt：历史卷无工作流版本，恒整卷旧协议，不可升级。
 */
export const practiceRestrictionReasonSchema = z.enum([
  "teacher_after_attempt",
  "teacher_after_due",
  "legacy_attempt",
]);

/**
 * 本设备学习偏好（localStorage，strict）：只包含版本、两枚举与快捷键开关，
 * 不保存答案、AI 正文或凭据；version 固定 1，升级时整体失效重写。
 */
export const studentPracticePreferenceSchema = z
  .object({
    version: z.literal(1),
    layout: practiceLayoutSchema,
    feedback: practiceFeedbackModeSchema,
    keyboardShortcuts: z.boolean(),
  })
  .strict();

/**
 * 服务器返回的 practiceWorkflow 裁决投影（strict 白名单——授权结论只能来自
 * 服务端 resolver，本 schema 是其输出契约，不能作为请求授权依据）：
 * - version：协议版本，旧响应缺失按整卷旧协议处理，不能默认授权；
 * - feedbackMode：本卷已确定的反馈节奏（教师收紧时不改写历史选择）；
 * - revision：非负整数，节奏修改与逐题提交的 CAS 依据；
 * - canChangeFeedback：首次任何提交前可改，提交后冻结；
 * - allowedFeedbackModes：当前教师规则允许的非空且不重复集合；
 * - canSubmitQuestion：当前是否允许逐题提交（规则收紧可为 false）；
 * - restrictionReason：受限原因，未受限为 null；
 * - releaseAt：可公开的截止时间（仅复制 dueAt，可空），不复制答案。
 */
export const practiceWorkflowSchema = z
  .object({
    version: z.literal(1),
    feedbackMode: practiceFeedbackModeSchema,
    revision: z.number().int().nonnegative(),
    canChangeFeedback: z.boolean(),
    allowedFeedbackModes: z
      .array(practiceFeedbackModeSchema)
      .min(1)
      .refine((modes) => new Set(modes).size === modes.length, {
        message: "allowedFeedbackModes 不能重复",
      }),
    canSubmitQuestion: z.boolean(),
    restrictionReason: practiceRestrictionReasonSchema.nullable(),
    /** UTC ISO（Z 后缀）或 null；与 assignmentDueAtSchema 同策略但本文件
     * 不从 content.ts 导入（M5 content 将反向引用 practice 推荐字段，避免环） */
    releaseAt: z.iso.datetime({ offset: false }).nullable(),
  })
  .strict();

/**
 * 题级公开进度（白名单）：只表达本题身份、提交时间与当前反馈可读标记；
 * 得分、对错、参考答案与教师批注一律不在本契约，题级反馈经专用端点读取。
 */
export const practiceQuestionProgressSchema = z
  .object({
    questionId: z.string().min(1),
    /** 服务端确认的提交时间：UTC ISO（Z 后缀）；未提交为 null */
    submittedAt: z.iso.datetime({ offset: false }).nullable(),
    /** 当前卷节奏与教师 gate 是否允许读取本题反馈 */
    feedbackReadable: z.boolean(),
  })
  .strict()
  .superRefine((progress, ctx) => {
    // 未提交的题不可能有可读反馈（已提交但当前不可读合法：教师收紧/节奏不允许）
    if (progress.submittedAt === null && progress.feedbackReadable) {
      ctx.addIssue({
        code: "custom",
        path: ["feedbackReadable"],
        message:
          "未提交（submittedAt 为 null）时 feedbackReadable 必须为 false",
      });
    }
  });

/**
 * PATCH /api/student/attempts/:id/workflow 请求体（strict）：
 * 首次提交前更改反馈节奏，携带 workflowRevision 做 CAS；不携带题目快照或稿件。
 */
export const practiceWorkflowUpdateRequestSchema = z
  .object({
    feedbackMode: practiceFeedbackModeSchema,
    workflowRevision: z.number().int().nonnegative(),
  })
  .strict();

/**
 * GET /api/teacher/settings/practice-feedback 响应 data（strict，M1b）：
 * practiceFeedbackPolicy 为 null 表示教师尚未配置——仅对新普通自由练习按
 * student_choice 缺省处理，客户端展示有效默认值，不改历史 attempt。
 */
export const teacherPracticeFeedbackSettingsSchema = z
  .object({
    practiceFeedbackPolicy: teacherPracticeFeedbackPolicySchema.nullable(),
  })
  .strict();

/**
 * PUT /api/teacher/settings/practice-feedback 请求体（strict，M1b）：
 * policy 必填枚举——不允许清空回未配置态（保守起见只能二选一）。
 */
export const teacherPracticeFeedbackSettingsUpdateRequestSchema = z
  .object({
    practiceFeedbackPolicy: teacherPracticeFeedbackPolicySchema,
  })
  .strict();

/**
 * 建卷可选工作流选项（M1b，2026-10-22 计划 §10.1）：新协议客户端显式携带
 * workflowVersion=1；旧请求不带任何字段维持旧协议，不能默认升级。
 * feedbackMode 有值必须伴随 workflowVersion=1（见下方 refine），否则拒绝。
 */
export const practiceWorkflowStartOptionsFields = {
  workflowVersion: z.literal(1).optional(),
  feedbackMode: practiceFeedbackModeSchema.optional(),
} as const;
/** 解析产物可能显式携带 undefined（exactOptionalPropertyTypes 调用方友好） */
export interface PracticeWorkflowStartOptions {
  workflowVersion?: 1 | undefined;
  feedbackMode?: PracticeFeedbackMode | undefined;
}

/** feedbackMode 无 workflowVersion=1 拒绝（不得暗中按新协议授权） */
export const rejectFeedbackModeWithoutVersion = (
  req: {
    workflowVersion?: 1 | undefined;
    feedbackMode?: PracticeFeedbackMode | undefined;
  },
  ctx: z.RefinementCtx,
): void => {
  if (req.feedbackMode !== undefined && req.workflowVersion !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["feedbackMode"],
      message:
        "feedbackMode 只能随 workflowVersion=1（新协议）携带；旧协议请求不带该字段",
    });
  }
};

/**
 * POST /api/student/assignments/:id/attempt 与
 * POST /api/student/courses/:cid/units/:uid/attempts 的可选请求体（M1b）：
 * 空 body / 空对象 = 旧协议；仅接受 workflowVersion=1 与可选 feedbackMode。
 */
export const attemptStartOptionsRequestSchema = z
  .object(practiceWorkflowStartOptionsFields)
  .strict()
  .superRefine(rejectFeedbackModeWithoutVersion);

/**
 * PATCH /api/student/attempts/:id/workflow 响应 data（M1b，strict）：
 * 返回更新后的裁决投影与题级进度白名单（与草稿视图同口径，无答案秘密）；
 * 响应须带 Cache-Control: private, no-store。
 */
export const attemptWorkflowUpdateDataSchema = z
  .object({
    practiceWorkflow: practiceWorkflowSchema,
    questionProgress: z.array(practiceQuestionProgressSchema),
  })
  .strict();

// ---------- 推断类型导出 ----------

export type PracticeLayout = z.infer<typeof practiceLayoutSchema>;
export type PracticeFeedbackMode = z.infer<typeof practiceFeedbackModeSchema>;
export type TeacherPracticeFeedbackPolicy = z.infer<
  typeof teacherPracticeFeedbackPolicySchema
>;
export type PracticeRestrictionReason = z.infer<
  typeof practiceRestrictionReasonSchema
>;
export type StudentPracticePreference = z.infer<
  typeof studentPracticePreferenceSchema
>;
export type PracticeWorkflow = z.infer<typeof practiceWorkflowSchema>;
export type PracticeQuestionProgress = z.infer<
  typeof practiceQuestionProgressSchema
>;
export type PracticeWorkflowUpdateRequest = z.infer<
  typeof practiceWorkflowUpdateRequestSchema
>;
export type TeacherPracticeFeedbackSettings = z.infer<
  typeof teacherPracticeFeedbackSettingsSchema
>;
export type TeacherPracticeFeedbackSettingsUpdateRequest = z.infer<
  typeof teacherPracticeFeedbackSettingsUpdateRequestSchema
>;
export type AttemptStartOptionsRequest = z.infer<
  typeof attemptStartOptionsRequestSchema
>;
export type AttemptWorkflowUpdateData = z.infer<
  typeof attemptWorkflowUpdateDataSchema
>;
