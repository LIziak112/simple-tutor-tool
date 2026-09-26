/**
 * DSL 解析器与 linter 包。
 * v2 解析器：parseDocument（T1.3 起支持练习题；T1.4 将扩展讲义与混合文档）；
 * linter 在 T1.5 落地；v1 兼容解析在 T1.6 落地。
 */

/** 内容 DSL 规范版本 */
export const MD_DSL_VERSION = "2";

export type { ParseOptions } from "./v2/parse";
export { parseDocument } from "./v2/parse";
