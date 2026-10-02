import type { LintIssue } from "@tutor/contract";
import type { Root } from "mdast";
import type { Node } from "unist";
import { visit } from "unist-util-visit";
import { makeIssue } from "../v2/shared.ts";

/**
 * 填空标记内 $ 检查（BLANK_MARKER_CONTAINS_DOLLAR，error 级——泄露红线）。
 *
 * 动机（2026-10-02 实测）：填空标记 [[答案|等价答案]] 与 remark-math 的执行顺序是
 * math 先行。标记内一旦出现 $（如 [[$-\frac{5}{4}$|0.5]]），$…$ 被切成 inlineMath
 * 节点、[[ 与 ]] 分离成互不相邻的 text 片段，三连后果：
 * ① 解析器 scanStem 只在 text 节点识别完整标记 → 空位识别不到（题变无答案不判分）；
 * ② publicStemMd 同样剥不到标记 → 答案原文随题干下发学生端（违反硬性规则 3 的泄露）；
 * ③ 题干渲染残渣。正确写法：LaTeX 直接写在标记内不包 $（显示层另有启发式自动渲染）。
 *
 * 判定（AST 层，与 math.ts / scanStem 同一套路，text 节点取值扫描）：
 * a. text 节点内的完整标记 [[…]] 内容含 $ → 报（$ 未配对成公式时标记虽仍被识别，
 *    但 $ 混进判分答案，且一旦与相邻 $ 配对立即变成下述切开形态）；
 * b. 标记被切开的形态：text 节点以 [[ 结尾且其后兄弟是行内公式，或以 ]] 开头且其前
 *    兄弟是行内公式 → 报。同一紧邻公式节点只报一条（[[$x$]] 两侧同时命中不重复）。
 *
 * 负例不报：$[[1,2]]$ / $a_{[[1]]}$（数学环境整体是 inlineMath 节点，内部 [[…]]
 * 不落任何 text 节点）、代码块/行内代码里的标记（code/inlineCode 不是 text）、
 * 不含 $ 的正常标记。
 */

/** 与解析器同源的完整标记正则（question.ts BLANK_MARKER_RE：内容不含方括号、至少一个字符） */
const MARKER_RE = /\[\[([^[\]]+?)\]\]/g;

/** 数学节点的取值（inlineMath/math 共有形状；取不到说明不是紧邻公式） */
function mathValueOf(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type !== "inlineMath" && node.type !== "math") return undefined;
  const value = (node as Partial<{ readonly value: unknown }>).value;
  return typeof value === "string" ? value : undefined;
}

/** 标记/公式取值（截断）展示用 */
function excerpt(value: string): string {
  const text = value.trim();
  return text.length <= 24 ? text : `${text.slice(0, 24)}…`;
}

/** 标记内容在 text 节点取值内的命中位置换算为（行、列）：标记可能跨行 */
function positionOf(
  value: string,
  offset: number,
  startLine: number,
  startColumn: number,
): { line: number; column: number } {
  const before = value.slice(0, offset);
  const newlines = (before.match(/\n/g) ?? []).length;
  if (newlines === 0) return { line: startLine, column: startColumn + offset };
  const lastNewline = before.lastIndexOf("\n");
  return { line: startLine + newlines, column: offset - lastNewline };
}

/** 扫描 text 节点里含 $ 的填空标记与被公式切开的标记，返回 error 列表（无命中不报） */
export function lintBlankMarkerDollar(tree: Root): LintIssue[] {
  const issues: LintIssue[] = [];
  // 切开形态按「紧邻的公式节点」去重：一个被切开的标记只报一条（先命中先报，落在 [[ 一侧）
  const reportedMath = new Set<Node>();

  visit(tree, "text", (node, index, parent) => {
    const value = node.value;
    const startLine = node.position?.start.line ?? 1;
    const startColumn = node.position?.start.column ?? 1;

    // a. 完整标记内容含 $
    for (const match of value.matchAll(MARKER_RE)) {
      const content = match[1] ?? "";
      if (!content.includes("$")) continue;
      const { line, column } = positionOf(
        value,
        match.index ?? 0,
        startLine,
        startColumn,
      );
      issues.push({
        ...makeIssue(
          "error",
          line,
          column,
          "BLANK_MARKER_CONTAINS_DOLLAR",
          `填空/判断标记「[[${excerpt(content)}]]」内出现 $：标记内禁止 $——$ 一旦与相邻 $ 配对成公式定界符，[[…]] 会被从中间切开，解析器识别不到空位（该题无法判分），且答案剥除失效、答案原文会随题干泄露给学生。LaTeX 答案直接写在标记内、不要用 $ 包裹，如 [[\\frac{5}{4}|0.5]]`,
        ),
        fix: "去掉标记内的 $，如 [[$\\frac{5}{4}$|0.5]] 改成 [[\\frac{5}{4}|0.5]]、[[2$]] 改成 [[2]]",
      });
    }

    // b. 标记被切开的形态（兄弟节点须是行内公式）
    const siblings = parent?.children;
    if (siblings === undefined || index === undefined) return;
    // 以 [[ 结尾且其后紧邻公式：[[ 与公式分离
    const next = siblings[index + 1];
    if (value.endsWith("[[") && next !== undefined && !reportedMath.has(next)) {
      const math = mathValueOf(next);
      if (math !== undefined) {
        reportedMath.add(next);
        issues.push({
          ...makeIssue(
            "error",
            node.position?.end.line ?? startLine,
            (node.position?.end.column ?? startColumn) - 2,
            "BLANK_MARKER_CONTAINS_DOLLAR",
            `填空/判断标记 [[…]] 被公式切开：「[[」后紧邻公式「${excerpt(math)}」（标记里的 $ 被 remark-math 先行识别为 $…$ 定界符）：解析器识别不到空位（该题无法判分），且答案剥除失效、答案原文会随题干泄露给学生。LaTeX 答案直接写在标记内、不要用 $ 包裹，如 [[\\frac{5}{4}|0.5]]`,
          ),
          fix: "去掉标记内的 $ 定界符，如 [[$-\\frac{5}{4}$|0.5]] 改成 [[-\\frac{5}{4}|0.5]]",
        });
      }
    }

    // 以 ]] 开头且其前紧邻公式：公式与 ]] 分离
    const prev = siblings[index - 1];
    if (value.startsWith("]]") && prev !== undefined && !reportedMath.has(prev)) {
      const math = mathValueOf(prev);
      if (math !== undefined) {
        reportedMath.add(prev);
        issues.push({
          ...makeIssue(
            "error",
            startLine,
            startColumn,
            "BLANK_MARKER_CONTAINS_DOLLAR",
            `填空/判断标记 [[…]] 被公式切开：公式「${excerpt(math)}」后紧跟「]]」（标记里的 $ 被 remark-math 先行识别为 $…$ 定界符）：解析器识别不到空位（该题无法判分），且答案剥除失效、答案原文会随题干泄露给学生。LaTeX 答案直接写在标记内、不要用 $ 包裹，如 [[0.5|\\frac{1}{2}]]`,
          ),
          fix: "去掉标记内的 $ 定界符，如 [[0.5|$\\frac{1}{2}$]] 改成 [[0.5|\\frac{1}{2}]]",
        });
      }
    }
  });
  return issues;
}
