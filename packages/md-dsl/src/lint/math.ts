import type { LintIssue } from "@tutor/contract";
import type { Root } from "mdast";
import type { Node } from "unist";
import { visit } from "unist-util-visit";
import { sizedMathDelimiters } from "../v2/math-delimiters.ts";
import { makeIssue } from "../v2/shared.ts";

interface MathNode extends Node {
  readonly value: string;
}

function isMathNode(node: Node): node is MathNode {
  return (
    (node.type === "inlineMath" || node.type === "math") &&
    typeof (node as Partial<MathNode>).value === "string"
  );
}

/** 只阻断确定不配对的数学片段；普通括号、其他数学warning不升级。 */
export function lintMathDelimiters(tree: Root): LintIssue[] {
  const issues: LintIssue[] = [];
  visit(tree, (current) => {
    if (!isMathNode(current)) return;
    const { depth, unmatchedRight, unbalanced } = sizedMathDelimiters(
      current.value,
    );
    if (!unbalanced) return;
    const excerpt = current.value.trim().slice(0, 24);
    const detail = unmatchedRight
      ? "\\right 找不到配对的 \\left"
      : `${depth} 个 \\left 没有配对的 \\right`;
    issues.push({
      ...makeIssue(
        "error",
        current.position?.start.line ?? 1,
        current.position?.start.column ?? 1,
        "MATH_LEFT_RIGHT_UNBALANCED",
        `公式「${excerpt}」内 ${detail}：KaTeX 无法正常渲染，不能发布。\\left 与 \\right 必须在同一条公式内配对；算式中插入填空 [[…]] 而断开公式时，断点两侧请改用普通括号 ( )`,
      ),
      fix: "把断点两侧的 \\left( 与 \\right) 改成普通括号 ( 与 )，或把 [[…]] 移出公式",
    });
  });
  return issues;
}
