import type { Lecture, LectureHeading, LintIssue } from "@tutor/contract";
import type { Heading, RootContent } from "mdast";
import type { Node } from "unist";
import { visit } from "unist-util-visit";
import { isQuestionContainer } from "./question.ts";
import { lineRange, makeIssue, sliceRangeExcluding } from "./shared.ts";

/**
 * 讲义切分（T1.4）：kind: lecture 与 kind: mixed 共用。
 * 依据：docs/技术架构与实施方案.md §5.1（讲义按 H1「第X讲」切分）、§5.1.1(4)（原文是真相）、
 * §5.3（讲义自动目录只收 H2/H3）；docs/开发任务清单.md T1.4。
 *
 * 设计约定（派单裁决）：
 * 1. 讲义 markdown 保留该讲全部原文（含 H1 行本身）——渲染端自行决定是否重复显示标题；
 *    Lecture.title 取 H1 文本。
 * 2. 第一个 H1 之前若出现正文：并入第一篇讲义（内容不丢失），记 warning
 *    CONTENT_BEFORE_FIRST_HEADING；只有空白则无 issue。
 * 3. 题目容器从讲义原文中剔除（行区间排除）：讲义 markdown 不含题目；
 *    题目在文档中的位置不必另存，导入端按 unit.lectureTitle 关联（T1.10）。
 * 4. H1 标题为空（如 lone「#」）无法满足契约 title min(1)：记 error EMPTY_HEADING，
 *    该讲不产出（error 会阻断导入，内容不会真正丢失）。
 * 5. 目录 headings 收该讲子树内全部 H2/H3（含容器内部，按文档顺序）；H1 是切分边界、
 *    H4 以下不进目录；空标题的 H2/H3 不进目录（契约 text min(1)）。
 */

/** 切分选项 */
export interface LectureSplitOptions {
  /** 文档顶层子级（含 frontmatter yaml 节点，切分时自动跳过） */
  readonly children: readonly RootContent[];
  /** 文档按行拆分的原文（「原文是真相」：markdown 按行号切原文，不重新序列化） */
  readonly lines: readonly string[];
  /** 正文起始行（frontmatter 结束行的下一行）：第一篇的切分起点，用于并入 H1 前正文 */
  readonly contentStartLine: number;
  /** 题目容器占用的行区间（从讲义原文中剔除） */
  readonly questionRanges: ReadonlyArray<readonly [number, number]>;
  /** issue 输出 */
  readonly issues: LintIssue[];
}

/** 切分结果：h1Count 供调用方决定是否记 MISSING_HEADING（仅 kind: lecture 记 error） */
export interface LectureSplitResult {
  readonly lectures: Lecture[];
  readonly h1Count: number;
}

/** 节点是否为 H1 标题（调用方保证传入的是文档顶层直接子级） */
export function isH1(node: Node): node is Heading {
  return node.type === "heading" && (node as Heading).depth === 1;
}

/**
 * 标题文本：拼接文本/行内公式/行内代码的 value（`## 用 $a$ 表示` 得「用 a 表示」），
 * 不含 markdown 标记。返回值未 trim。
 */
export function headingText(node: Node): string {
  let text = "";
  visit(node, (child) => {
    if (
      child.type === "text" ||
      child.type === "inlineMath" ||
      child.type === "inlineCode"
    ) {
      text += childValue(child) ?? "";
    }
  });
  return text;
}

function childValue(node: Node): string | undefined {
  const value: unknown = (node as { readonly value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

/**
 * 把文档顶层节点按 H1 切分成多篇讲义（kind: lecture / mixed 共用）。
 * 纯函数：结构性问题（H1 前正文、空 H1）只记 issue，不抛异常。
 */
export function splitLectures(
  options: LectureSplitOptions,
): LectureSplitResult {
  const { children, lines, contentStartLine, questionRanges, issues } = options;
  const h1Nodes = children.filter((child) => isH1(child));
  if (h1Nodes.length === 0) return { lectures: [], h1Count: 0 };

  const lectures: Lecture[] = [];
  for (const [index, h1] of h1Nodes.entries()) {
    const [h1Start] = lineRange(h1);
    const next = h1Nodes[index + 1];
    const segmentEnd =
      next === undefined ? lines.length : lineRange(next)[0] - 1;
    // 第一篇从正文起点切起：H1 之前的正文并入第一篇（内容不丢失），其余篇从 H1 行开始
    const segmentStart =
      index === 0 ? Math.min(contentStartLine, h1Start) : h1Start;

    if (index === 0 && h1Start > contentStartLine) {
      const preLine = firstContentLine(
        lines,
        contentStartLine,
        h1Start - 1,
        questionRanges,
      );
      if (preLine !== undefined) {
        issues.push(
          makeIssue(
            "warning",
            preLine,
            1,
            "CONTENT_BEFORE_FIRST_HEADING",
            "第一个 H1 讲义标题之前有正文内容，已并入第一篇讲义（原文保留、内容不丢失）；建议把正文移到讲义标题之后",
          ),
        );
      }
    }

    const title = headingText(h1).trim();
    if (title.length === 0) {
      issues.push(
        makeIssue(
          "error",
          h1Start,
          1,
          "EMPTY_HEADING",
          "H1 标题为空，无法作为讲义标题（该讲未产出）；请补写标题文字，如「# 第1讲 有理数」",
        ),
      );
      continue;
    }

    lectures.push({
      title,
      markdown: sliceRangeExcluding(
        lines,
        segmentStart,
        segmentEnd,
        questionRanges,
      ),
      headings: collectHeadings(children, h1Start, segmentEnd),
    });
  }
  return { lectures, h1Count: h1Nodes.length };
}

/**
 * 收集该讲行区间内全部 H2/H3 目录项（含容器内部，按文档顺序）。
 * questionRanges 已在行区间外被调用方排除；这里再跳过顶层 question 容器节点以防
 * 其内部标题进入目录（mixed 场景题目已从讲义剔除）。
 */
function collectHeadings(
  children: readonly RootContent[],
  segmentStart: number,
  segmentEnd: number,
): LectureHeading[] {
  const headings: LectureHeading[] = [];
  for (const child of children) {
    if (isQuestionContainer(child)) continue;
    const [start] = lineRange(child);
    if (start < segmentStart || start > segmentEnd) continue;
    visit(child, (node) => {
      if (node.type !== "heading") return;
      const heading = node as Heading;
      if (heading.depth !== 2 && heading.depth !== 3) return;
      const text = headingText(heading).trim();
      if (text.length === 0) return; // 空标题不进目录（契约 text min(1)）
      headings.push({ level: heading.depth, text });
    });
  }
  return headings;
}

/** [from, to] 行区间内第一个非空白且未被排除的行号；全空白返回 undefined */
function firstContentLine(
  lines: readonly string[],
  from: number,
  to: number,
  excluded: ReadonlyArray<readonly [number, number]>,
): number | undefined {
  for (let ln = from; ln <= to; ln++) {
    if (excluded.some(([a, b]) => ln >= a && ln <= b)) continue;
    if (/^\s*$/.test(lines[ln - 1] ?? "")) continue;
    return ln;
  }
  return undefined;
}
