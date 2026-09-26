/**
 * DSL 解析器与 linter 包。
 * v2 解析器：parseDocument 按 frontmatter kind 分派（practice 练习题 / lecture 讲义 H1 切分 /
 * mixed 讲义与题目拆分关联，T1.3/T1.4）；linter 在 T1.5 落地；v1 兼容解析在 T1.6 落地。
 */

/** 内容 DSL 规范版本 */
export const MD_DSL_VERSION = "2";

export type { ParseOptions } from "./v2/parse";
export { parseDocument } from "./v2/parse";
