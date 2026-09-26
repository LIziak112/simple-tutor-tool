/**
 * DSL 解析器与 linter 包。
 * v2 解析器：parseDocument 按 frontmatter kind 分派（practice 练习题 / lecture 讲义 H1 切分 /
 * mixed 讲义与题目拆分关联，T1.3/T1.4）；linter：lintDocument 在解析之上叠加规则校验
 * （未知指令、题型语义、未闭合容器等，T1.5）；v1 兼容解析在 T1.6 落地。
 */

/** 内容 DSL 规范版本 */
export const MD_DSL_VERSION = "2";

export type { LintResult } from "./lint/lint";
export { lintDocument } from "./lint/lint";
export type { ParseOptions } from "./v2/parse";
export { parseDocument } from "./v2/parse";
