import { z } from "zod";

/**
 * 学生端 AI 伴学：教学配置与预设契约（SAI-02 起为权威定义）。
 * 依据：docs/学生端AI伴学/技术实施方案.md §2（三层策略真值表）、§4.1（契约模块）、
 * §9（限额表）、需求规格.md §3（教师配置）、§5（提示词与快捷按钮）。
 *
 * 边界约定（与 AGENTS.md「学生端 AI 伴学与受控 AI 出口」一致）：
 * - 本文件全部学生端请求 schema 一律 strict——学生可提交的只有自己的按钮与问题，
 *   effectiveMode/teacherId 等服务端权威字段出现在请求里即整体拒绝；
 * - 裁决（aiPolicyResolutionSchema）是服务端输出，只在响应中出现；
 * - 继承（inherit）是配置输入的显式第四值，与默认开放（open_study）可区分；
 * - 恢复默认 = 客户端显式提交默认值 / null， omission（缺省）只表示"不改"，
 *   不隐式覆盖未确认的个人修改（版本冲突用 baseUpdatedAt 锚点拒绝）。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ---------- 模式与裁决 ----------

/** 三种教学模式（值域与 B00 §2.1 一致，无第四模式；默认 open_study） */
export const aiTeachingModeSchema = z.enum([
  "open_study",
  "guided_only",
  "post_submit_only",
]);
export type AiTeachingMode = z.infer<typeof aiTeachingModeSchema>;

/** 新教师/未配置时的默认模式（AI 出口默认开放伴学，需求 §1/§3.1） */
export const DEFAULT_AI_TEACHER_MODE: AiTeachingMode = "open_study";

/**
 * 配置输入模式：三显式值 + inherit（仅用于学生/作业覆盖的请求与存储回显）。
 * 继承不能序列化为"开放"——否则无法区分默认生效与显式覆盖（需求 §3.1）。
 * 三显式值从 aiTeachingModeSchema 单源派生，不另抄一份字面量。
 */
export const aiPolicyInheritableModeSchema = z.enum([
  ...aiTeachingModeSchema.options,
  "inherit",
]);
export type AiPolicyInheritableMode = z.infer<
  typeof aiPolicyInheritableModeSchema
>;

/** 裁决原因（B00 §2.2 两步合并算法的七种输出，服务端单源推导） */
export const aiPolicyReasonSchema = z.enum([
  "teacher_default",
  "student_override",
  "assignment_override",
  "student_closed",
  "assignment_closed",
  "teacher_default_closed",
  "completed",
]);
export type AiPolicyReason = z.infer<typeof aiPolicyReasonSchema>;

/**
 * 有效裁决结果：服务端输出，不是学生可提交的可信字段。
 * usable=false（作答中不可用）时不携带回答尺度；usable=true 时 mode 必填；
 * 本题完成后 usable 恒 true、mode 恒 open_study（reason=completed）。
 */
export const aiPolicyResolutionSchema = z
  .object({
    usable: z.boolean(),
    mode: aiTeachingModeSchema.optional(),
    reason: aiPolicyReasonSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.usable && value.mode !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "作答中不可用时不得携带回答尺度",
      });
    }
    if (value.usable && value.mode === undefined) {
      ctx.addIssue({ code: "custom", message: "可用时必须给出回答尺度" });
    }
  });
export type AiPolicyResolution = z.infer<typeof aiPolicyResolutionSchema>;

// ---------- 教师全局设置（默认模式 + 三模板） ----------

/** 提示词模板长度上限（§9 限额表：8,000 字符/模板，契约常量单源） */
export const AI_PROMPT_TEMPLATE_MAX_CHARS = 8000;

/** 模板键：开放伴学 / 仅启发 / 完成后复盘（需求 §5.1 三模板） */
export const aiPromptTemplateKeySchema = z.enum(["open", "guided", "review"]);
export type AiPromptTemplateKey = z.infer<typeof aiPromptTemplateKeySchema>;

/** 模板正文：提供时 trim 后 1–8000 字符；null = 使用默认模板（恢复默认） */
export const aiPromptTemplateBodySchema = z
  .string()
  .trim()
  .min(1, "模板正文不能为空（恢复默认请提交 null）")
  .max(
    AI_PROMPT_TEMPLATE_MAX_CHARS,
    `模板最多 ${AI_PROMPT_TEMPLATE_MAX_CHARS} 个字符`,
  );

/** 教师设置读模型（GET /api/teacher/ai/settings 响应 data） */
export const aiTeacherSettingsDataSchema = z
  .object({
    defaultMode: aiTeachingModeSchema,
    /** null = 未自定义，服务端按 DEFAULT_AI_PROMPT_TEMPLATES 装配 */
    promptsOpen: z.string().nullable(),
    promptsGuided: z.string().nullable(),
    promptsReview: z.string().nullable(),
    updatedAt: z.string().min(1),
  })
  .strict();
export type AiTeacherSettingsData = z.infer<typeof aiTeacherSettingsDataSchema>;

/**
 * PUT /api/teacher/ai/settings 请求体（部分更新：缺省 = 不改）。
 * - prompts 传 null = 显式恢复该模式默认模板；空串/纯空白拒绝（需求 §12 教师模板删空须校验）；
 * - baseUpdatedAt = 客户端读取时的 updatedAt，服务端不一致时 409 AI_SETTINGS_STALE
 *   （后台重取不覆盖本地编辑；恢复默认不隐式覆盖未确认的修改）。
 */
export const aiTeacherSettingsPutRequestSchema = z
  .object({
    defaultMode: aiTeachingModeSchema.optional(),
    promptsOpen: aiPromptTemplateBodySchema.nullable().optional(),
    promptsGuided: aiPromptTemplateBodySchema.nullable().optional(),
    promptsReview: aiPromptTemplateBodySchema.nullable().optional(),
    baseUpdatedAt: z.string().min(1).optional(),
  })
  .strict();
export type AiTeacherSettingsPutRequest = z.infer<
  typeof aiTeacherSettingsPutRequestSchema
>;

/** 携带教师设置的成功响应壳 */

/**
 * 默认提示词模板（需求 §5.1 默认模板意图表的契约单源）。
 * 仅启发模式硬约束句由服务端在模板外拼接，模板删空也不失效；
 * 教师模板正文按 D9 不下发学生端（学生只见模式名与原因）。
 */
const DEFAULT_AI_READING_GUIDANCE =
  "先回应学生当前卡住的地方，再给一个可以自己尝试的下一步；需要长讲解时使用简短小标题。明确依据实际收到的材料，不虚构笔迹、步骤或掌握情况。数学公式使用 $…$ 或独占行的 $$…$$，代码示例才用代码围栏。";

export const DEFAULT_AI_PROMPT_TEMPLATES: Readonly<
  Record<AiPromptTemplateKey, string>
> = {
  open: `参考题目自带的标准答案与官方解析，结合学生提交的材料与具体诉求提供帮助；需要时可以完整推导讲解。${DEFAULT_AI_READING_GUIDANCE}`,
  guided: `可参考标准答案与官方解析校验方向，但只指出学生当前的错误、必要概念或下一步；不直接给出最终答案、填空答案或正确选项，也不换一种形式透露等价答案。${DEFAULT_AI_READING_GUIDANCE}`,
  review: `对照学生本次作答与参考答案、官方解析，解释关键错误和纠正方法，可以完整讲解；本任务属于完成后复盘，不按作答中求助处理。${DEFAULT_AI_READING_GUIDANCE}`,
};

// ---------- 学生 / 作业覆盖 ----------

/**
 * PUT /api/teacher/students/:id/ai-policy 与 /assignments/:id/ai-policy 请求体。
 * 继承与三显式值同域；服务端校验归属（studentId/assignmentId 须在本教师域）。
 */
export const aiPolicyOverridePutRequestSchema = z
  .object({
    mode: aiPolicyInheritableModeSchema,
  })
  .strict();
export type AiPolicyOverridePutRequest = z.infer<
  typeof aiPolicyOverridePutRequestSchema
>;

/**
 * 覆盖写响应 data：存储值（含 inherit）+ 保存后即刻有效裁决预览。
 * 作业与学生均显示继承时，前端用 resolution.mode 展示实际继承值（需求 §3.2）。
 */
export const aiPolicyOverrideDataSchema = z
  .object({
    mode: aiPolicyInheritableModeSchema,
    resolution: aiPolicyResolutionSchema,
  })
  .strict();
export type AiPolicyOverrideData = z.infer<typeof aiPolicyOverrideDataSchema>;

/** 携带覆盖结果的成功响应壳 */

// ---------- 学生快捷按钮 ----------

/** 快捷按钮数量上限（§9：12 个） */
export const AI_QUICK_BUTTON_MAX_COUNT = 12;
/** 按钮名称长度上限（§9：16 字符） */
export const AI_QUICK_BUTTON_NAME_MAX_CHARS = 16;
/** 按钮提示词长度上限（§9：500 字符） */
export const AI_QUICK_BUTTON_PROMPT_MAX_CHARS = 500;

/**
 * 附件偏好/材料选择：圈画、草稿、正式手写三类独立勾选（需求 §4.2）。
 * 三个布尔键与领域层 aiMaterialKindSchema 的 annotation|draft|formal_ink
 * 一一对应（student-ai.ts）；因 student-ai.ts 反向引用本文件的模式枚举，
 * 此处不 import 该枚举以免循环，新增材料类别时两处必须同步。
 */
export const aiMaterialPreferenceSchema = z
  .object({
    annotation: z.boolean(),
    draft: z.boolean(),
    formalInk: z.boolean(),
  })
  .strict();
export type AiMaterialPreference = z.infer<typeof aiMaterialPreferenceSchema>;

/** 单个快捷按钮（稳定 ID + 名称 + 提示词 + 顺序 + 启用 + 附件偏好） */
export const studentQuickButtonSchema = z
  .object({
    /** 稳定 ID：默认按钮用固定语义 id，自定义按钮用 uuid；重复 ID 整体拒绝 */
    id: z.string().min(1),
    name: z
      .string()
      .trim()
      .min(1, "按钮名称不能为空")
      .max(AI_QUICK_BUTTON_NAME_MAX_CHARS, "按钮名称最多 16 个字符"),
    prompt: z
      .string()
      .trim()
      .min(1, "按钮提示词不能为空")
      .max(AI_QUICK_BUTTON_PROMPT_MAX_CHARS, "按钮提示词最多 500 个字符"),
    orderIndex: z
      .number()
      .int()
      .min(0)
      .max(AI_QUICK_BUTTON_MAX_COUNT - 1),
    enabled: z.boolean(),
    attachmentPref: aiMaterialPreferenceSchema,
  })
  .strict();
export type StudentQuickButton = z.infer<typeof studentQuickButtonSchema>;

/**
 * PUT /api/student/ai/quick-buttons 请求体：整组替换（含空组 = 全部删除，合法）。
 * superRefine 拒绝重复 ID 与重复 orderIndex——不能留下顺序不确定的列表。
 */
export const studentQuickButtonsPutRequestSchema = z
  .object({
    buttons: z
      .array(studentQuickButtonSchema)
      .max(
        AI_QUICK_BUTTON_MAX_COUNT,
        `快捷按钮最多 ${AI_QUICK_BUTTON_MAX_COUNT} 个`,
      ),
    baseUpdatedAt: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    const orders = new Set<number>();
    for (const button of value.buttons) {
      if (ids.has(button.id)) {
        ctx.addIssue({ code: "custom", message: "按钮 ID 重复" });
        return;
      }
      ids.add(button.id);
      if (orders.has(button.orderIndex)) {
        ctx.addIssue({ code: "custom", message: "按钮顺序冲突" });
        return;
      }
      orders.add(button.orderIndex);
    }
  });
export type StudentQuickButtonsPutRequest = z.infer<
  typeof studentQuickButtonsPutRequestSchema
>;

/** GET 响应 data：按钮整组 + 版本锚点（PUT 回传做冲突检测） */
export const studentQuickButtonsDataSchema = z
  .object({
    buttons: z.array(studentQuickButtonSchema),
    updatedAt: z.string().min(1),
  })
  .strict();
export type StudentQuickButtonsData = z.infer<
  typeof studentQuickButtonsDataSchema
>;

/** 携带快捷按钮的成功响应壳 */
export const studentQuickButtonsOkSchema = apiOkExtend(
  studentQuickButtonsDataSchema,
);

/**
 * 默认四按钮（需求 §5.2 初始集，契约常量单源，不落库——学生首次自定义时才物化）。
 * 附件偏好钉死项：「查当前步骤」附已有非空书写材料、「讲核心概念」不附图；
 * 「启发下一步」「完整拆解」为 B01 具体化（附材料以看到当前进展），可随时改。
 * 恢复默认 = 学生确认后整组显式提交本常量，不静默丢失个人修改。
 */
export const DEFAULT_QUICK_BUTTONS: readonly StudentQuickButton[] = [
  {
    id: "hint-next",
    name: "启发下一步",
    prompt: "请根据我当前的作答，指出下一步该做什么；先不要给出最终答案。",
    orderIndex: 0,
    enabled: true,
    attachmentPref: { annotation: true, draft: true, formalInk: true },
  },
  {
    id: "check-steps",
    name: "查当前步骤",
    prompt: "请检查我当前书写的步骤，指出从哪一步开始出错以及原因。",
    orderIndex: 1,
    enabled: true,
    attachmentPref: { annotation: true, draft: true, formalInk: true },
  },
  {
    id: "explain-concept",
    name: "讲核心概念",
    prompt: "请讲解这道题考察的核心概念，帮我理解知识点本身。",
    orderIndex: 2,
    enabled: true,
    attachmentPref: { annotation: false, draft: false, formalInk: false },
  },
  {
    id: "full-breakdown",
    name: "完整拆解",
    prompt: "请完整拆解这道题的解题过程，逐步讲解并总结方法。",
    orderIndex: 3,
    enabled: true,
    attachmentPref: { annotation: true, draft: true, formalInk: true },
  },
];

// ---------- 错误码 ----------

/**
 * 教学配置模块错误码（UPPER_SNAKE_CODE 固定子集）：
 * - AI_PROMPT_INVALID：模板正文为空/超限（400）；
 * - AI_BUTTONS_INVALID：快捷按钮名称/提示词/数量/重复与顺序冲突（400）；
 * - AI_POLICY_INVALID：覆盖请求 mode 非法（400）；
 * - AI_SETTINGS_STALE：baseUpdatedAt 与服务端不一致（409，暂存提交版本冲突；
 *   B01 依据 SAI-02「版本冲突」要求补充，B00 §4.2 表未列出的唯一新增码）；
 * - UNAUTHORIZED / FORBIDDEN / NOT_FOUND / VALIDATION_ERROR：通用口径同义。
 */
export const aiPolicyErrorCodeSchema = z.enum([
  "AI_PROMPT_INVALID",
  "AI_BUTTONS_INVALID",
  "AI_POLICY_INVALID",
  "AI_SETTINGS_STALE",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
]);
