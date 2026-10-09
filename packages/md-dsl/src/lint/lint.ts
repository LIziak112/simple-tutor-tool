import type {
  CapabilitySwitch,
  DocumentKind,
  LintIssue,
  ParsedDocument,
} from "@tutor/contract";
import type { Root } from "mdast";
import type { ParseOptions } from "../v2/parse.ts";
import { parseDocument } from "../v2/parse.ts";
import { isQuestionContainer } from "../v2/question.ts";
import { errorMessage, makeIssue, processor } from "../v2/shared.ts";
import {
  capabilityContextOf,
  lintCapabilityProfile,
} from "./capability.ts";
import { lintBlankMarkerDollar } from "./blank-marker.ts";
import { lintDirectives } from "./directives.ts";
import { lintUnclosedContainers } from "./fences.ts";
import { lintMathDelimiters } from "./math.ts";
import { lintMathSpacingOutside } from "./math-text.ts";
import { lintQuestions } from "./questions.ts";
import { lintRawHtml } from "./raw-html.ts";
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

/**
 * lint 选项（T7.7 起在解析选项之上扩展）：
 * - enabledCapabilities：教师辅助能力启用集（steps/ink 子集）。提供时对使用了
 *   steps 或手写题型但对应开关关闭的位置给 CAPABILITY_DISABLED 回退提示；
 *   未提供 = 无上下文按全启用（CLI 与默认导入不触发）。
 */
export interface LintOptions extends ParseOptions {
  readonly enabledCapabilities?: readonly CapabilitySwitch[];
}

/** 对 v2 DSL 文档做完整 lint：解析 + 规则校验，返回解析结果与合并排序后的全部 issue */
export function lintDocument(
  md: string,
  options: LintOptions = {},
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
  options: LintOptions,
): LintIssue[] {
  try {
    // 与解析器同一套管线重新 parse（纯函数、无共享状态；lint 是 dry-run 场景，成本可接受）
    const tree = processor.parse(md);
    const lines = md.split(/\r?\n/);
    // frontmatter 不可用时解析层按 practice 兜底，语境链与其保持一致
    const kind: DocumentKind = parsed.frontmatter?.kind ?? "practice";
    // T7.7：启用集上下文归一（undefined = 无上下文全启用，规则层零新增）
    const capabilityCtx = capabilityContextOf(options.enabledCapabilities);
    return [
      ...lintUnclosedContainers(lines),
      ...lintDirectives(tree, kind),
      ...lintQuestions(tree, lines, parsed, options),
      ...lintMathDelimiters(tree),
      ...lintMathSpacingOutside(tree),
      ...lintTablePipes(tree),
      ...lintBlankMarkerDollar(tree),
      ...lintRawHtml(tree),
      ...lintEmptyPractice(parsed, tree),
      ...(capabilityCtx === undefined
        ? []
        : lintCapabilityProfile(tree, capabilityCtx)),
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

/**
 * 空练习守卫（2026-10-05 移除 v1 兼容层后补，架构文档 §10 决策 10）：
 * 显式声明 kind: practice 却没有任何 question 容器时，导入会静默产出一个
 * 空单元、全部内容无声丢失。最现实的成因是把旧版 v1 正文贴进了带 frontmatter 的
 * 文档（v1 已停止支持、不再自动转换）。按「源文本中存在容器」判定而非解析成功的
 * 题——题型非法的题已由 UNKNOWN_QUESTION_TYPE 等规则指出，不叠加噪声；只在显式
 * 声明 practice 时报，无 frontmatter 的文档已由解析层 MISSING_FRONTMATTER 拦截。
 */
function lintEmptyPractice(parsed: ParsedDocument, tree: Root): LintIssue[] {
  if (parsed.frontmatter?.kind !== "practice") return [];
  if (tree.children.some(isQuestionContainer)) return [];
  return [
    makeIssue(
      "error",
      1,
      1,
      "PRACTICE_NO_QUESTIONS",
      "练习文档正文中没有任何 ::::question 题目容器，至少要有一道题（若是旧版 v1 格式的内容：v1 已停止支持，请按 docs/dsl/规范.md 改写为 v2）",
    ),
  ];
}

/** 合并排序：行 → 列 → code → message，保证同输入输出稳定（「复制错误给 AI」列表顺序可复现） */
export function sortIssues(issues: readonly LintIssue[]): LintIssue[] {
  return [...issues].sort(
    (a, b) =>
      a.line - b.line ||
      a.column - b.column ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message, "zh-Hans-CN"),
  );
}
