import { z } from "zod";

import { type QuestionType, questionTypeSchema } from "./content.ts";

/**
 * 指令能力三面与题型桥接表（T7.4 / 方案 §4.3）。
 *
 * 能力声明是"描述既有行为"的契约元数据：组件、判分与证据实现复用现有代码，
 * 声明本身不生成新控件或新判分算法（方案 §1.1）。三条纪律：
 * 1. 只标注已实现的交互或证据——展示/结构类指令省略整个 capability，
 *    行为与现状完全相同；不能因省略 validation 而创建人工批改项；
 * 2. 词表保守——partial 仅保留词表，本阶段没有实现也没有声明；
 * 3. snapshot 描述既有作答快照/交互事件，ink-strokes 描述既有笔迹存储；
 *    不修改证据格式、CAS、冻结流程，不新增通用证据调度。
 *
 * 服务端消费（T7.5）：validator-registry 按题型表的 validatorId 登记纯函数，
 * grade() 经题型表查函数；rubric/unverifiable 直接返回 null（人工批改）。
 * 对外分发（T7.6）：capabilities.json 由 gen:spec 从本文件与指令注册表生成。
 */

/** 指令的输入/操作类型（interaction 面）：none 表示无作答输入，不等于不能点击展开 */
export const directiveInputTypeSchema = z.enum([
  "choice",
  "fill",
  "steps",
  "ink",
  "none",
]);
export type DirectiveInputType = z.infer<typeof directiveInputTypeSchema>;

/** 证据形式（evidence 面）：描述既有采集形态，不新增存储格式 */
export const evidenceFormatSchema = z.enum(["snapshot", "ink-strokes", "none"]);
export type EvidenceFormat = z.infer<typeof evidenceFormatSchema>;

/** 校验方式（validation 面）：partial 仅保留词表，本阶段无实现无声明 */
export const validationShapeSchema = z.enum([
  "exact",
  "partial",
  "rubric",
  "unverifiable",
]);
export type ValidationShape = z.infer<typeof validationShapeSchema>;

/**
 * evidence / validation 面内形态（指令 capability 与题型桥接表共用）：
 * 单字段对象而非扁平字符串，为后续每面增字段留形——两处引用同一 schema，
 * 增字段时只改这里，指令面与题型面不会漂移。
 */
const evidenceFacetSchema = z.strictObject({ format: evidenceFormatSchema });
const validationFacetSchema = z.strictObject({
  shape: validationShapeSchema,
});

/**
 * 能力三面（全部可选）。面内用单字段对象（inputType/format/shape）而非扁平
 * 字符串，为后续每面增字段留形；strictObject 拒绝拼错键，注册期即暴露。
 */
export const directiveCapabilitySchema = z.strictObject({
  interaction: z
    .strictObject({ inputType: directiveInputTypeSchema })
    .optional(),
  evidence: evidenceFacetSchema.optional(),
  validation: validationFacetSchema.optional(),
});
export type DirectiveCapability = z.infer<typeof directiveCapabilitySchema>;

/**
 * 题型能力表项：以现有 QuestionType 为键声明该题型的输入、证据、内置校验器
 * 与判分形态（形态照方案 §4.3 桥接表列名：inputType 顶层，evidence/validation
 * 为面内单字段）。evidence.format 是"可采集形式"——手写题未书写笔迹不视为
 * 错误，最终答案照常保存（容忍语义由 T7.5 判分链保证，本表只声明）。
 */
export const questionCapabilityBindingSchema = z.strictObject({
  inputType: directiveInputTypeSchema,
  evidence: evidenceFacetSchema,
  validatorId: z.string().min(1),
  validation: validationFacetSchema,
});
export type QuestionCapabilityBinding = z.infer<
  typeof questionCapabilityBindingSchema
>;

/**
 * 题型能力表（zod v4 穷尽 Record：以七种题型为键，缺键/多键都解析失败）。
 * 模块加载期 parse——未来新增题型而漏配表项时，契约包导入即 fail fast。
 */
export const questionCapabilityBindingsSchema = z.record(
  questionTypeSchema,
  questionCapabilityBindingSchema,
);

/**
 * 指令写法（§5.1.1(1) 三种固定语法，永远不新增写法）。
 * 自 directives.ts 迁入（T7.6）：能力清单条目需要 kind，而 directives.ts 已
 * 依赖本文件——schema 放这里避免反向依赖；directives.ts re-export 维持旧路径。
 */
export const directiveKindSchema = z.enum(["container", "leaf", "text"]);
export type DirectiveKind = z.infer<typeof directiveKindSchema>;

// ---------- 能力清单（capabilities.json，T7.6 / 方案 §4.4） ----------

/**
 * 清单指令条目的属性表一行：与规范.md 属性表同列同数据源（zod 内省 +
 * attrDocs，渲染在 md-dsl gen.ts）。default 为原始值（数字/布尔/字符串），
 * 非规范.md 的展示串；id/class 通用底座不列（说明统一在规范总则）。
 */
export const capabilityAttrSchema = z.strictObject({
  name: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().min(1),
});
export type CapabilityAttr = z.infer<typeof capabilityAttrSchema>;

/**
 * 清单指令条目：全量收录全部已注册指令（方案 §4.4 收录范围），未声明能力
 * 的指令 capability 为 null——AI 消费需要完整指令面，null 即「无输入/证据
 * 能力声明，行为与现状一致」。
 */
export const directiveCapabilityEntrySchema = z.strictObject({
  name: z.string().min(1),
  kind: directiveKindSchema,
  attrs: z.array(capabilityAttrSchema),
  capability: directiveCapabilitySchema.nullable(),
});
export type DirectiveCapabilityEntry = z.infer<
  typeof directiveCapabilityEntrySchema
>;

/**
 * 能力清单（capabilities.json）schema：formatVersion=1；directives 全量指令；
 * questionTypes 复用题型能力表 schema（键=题型、值=桥接表项）。生成侧只读
 * 契约注册表与题型表（不导入服务端 grading 函数，方案 §4.4），经 gen:spec、
 * /api/public/spec/capabilities.json、MCP describe_capabilities、dsl-kit/ 四路
 * 分发——对 AI 只描述既有能力，不做能力承诺。
 */
export const capabilitiesManifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  directives: z.array(directiveCapabilityEntrySchema).min(1),
  questionTypes: questionCapabilityBindingsSchema,
});
export type CapabilitiesManifest = z.infer<typeof capabilitiesManifestSchema>;

// ---------- 能力启用集 profile（T7.7 / 方案 §4.5） ----------

/**
 * 辅助能力开关（教师级）：仅 steps（逐步揭晓）与 ink（手写辅助）两项。
 * choice / fill 是正式作答、none 无输入，都不需要开关——不出现在设置勾选与
 * 本词表中（方案 §4.5 固定边界）。
 */
export const capabilitySwitchSchema = z.enum(["steps", "ink"]);
export type CapabilitySwitch = z.infer<typeof capabilitySwitchSchema>;

/** 缺省全启用：教师未配置（列 NULL）与学生端读取不到字段时的兜底形态 */
export const ALL_ENABLED_CAPABILITIES: readonly CapabilitySwitch[] = [
  "steps",
  "ink",
];

/**
 * 教师能力启用集 profile：enabledCapabilities 为已启用的辅助能力数组。
 * 空数组合法（显式全关——steps 完整展开、手写入口隐藏，正式作答不受影响）；
 * 重复项拒绝（语义要求显式，不静默去重）。存储于 teachers 表单列
 * （capabilityProfileJson，NULL=未配置=全启用），读取侧坏 JSON 同样兜底全启用。
 */
export const capabilityProfileSchema = z.strictObject({
  enabledCapabilities: z
    .array(capabilitySwitchSchema)
    .refine(
      (list) => new Set(list).size === list.length,
      "enabledCapabilities 不能有重复项",
    ),
});
export type CapabilityProfile = z.infer<typeof capabilityProfileSchema>;

/** 学生端响应携带的启用集字段形态（attempt 详情与讲义详情共用；恒为有效集） */
export const enabledCapabilitiesFieldSchema = z.array(capabilitySwitchSchema);


export const questionCapabilityBindings: Record<
  QuestionType,
  QuestionCapabilityBinding
> = questionCapabilityBindingsSchema.parse({
  judge: {
    inputType: "choice",
    evidence: { format: "snapshot" },
    validatorId: "judge",
    validation: { shape: "exact" },
  },
  choice: {
    inputType: "choice",
    evidence: { format: "snapshot" },
    validatorId: "choice",
    validation: { shape: "exact" },
  },
  multi: {
    inputType: "choice",
    evidence: { format: "snapshot" },
    validatorId: "multi",
    validation: { shape: "exact" },
  },
  fill: {
    inputType: "fill",
    evidence: { format: "snapshot" },
    validatorId: "fill",
    validation: { shape: "rubric" },
  },
  solve: {
    inputType: "ink",
    evidence: { format: "ink-strokes" },
    validatorId: "solve",
    validation: { shape: "exact" },
  },
  apply: {
    inputType: "ink",
    evidence: { format: "ink-strokes" },
    validatorId: "apply",
    validation: { shape: "exact" },
  },
  "find-error": {
    inputType: "ink",
    evidence: { format: "ink-strokes" },
    validatorId: "find-error",
    validation: { shape: "exact" },
  },
});
