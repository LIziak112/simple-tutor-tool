import type { LintIssue } from "@tutor/contract";

/**
 * 单条编辑的解析语境包装（T1.12）：
 * 题目/讲义编辑提交的是「片段原文」（::::question 容器 / 单篇讲义 markdown），
 * 而 parseDocument / lintDocument 面向整篇文档（要求 frontmatter）。
 * 服务端（重新解析单题）与前端编辑抽屉（本地即时 lint）必须用同一套包装，
 * 保证 lint 行号、缺省 id 推导（unitId / questionStartNumber）口径完全一致，
 * 因此收进 md-dsl 共用，禁止两端各写一份。
 */

/**
 * 把单题 sourceMd 包装成可解析的 practice 文档：
 * `---\nkind: practice\nunit: <unitId>\n---\n\n` + sourceMd。
 * unitId 经 JSON.stringify 输出为 YAML 双引号标量（含引号/冒号等特殊字符也安全）；
 * 同时调用方应把 unitId 传入 ParseOptions.unitId（覆盖缺省 id 推导）。
 */
export function wrapSingleQuestionMd(unitId: string, sourceMd: string): string {
  return `---\nkind: practice\nunit: ${JSON.stringify(unitId)}\n---\n\n${sourceMd}`;
}

/**
 * 把单篇讲义 markdown 包装成可解析的 lecture 文档：
 * `---\nkind: lecture\n---\n\n` + markdown（markdown 自身含 H1 标题行）。
 */
export function wrapLectureMd(markdown: string): string {
  return `---\nkind: lecture\n---\n\n${markdown}`;
}

/** wrapSingleQuestionMd 前缀占的行数（第 offset+1 行起才是 sourceMd 第 1 行） */
export const SINGLE_QUESTION_PREFIX_LINES = 5;

/** wrapLectureMd 前缀占的行数 */
export const LECTURE_PREFIX_LINES = 4;

/**
 * 把包装文档上 lint 出的 issue 行号平移回片段坐标（sourceMd/markdown 的行号），
 * 供前端编辑器按片段原文标红。落在前缀内（不应出现）的 issue 收敛到第 1 行。
 */
export function shiftLintIssuesToFragment(
  issues: readonly LintIssue[],
  prefixLines: number,
): LintIssue[] {
  return issues.map((issue) => ({
    ...issue,
    line: Math.max(1, issue.line - prefixLines),
  }));
}
