import type { LintIssue } from "@tutor/contract";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";
import { makeIssue } from "../v2/shared.ts";

/**
 * 公式外 LaTeX 间距命令检查（MATH_SPACING_OUTSIDE）。
 *
 * 动机（2026-10-02 实例）：AI 生成的讲义把小题/选项间距写在公式之间——
 * `① $…$；\quad ② $…$`、`A. $…$ \qquad B. $…$`。纯 LaTeX 里 `$…$\quad$…$`
 * 是合法排版，但本管线只有 `$…$` / `$$…$$` 内部交给 KaTeX，定界符之外
 * 一律按纯文本渲染，`\quad` 等命令原样显示成乱码。本规则在导入前把它
 * 拦成 warning（与 MATH_LEFT_RIGHT_UNBALANCED 同族：AI 内容公式纠错闭环）。
 *
 * 判定：对每个 text 节点（inlineMath/math/inlineCode/code 之外的纯文本）
 * 扫描间距命令；同一行聚合为一条 issue（一行小题/选项行常有多处），
 * message 列出该行出现的命令清单。
 *
 * 只查已知间距命令（quad 家族 + hspace/hfill），不泛化到任意 \命令：
 * 控制误报，正文出现其他反斜杠词不在此规则职责内。
 */

/** LaTeX 间距命令（负向断言排除 \quadname 之类更长指令名） */
const SPACING_RE =
  /\\(?:qquad|quad|enspace|thinspace|medspace|thickspace|negthinspace|negmedspace|negthickspace|hspace|hfill)(?![a-zA-Z])/g;

/** 同一行聚合的命中：出现过的命令集合与首个命中的列 */
interface LineHit {
  readonly commands: Set<string>;
  column: number;
}

/** 扫描全部 text 节点的公式外间距命令，按行聚合返回 warning 列表（无命中不报） */
export function lintMathSpacingOutside(tree: Root): LintIssue[] {
  const byLine = new Map<number, LineHit>();
  visit(tree, "text", (node) => {
    for (const match of node.value.matchAll(SPACING_RE)) {
      const line = node.position?.start.line ?? 1;
      const column = node.position?.start.column ?? 1;
      const hit = byLine.get(line) ?? { commands: new Set<string>(), column };
      hit.commands.add(match[0]);
      byLine.set(line, hit);
    }
  });

  const issues: LintIssue[] = [];
  for (const [line, hit] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    const list = [...hit.commands].sort().join("、");
    issues.push({
      ...makeIssue(
        "warning",
        line,
        hit.column,
        "MATH_SPACING_OUTSIDE",
        `本行公式之外出现 ${list}：定界符外的 LaTeX 间距命令不经过 KaTeX，会原样显示成乱码。把间距命令移进公式内（如 $a,\\quad b$），公式之间用普通空格或全角空格`,
      ),
      fix: "把 \\quad / \\qquad 写进 $…$ 公式内部，或删除、换成空格",
    });
  }
  return issues;
}
