import type { DocumentKind, LintIssue, ParsedDocument } from "@tutor/contract";
import type { ParseOptions } from "../v2/parse.ts";
import { parseDocument } from "../v2/parse.ts";
import { errorMessage, makeIssue, processor } from "../v2/shared.ts";
import { lintDirectives } from "./directives.ts";
import { lintUnclosedContainers } from "./fences.ts";
import { lintMathDelimiters } from "./math.ts";
import { lintMathSpacingOutside } from "./math-text.ts";
import { lintQuestions } from "./questions.ts";
import { lintTablePipes } from "./tables.ts";

/**
 * DSL v2 lint 入口（T1.5）：lintDocument = 解析（透传其 issues，不重复报）+ 规则层新增
 * issues，合并后按（行、列、code、message）稳定排序输出。
 * 依据：docs/技术架构与实施方案.md §5.1（LintIssue 契约、教师端导入前 dry-run、
 * 「复制错误给 AI」闭环——message 必须一眼能看懂怎么改）、docs/开发任务清单.md T1.5。
 *
 * 纯函数、不抛异常：规则层内部缺陷也压成一条 LINT_INTERNAL_ERROR issue。
 * 返回的 parsed 与顶层 issues 携带同一份完整合并结果（读哪边都是全量）；
 * parseDocument 自身行为不变（其 .issues 仍只含解析层 issue）。
 */
export interface LintResult {
  readonly parsed: ParsedDocument;
  readonly issues: LintIssue[];
}

/** 对 v2 DSL 文档做完整 lint：解析 + 规则校验，返回解析结果与合并排序后的全部 issue */
export function lintDocument(
  md: string,
  options: ParseOptions = {},
): LintResult {
  const parsed = parseDocument(md, options);
  const extra = runRules(md, parsed, options);
  const issues = sortIssues([...parsed.issues, ...extra]);
  return { parsed: { ...parsed, issues }, issues };
}

/** 规则层执行（不抛异常：内部缺陷压成 LINT_INTERNAL_ERROR） */
function runRules(
  md: string,
  parsed: ParsedDocument,
  options: ParseOptions,
): LintIssue[] {
  try {
    // 与解析器同一套管线重新 parse（纯函数、无共享状态；lint 是 dry-run 场景，成本可接受）
    const tree = processor.parse(md);
    const lines = md.split(/\r?\n/);
    // frontmatter 不可用时解析层按 practice 兜底，语境链与其保持一致
    const kind: DocumentKind = parsed.frontmatter?.kind ?? "practice";
    return [
      ...lintUnclosedContainers(lines),
      ...lintDirectives(tree, kind),
      ...lintQuestions(tree, lines, parsed, options),
      ...lintMathDelimiters(tree),
      ...lintMathSpacingOutside(tree),
      ...lintTablePipes(tree),
    ];
  } catch (err) {
    return [
      makeIssue(
        "error",
        1,
        1,
        "LINT_INTERNAL_ERROR",
        `linter 内部错误（这是 linter 缺陷，请反馈给开发者）：${errorMessage(err)}`,
      ),
    ];
  }
}

/** 合并排序：行 → 列 → code → message，保证同输入输出稳定（「复制错误给 AI」列表顺序可复现） */
export function sortIssues(issues: readonly LintIssue[]): LintIssue[] {
  return [...issues].sort(
    (a, b) =>
      a.line - b.line ||
      a.column - b.column ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
}
