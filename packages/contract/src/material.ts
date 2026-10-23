import { z } from "zod";

/**
 * 共享材料与题组契约（TT-05a 域①，决策记录 §5.2 定稿，QM-01 落地）。
 *
 * 物理布局是**引用式**（D4）：题块保持文档顶层（question 的 allowedIn 不改），
 * 材料用 ::::material 容器在文档顶层声明，题组用 ::::group 容器声明并经 ::ref
 * 引用子题与材料；首版仅一层（组引用组报错）。
 *
 * 「原文是真相」（§5.2.5）：material.sourceMd / group.sourceMd 各自是该实体的
 * 作者源文（含导入规范化回写后的 id），anchors/slots/引用索引只是抽取副本，
 * 不接受绕开源文的独立修改；导出重建 = 按源文原样导出，重导经同一解析器还原
 * 同结构同 id（round-trip 稳定）。
 *
 * 安全（§5.8.1）：materialPublicSchema / questionGroupPublicSchema 是学生端
 * 公开投影的白名单形态，fail closed 同 questionPublicSchema 纪律——多给的
 * 教师侧字段（sourceMd 等）在 parse 时被 strip；材料正文不含答案型内容由
 * lint 的 MATERIAL_CONTAINS_ANSWER 保证（TT-06），本投影是第二道结构防线。
 *
 * 两公开投影为手写白名单而非 Zod pick/omit 派生（questionPublicSchema
 * 先例）：新增应公开字段需与完整 schema 两处手动同步——残余风险是功能
 * 缺失向而非泄露向，由 material.test.ts 精确键集断言兜底（tt-05a 审查
 * P2-4 注记）。
 */

/**
 * 槽位种类（§5.2.2 / §5.7.3 推演表）：材料或题干正文中的 `{{slot-id}}` 行内
 * 挖空标记按用途分三类。text 为题干文本挖空（既有 fill 语境，UA-02 首版词）；
 * choice 为材料内选择空位（完形：槽位映射 choice 子题）；match 为配对槽位
 * （matching 题声明其槽位集合）。
 */
export const slotKindSchema = z.enum(["text", "choice", "match"]);
export type SlotKind = z.infer<typeof slotKindSchema>;

/** 片段锚点（:::seg 容器的抽取副本；order 为材料内出现顺序 0 起） */
export const materialAnchorSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().min(0),
});
export type MaterialAnchor = z.infer<typeof materialAnchorSchema>;

/** 材料槽位（{{slot}} 文本标记的抽取副本；槽位身份 = (scopeId, slotId)，此处只存槽位自身） */
export const materialSlotSchema = z.object({
  id: z.string().min(1),
  slotKind: slotKindSchema,
  order: z.number().int().min(0),
});
export type MaterialSlot = z.infer<typeof materialSlotSchema>;

/**
 * ::ref 引用的解析产物（§5.2.2）：material 必填；segs（片段选择）/ slot（单个
 * 槽位绑定）/ slots（槽位集合）可选，值为 DSL 原始选择串（`seg-2` 单个 /
 * `seg-1..seg-3` 区间 / `seg-1,seg-4` 列表）。区间展开与引用合法性（未知/越界）
 * 依赖文档上下文，属 TT-06 解析与 lint 层（SEG_* / SLOT_* 错误码），契约层只
 * 定字段形态。
 */
export const materialRefSchema = z.object({
  material: z.string().min(1),
  segs: z.string().min(1).optional(),
  slot: z.string().min(1).optional(),
  slots: z.string().min(1).optional(),
});
export type MaterialRef = z.infer<typeof materialRefSchema>;

/** 材料（教师侧完整形态） */
export const materialSchema = z.object({
  id: z.string().min(1),
  /** 显示标题（::::material 的 title 属性，可选） */
  title: z.string().optional(),
  /** 材料容器原始 Markdown（含 id/title 属性与内部 seg/slot；导入规范化回写后固化） */
  sourceMd: z.string(),
  /** 容器内部 Markdown（渲染与公开投影用，不含容器围栏与属性） */
  contentMd: z.string(),
  /** 片段锚点抽取副本（文档顺序） */
  anchors: z.array(materialAnchorSchema).default([]),
  /** 槽位抽取副本（出现顺序） */
  slots: z.array(materialSlotSchema).default([]),
  /** 媒体引用（blobs/media/ 内容寻址路径；开卷冻结依赖闭包与备份清理由此索引） */
  mediaPaths: z.array(z.string().min(1)).default([]),
});
export type Material = z.infer<typeof materialSchema>;

/**
 * 材料（学生端公开投影）：手写白名单（非 pick/omit 派生——新增应公开字段
 * 与 materialSchema 两处手动同步，精确键集测试兜底，见文件头注记）；
 * 教师侧 sourceMd 不下发（fail closed）。
 */
export const materialPublicSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  /** 公开正文（= contentMd；材料正文按 lint 规则不含答案型内容） */
  contentMd: z.string(),
  anchors: z.array(materialAnchorSchema).default([]),
  slots: z.array(materialSlotSchema).default([]),
  mediaPaths: z.array(z.string().min(1)).default([]),
});
export type MaterialPublic = z.infer<typeof materialPublicSchema>;

/**
 * 题组（教师侧完整形态）。组是叠加元数据（§5.2.4）：不产生题行、不出现在
 * units.questions 平铺数组；questionIds 必须是单元题序的**子序列**（lint 校验，
 * GROUP_ORDER_INVALID）。首版仅一层：组引用组报错（GROUP_NESTED_OR_CYCLIC）。
 */
export const questionGroupSchema = z.object({
  id: z.string().min(1),
  /** 组标题/公共说明标题（可选；公共说明正文写在容器内，抽入 introMd） */
  title: z.string().optional(),
  /** 组级显示编号说明（如「1～5」「1–20」；显示编号是展示派生，不进主键） */
  label: z.string().optional(),
  /** 组容器原始 Markdown（含 ::ref 引用行；导入规范化回写后固化） */
  sourceMd: z.string(),
  /** 公共说明正文（容器内部 Markdown） */
  introMd: z.string(),
  /** 材料引用（按书写顺序累加；::ref{material=…} 可多个） */
  materialRefs: z.array(materialRefSchema).default([]),
  /** 子题 id 顺序（::ref{question=…} 书写顺序；单元题序子序列） */
  questionIds: z.array(z.string().min(1)).default([]),
});
export type QuestionGroup = z.infer<typeof questionGroupSchema>;

/**
 * 题组（学生端公开投影）：手写白名单（同 materialPublicSchema：非 pick/omit
 * 派生、与 questionGroupSchema 两处手动同步、键集测试兜底）；教师侧
 * sourceMd 不下发（fail closed）。
 */
export const questionGroupPublicSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  label: z.string().optional(),
  introMd: z.string(),
  materialRefs: z.array(materialRefSchema).default([]),
  questionIds: z.array(z.string().min(1)).default([]),
});
export type QuestionGroupPublic = z.infer<typeof questionGroupPublicSchema>;

/**
 * unit.groups 的叠加元数据形态（§5.2.4 定稿原文：`[{ id, title, label?,
 * materialRefs[], questionIds[] }]`）——units.questions 平铺数组保持现状，
 * 该数组只是题组索引（不带组源文；单元结构源文 = 文档本身，§5.2.5-1）。
 */
export const unitGroupSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  label: z.string().optional(),
  materialRefs: z.array(materialRefSchema).default([]),
  questionIds: z.array(z.string().min(1)).default([]),
});
export type UnitGroup = z.infer<typeof unitGroupSchema>;

// ---------- 稳定 ID（§5.2.3 定稿表；TT-06 解析器/导入规范化的单一出处） ----------

/**
 * ID 前缀常量：不同实体类型的 id 不撞名空间，::ref 的 material= 与 question=
 * 属性解析不歧义。缺省生成仅在「源文缺 id 且首次导入」时发生，生成后**回写
 * 源文**；重排、reparse、编辑、导出重导不重新生成（§5.2.3 / §4.3）。
 */
export const MATERIAL_ID_PREFIX = "mat-";
export const GROUP_ID_PREFIX = "grp-";
export const SEGMENT_ID_PREFIX = "seg-";
export const SLOT_ID_PREFIX = "slot-";
export const OPTION_ID_PREFIX = "opt-";
export const ITEM_ID_PREFIX = "item-";

/** 材料：`mat-{unitId}-{n}`（n 按文档出现顺序 1 起） */
export function defaultMaterialIdOf(unitId: string, ordinal: number): string {
  return `${MATERIAL_ID_PREFIX}${unitId}-${ordinal}`;
}

/** 题组：`grp-{unitId}-{n}`（n 按文档出现顺序 1 起） */
export function defaultGroupIdOf(unitId: string, ordinal: number): string {
  return `${GROUP_ID_PREFIX}${unitId}-${ordinal}`;
}

/** 片段锚点：`seg-{n}`（n 按材料内出现顺序 1 起） */
export function defaultSegmentIdOf(ordinal: number): string {
  return `${SEGMENT_ID_PREFIX}${ordinal}`;
}

/** 槽位：`slot-{n}`（n 按所在材料/题内出现顺序 1 起） */
export function defaultSlotIdOf(ordinal: number): string {
  return `${SLOT_ID_PREFIX}${ordinal}`;
}

/** 配对选项：`opt-{questionId}-{n}`（n 按题内声明顺序 1 起） */
export function defaultOptionIdOf(questionId: string, ordinal: number): string {
  return `${OPTION_ID_PREFIX}${questionId}-${ordinal}`;
}

/** 排序项：`item-{questionId}-{n}`（n 按题内声明顺序 1 起） */
export function defaultItemIdOf(questionId: string, ordinal: number): string {
  return `${ITEM_ID_PREFIX}${questionId}-${ordinal}`;
}
