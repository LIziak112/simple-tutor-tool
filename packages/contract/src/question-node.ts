import { z } from "zod";

/**
 * 题面语义节点契约（LR-4，学习记录模型设计稿 §5.1 起为权威定义）：
 * 「与渲染无关」的圈画锚点坐标系——把题面枚举成稳定的块级语义节点
 * （root / stem/<kind>/<n> / options/option/<n>），圈画笔画锚到节点，任意布局
 * 之间按节点框重投影（LR-6，近似原位编辑的基础）；渲染器用同一枚举给块级
 * 元素打 data-lr-node（LR-PR2）。
 *
 * 单一事实来源（AGENTS 第 1 条）：键 schema / kind 词表 / 枚举算法版本在
 * 本文件；枚举函数 questionNodesOf 在 @tutor/md-dsl（src/v2/question-nodes.ts，
 * 公开投影输入）；contract / md-dsl / apps-web 三侧消费方都从这里导入，
 * 禁止手写副本。
 *
 * 枚举必须基于公开投影口径（教师原文含 `- [x]` 与 `[[答案]]`，stripOptionListMd
 * 后块结构与学生一致；标记替换只动行内文本，不改块结构）——教师原文与学生
 * 投影枚举出**同一键序列**是锚点跨角色可互认的前提，由 md-dsl 的
 * question-nodes.test.ts 锁定（设计稿 §9 LR-PR1 验收点）。
 */

/** 枚举算法版本：节点枚举规则变更即递增，老记录按老版本解释（设计稿附录 A-3） */
export const QUESTION_NODES_VERSION = 1;

/**
 * 节点键：root，或 stem/<kind>/<n> / options/option/<n>（kind 为小写词元、
 * n 为同类节点在预序中的 0 起序号）。词元与 questionNodeKindSchema 枚举值
 * 一致，唯 paragraph 在键里缩写为 p（设计稿 §5.1 示例 stem/p/0）。
 */
export const questionNodeKeySchema = z
  .string()
  .max(64)
  .regex(/^root$|^(stem|options)\/[a-z-]+\/\d+$/);

/** 块级节点类型词表（blank/figure/image 为保留值，v1 枚举不产出） */
export const questionNodeKindSchema = z.enum([
  "root",
  "paragraph",
  "heading",
  "list-item",
  "option",
  "image",
  "math-block",
  "table",
  "code",
  "blank",
  "figure",
  "other",
]);

/** 单个题面语义节点（order 为全树预序 0 起序号；text/label 是可选的人读摘要） */
export const questionNodeSchema = z.object({
  key: questionNodeKeySchema,
  kind: questionNodeKindSchema,
  order: z.number().int().min(0),
  /** 节点纯文本摘要（公开投影内容；≤200 字符，枚举侧截断） */
  text: z.string().max(200).optional(),
  /** 选项节点的选项字母（A、B、…，按 options 序号推导） */
  label: z.string().max(8).optional(),
});

export type QuestionNode = z.infer<typeof questionNodeSchema>;
export type QuestionNodeKind = z.infer<typeof questionNodeKindSchema>;
export type QuestionNodeKey = z.infer<typeof questionNodeKeySchema>;
