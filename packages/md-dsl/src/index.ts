/**
 * DSL 解析器与 linter 包。
 * v2 解析器：parseDocument 按 frontmatter kind 分派（practice 练习题 / lecture 讲义 H1 切分 /
 * mixed 讲义与题目拆分关联，T1.3/T1.4）；linter：lintDocument 在解析之上叠加规则校验
 * （未知指令、题型语义、未闭合容器等，T1.5）；v1 兼容（T1.6）：detectVersion 导入时
 * 自动识别版本，parseV1 按旧规则解析为同一契约，v1ToV2 一键升级旧文档为 v2 文本。
 */

/** 内容 DSL 规范版本 */
export const MD_DSL_VERSION = "2";

export type { VersionDetection } from "./detect.ts";
export { detectVersion, detectVersionDetailed } from "./detect.ts";
export type { LintResult } from "./lint/lint.ts";
export { lintDocument } from "./lint/lint.ts";
export {
  parseV1,
  parseV1Detailed,
  V1_DEFAULT_UNIT_ID,
  V1_QUESTION_TYPES,
  type V1DetailedResult,
  type V1ParsedUnit,
  type V1RawOption,
  type V1RawQuestion,
  type V1RawUnit,
} from "./v1/parse.ts";
export { v1ToV2, v1ToV2Units } from "./v1/toV2.ts";
export {
  LECTURE_PREFIX_LINES,
  SINGLE_QUESTION_PREFIX_LINES,
  shiftLintIssuesToFragment,
  wrapLectureMd,
  wrapSingleQuestionMd,
} from "./v2/edit-context.ts";
export type { ParseOptions } from "./v2/parse.ts";
export { parseDocument } from "./v2/parse.ts";
