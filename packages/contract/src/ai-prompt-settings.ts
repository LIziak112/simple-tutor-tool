import { z } from "zod";
import type { LearningPackGoal } from "./learning-pack.ts";
import { defaultLearningPackGoalInstructionOf } from "./learning-pack.ts";
import type { ReviewPackRole } from "./review-pack.ts";
import { defaultReviewPackInstructionOf } from "./review-pack.ts";
import {
  AI_PROMPT_TEMPLATE_MAX_CHARS,
  aiPromptTemplateBodySchema,
} from "./student-ai-policy.ts";

/**
 * AI 提示词设置契约（hall-9533）：学伴之外的「复制给 AI」提示词槽位——
 * 出题助手开场指令、学情数据包五个任务目标的指令段、单题复习包学生/教师
 * 两套指令段。每槽位：受众（teacher/student）+ 分组 + 默认正文单源（直接
 * 引用各自渲染器），覆盖值存 ai_prompt_overrides 表（NULL = 用默认）。
 *
 * 口径：
 * - 学伴（in-app AI）提示词不在此处——教师三模板与学生快捷按钮已有独立
 *   配置（student-ai-policy.ts / 契约默认值），本文件只收「导出包 / 出题
 *   助手」这类把提示词交给外部 AI 的槽位；
 * - 覆盖为**整段替换**指令区（学情包=任务目标+输出要求、复习包=角色+任务），
 *   标题、数据说明、附件清单等机器段不受影响；安全边界句（防注入）由服务
 *   端在覆盖时固定追加，不随自定义丢失（与学伴模板「硬约束句模板外拼接」
 *   同口径）；
 * - 学情包默认正文按全模块勾选渲染；实际导出按本次勾选裁剪依赖句，自定义
 *   后整段原样使用（见 learning-pack.ts GOAL_SECTIONS 注释）。
 */

/** 槽位键：出题助手 1 + 学情包五任务目标 + 复习包学生/教师两套 */
export const aiPromptSlotKeySchema = z.enum([
  "content-ai-instruction",
  "learning-pack.diagnose-weakness",
  "learning-pack.lesson-prep",
  "learning-pack.variant-practice",
  "learning-pack.period-summary",
  "learning-pack.per-question-review",
  "review-pack-teacher",
  "review-pack-student",
]);
export type AiPromptSlotKey = z.infer<typeof aiPromptSlotKeySchema>;

/** 槽位受众：教师端设置 / 学生端设置（决定挂在哪个 GET/PUT 与哪个设置页） */
export const aiPromptSlotAudienceSchema = z.enum(["teacher", "student"]);

/** 设置页分组：出题助手 / 学情数据包 / 单题复习包 */
export const aiPromptSlotGroupSchema = z.enum([
  "content-ai",
  "learning-pack",
  "review-pack",
]);

/** 槽位元数据（标题与描述供设置 UI 单源展示，禁止前端另抄一份文案） */
export interface AiPromptSlotMeta {
  readonly key: AiPromptSlotKey;
  readonly audience: "teacher" | "student";
  readonly group: z.infer<typeof aiPromptSlotGroupSchema>;
  readonly title: string;
  readonly description: string;
}

/** 出题助手开场指令默认正文：{kind} / {topic} 占位符在拼装时替换 */
export const DEFAULT_CONTENT_AI_INSTRUCTION =
  "你是一对一辅导老师的内容助手。请按下面的 DSL 规范生成一份{kind}，主题：{topic}。";

/** 学情包任务目标 → 槽位键（装配端注入覆盖时用，禁止手写字符串） */
export function learningPackGoalPromptSlotKeyOf(
  goal: LearningPackGoal,
): AiPromptSlotKey {
  return `learning-pack.${goal}` as AiPromptSlotKey;
}

/** 复习包角色 → 槽位键（装配端注入覆盖时用，禁止手写字符串） */
export function reviewPackPromptSlotKeyOf(
  role: ReviewPackRole,
): AiPromptSlotKey {
  return role === "teacher" ? "review-pack-teacher" : "review-pack-student";
}

/** 槽位注册表（顺序即设置页展示顺序；key 与 defaultAiPromptBodyOf 键集一致） */
export const AI_PROMPT_SLOTS: readonly AiPromptSlotMeta[] = [
  {
    key: "content-ai-instruction",
    audience: "teacher",
    group: "content-ai",
    title: "出题助手开场指令",
    description:
      "「AI 出题助手」一键复制提示词的开头指令。{kind} 会替换为练习/讲义/混合，{topic} 替换为主题（留空为「教师自定」）。",
  },
  {
    key: "learning-pack.diagnose-weakness",
    audience: "teacher",
    group: "learning-pack",
    title: "诊断薄弱点",
    description:
      "学情数据包 prompt.md 的「任务目标 + 输出要求」段，整段替换（标题、数据说明仍系统生成）。默认按全模块勾选展示；实际导出按勾选裁剪依赖句，自定义后整段原样使用。系统固定追加防注入安全边界。",
  },
  {
    key: "learning-pack.lesson-prep",
    audience: "teacher",
    group: "learning-pack",
    title: "备下节课讲解建议",
    description:
      "学情数据包 prompt.md 的「任务目标 + 输出要求」段，整段替换（同上口径）。",
  },
  {
    key: "learning-pack.variant-practice",
    audience: "teacher",
    group: "learning-pack",
    title: "生成变式练习",
    description:
      "学情数据包 prompt.md 的「任务目标 + 输出要求」段，整段替换（同上口径）。",
  },
  {
    key: "learning-pack.period-summary",
    audience: "teacher",
    group: "learning-pack",
    title: "阶段总结（家长沟通）",
    description:
      "学情数据包 prompt.md 的「任务目标 + 输出要求」段，整段替换（同上口径）。",
  },
  {
    key: "learning-pack.per-question-review",
    audience: "teacher",
    group: "learning-pack",
    title: "逐题评析",
    description:
      "学情数据包 prompt.md 的「任务目标 + 输出要求」段，整段替换（同上口径）。",
  },
  {
    key: "review-pack-teacher",
    audience: "teacher",
    group: "review-pack",
    title: "单题复习包指令（教师域）",
    description:
      "教师导出单题复习包 review.md 的「角色 + 任务」指令段，整段替换；附件清单、数据说明与红线由系统生成，红线固定追加防注入句。",
  },
  {
    key: "review-pack-student",
    audience: "student",
    group: "review-pack",
    title: "单题复习包指令（学生自助）",
    description:
      "学生导出单题复习包 review.md 的「角色 + 任务」指令段，整段替换；附件清单、数据说明与红线由系统生成，红线固定追加防注入句。学生包不含参考答案与判定。",
  },
];

/** 槽位正文长度上限（与学伴教师模板同额，契约常量单源） */
export const AI_PROMPT_BODY_MAX_CHARS = AI_PROMPT_TEMPLATE_MAX_CHARS;

/** 各槽位默认正文（键集与 AI_PROMPT_SLOTS 一致；渲染器单源，勿手抄文本） */
export const DEFAULT_AI_PROMPT_BODIES: Readonly<
  Record<AiPromptSlotKey, string>
> = {
  "content-ai-instruction": DEFAULT_CONTENT_AI_INSTRUCTION,
  "learning-pack.diagnose-weakness":
    defaultLearningPackGoalInstructionOf("diagnose-weakness"),
  "learning-pack.lesson-prep":
    defaultLearningPackGoalInstructionOf("lesson-prep"),
  "learning-pack.variant-practice":
    defaultLearningPackGoalInstructionOf("variant-practice"),
  "learning-pack.period-summary":
    defaultLearningPackGoalInstructionOf("period-summary"),
  "learning-pack.per-question-review": defaultLearningPackGoalInstructionOf(
    "per-question-review",
  ),
  "review-pack-teacher": defaultReviewPackInstructionOf("teacher"),
  "review-pack-student": defaultReviewPackInstructionOf("student"),
};

/** 槽位默认正文（AI_PROMPT_BODIES 的取值函数形态；未知键由 schema 拦下） */
export function defaultAiPromptBodyOf(key: AiPromptSlotKey): string {
  return DEFAULT_AI_PROMPT_BODIES[key];
}

/**
 * 出题助手开场指令拼装：把 {kind} / {topic} 占位符替换为实际值。
 * topic 留空回落「教师自定」（与 web 既有行为一致）。
 */
export function renderContentAiInstruction(
  body: string,
  input: { kind: string; topic: string },
): string {
  return body
    .replaceAll("{kind}", input.kind)
    .replaceAll("{topic}", input.topic.trim() || "教师自定");
}

// ---------- 读模型 / 写请求（GET/PUT /ai/prompts 的 data 契约） ----------

/** 单槽位状态（GET 返回；body=当前生效正文，defaultBody=默认正文，isCustom=是否有覆盖行） */
export const aiPromptSlotStateSchema = z
  .object({
    key: aiPromptSlotKeySchema,
    title: z.string().min(1),
    description: z.string().min(1),
    group: aiPromptSlotGroupSchema,
    body: z.string().min(1),
    defaultBody: z.string().min(1),
    isCustom: z.boolean(),
    updatedAt: z.string().min(1),
  })
  .strict();
export type AiPromptSlotState = z.infer<typeof aiPromptSlotStateSchema>;

/** GET /ai/prompts 响应 data（updatedAt=全组版本锚点：各行最大 updatedAt，未设置=锚点时刻） */
export const aiPromptSettingsDataSchema = z
  .object({
    slots: z.array(aiPromptSlotStateSchema).min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type AiPromptSettingsData = z.infer<typeof aiPromptSettingsDataSchema>;

/** PUT 请求体：updates 数组（body=null = 恢复该槽位默认 = 删覆盖行） */
export const aiPromptSettingsPutRequestSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            key: aiPromptSlotKeySchema,
            body: aiPromptTemplateBodySchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(AI_PROMPT_SLOTS.length),
    baseUpdatedAt: z.string().min(1).optional(),
  })
  .strict();
export type AiPromptSettingsPutRequest = z.infer<
  typeof aiPromptSettingsPutRequestSchema
>;

/** 具体化的成功壳（与 learning-pack.ts 同款局部 helper） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/** 携带提示词设置的成功响应壳 */
export const aiPromptSettingsOkSchema = apiOkExtend(aiPromptSettingsDataSchema);
