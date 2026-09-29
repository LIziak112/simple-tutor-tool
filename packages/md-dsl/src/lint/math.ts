import type { LintIssue } from "@tutor/contract";
import type { Root } from "mdast";
import type { Node } from "unist";
import { visit } from "unist-util-visit";
import { makeIssue } from "../v2/shared.ts";

/**
 * 数学定界符配对检查（MATH_LEFT_RIGHT_UNBALANCED）。
 *
 * 动机（2026-09-29 实例）：AI 生成内容把填空空格嵌进公式——一条公式断成两段
 * `$…$`、`[[…]]` 夹在中间，断点写了 `\left(`/`\right)`。KaTeX 要求 \left/\right
 * 在**同一条公式内**配对，两段各自解析失败，渲染管线把 LaTeX 源码原样红字显示
 * （学生端「渲染失败」）。本规则在导入前把它拦成 warning。
 *
 * 判定：对每个数学节点（行内 `$…$` 与数学块 `$$…$$`）的取值做深度扫描——
 * `\left` 深度 +1、`\right` 深度 −1；深度一度为负 = 有 \right 找不到配对的
 * \left；结束时深度 > 0 = 有 \left 未闭合。每个数学节点最多报一条。
 * 普通括号 `(`/`)` 不要求配对（KaTeX 原样渲染），不在检查范围。
 *
 * 词法：`\left`/`\right` 后不能再跟字母（排除 \leftarrow、\rightarrow、
 * \leftrightarrow 等同名前缀的其他指令）；`\left.`/`\right.` 空定界符也计为
 * 一次配对，与本判定相容。
 */

/** \left / \right 记号（负向断言排除 \leftarrow 等其他指令名） */
const LEFT_RIGHT_RE = /\\(left|right)(?![a-zA-Z])/g;

/** 数学节点：取值与起始位置（mdast-util-math 的 Math / InlineMath 共有形状） */
interface MathNode extends Node {
  readonly value: string;
}

function isMathNode(node: Node): node is MathNode {
  return (
    (node.type === "inlineMath" || node.type === "math") &&
    typeof (node as Partial<MathNode>).value === "string"
  );
}

/** 数学节点取值（截断）展示用 */
function excerpt(value: string): string {
  const text = value.trim();
  return text.length <= 24 ? text : `${text.slice(0, 24)}…`;
}

/** 扫描全部数学节点的 \left/\right 配对，返回 warning 列表（无匹配节点不报） */
export function lintMathDelimiters(tree: Root): LintIssue[] {
  const issues: LintIssue[] = [];
  visit(tree, (current) => {
    if (!isMathNode(current)) return;
    let depth = 0;
    let unmatchedRight = false;
    for (const match of current.value.matchAll(LEFT_RIGHT_RE)) {
      if (match[1] === "left") {
        depth += 1;
      } else {
        depth -= 1;
        if (depth < 0) {
          unmatchedRight = true;
          depth = 0; // 只记录「出现过无配对 \right」，不逐个计数
        }
      }
    }
    if (!unmatchedRight && depth === 0) return;

    const detail = unmatchedRight
      ? "\\right 找不到配对的 \\left"
      : `${depth} 个 \\left 没有配对的 \\right`;
    const message = `公式「${excerpt(current.value)}」内 ${detail}：KaTeX 无法渲染，页面会把 LaTeX 源码原样显示。\\left 与 \\right 必须在同一条公式内配对；若要在算式中间插入填空 [[…]] 而断开公式，断点两侧请改用普通括号 ( )`;
    issues.push({
      ...makeIssue(
        "warning",
        current.position?.start.line ?? 1,
        current.position?.start.column ?? 1,
        "MATH_LEFT_RIGHT_UNBALANCED",
        message,
      ),
      fix: "把断点两侧的 \\left( 与 \\right) 改成普通括号 ( 与 )，或把 [[…]] 移出公式",
    });
  });
  return issues;
}
