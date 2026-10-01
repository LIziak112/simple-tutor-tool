import { getDirective } from "@tutor/contract";
import type { Heading, Root } from "mdast";
import type { ContainerDirective, LeafDirective } from "mdast-util-directive";
import type { Node } from "unist";
import { canonicalName, lineRange, processor, sliceLines } from "./shared";

/**
 * 讲义结构分析（T4.0b，方案 §4.4.2 前提 2）：从讲义 markdown 解析出
 * 「服务端当尺子」所需的分母数据——每节字数、可折叠指令归属节与内部字数、
 * steps 容器总步数，以及与前端 directive_interact 对账用的文档全局指令序号。
 *
 * docIndex 口径（与 apps/web remarkDirectiveHost 的 dindex 同一规则，两边
 * 改动必须同步）：全部**块级**指令（containerDirective / leafDirective）按
 * 文档顺序预序遍历从 1 计数；行内指令（mark/blank 等 textDirective）不计。
 * 解析用与 v2 解析器同一套 processor（remarkParse + frontmatter + math +
 * gfm + directive；remarkBlank 只产生行内指令、不影响计数）。
 *
 * 纯函数：不碰 db / 不缓存（缓存按 lectureId+updatedAt 在服务层做）。
 * 结构解析失败不抛错（返回已解析到的部分）——结构分析是聚合的辅助层，
 * 坏数据宁可给部分地图也不打挂统计。
 */

/** 单个 H2/H3 节的结构信息 */
export interface LectureSectionStructure {
  /** 目录序号（0 起，与 extractOutline / lecture_section_focus 的 headingIndex 同源） */
  readonly headingIndex: number;
  readonly level: 2 | 3;
  /** 标题纯文本（拼接 text/inlineMath/inlineCode，与 lectureHeadingSchema 同构） */
  readonly text: string;
  /** 该节正文的普通文字字数（公式段折扣系数归服务层配置） */
  readonly textChars: number;
  /** 该节正文内数学段的字数（$$…$$ 块与 $…$ 行内；打折用） */
  readonly mathChars: number;
}

/** 单个可折叠指令的结构信息（hint / solution / fold，含 example 内嵌） */
export interface LectureFoldStructure {
  /** 文档全局指令序号（directive_interact 的 index 口径） */
  readonly docIndex: number;
  /** 注册表主名（别名归一） */
  readonly name: string;
  /** 所属节（headingIndex；标题前出现的收敛到 0） */
  readonly hostHeadingIndex: number;
  /** 指令内部正文的普通文字字数 */
  readonly innerTextChars: number;
  /** 指令内部数学段的字数 */
  readonly innerMathChars: number;
}

/** 单个 steps 容器的结构信息 */
export interface LectureStepsStructure {
  readonly docIndex: number;
  readonly hostHeadingIndex: number;
  /** 容器内 step 指令总数（total 来自服务端解析，§4.4.2(c)） */
  readonly totalSteps: number;
}

export interface LectureStructure {
  readonly sections: readonly LectureSectionStructure[];
  readonly folds: readonly LectureFoldStructure[];
  readonly steps: readonly LectureStepsStructure[];
}

/** 进「可折叠」统计的指令名（讲义域；answer 只在题目内、不出现在讲义 markdown） */
const FOLD_DIRECTIVE_NAMES = new Set(["hint", "solution", "fold"]);

/** 标题纯文本：拼接 text/inlineMath/inlineCode 的 value（与 v2/lecture.ts 同构） */
function headingTextOf(node: Node): string {
  let text = "";
  for (const child of childNodesOf(node)) {
    if (
      child.type === "text" ||
      child.type === "inlineMath" ||
      child.type === "inlineCode"
    ) {
      text += (child as { readonly value?: unknown }).value ?? "";
    } else {
      text += headingTextOf(child);
    }
  }
  return text.trim();
}

function childNodesOf(node: Node): readonly Node[] {
  return (node as { readonly children?: readonly Node[] }).children ?? [];
}

function isBlockDirective(
  node: Node,
): node is ContainerDirective | LeafDirective {
  return node.type === "containerDirective" || node.type === "leafDirective";
}

function isHeading(node: Node): node is Heading {
  return node.type === "heading";
}

/**
 * 加权字数（阅读量估计输入）：普通文本按非空白字符计满，数学段
 * （$$…$$ 块与 $…$ 行内）单独返回——公式段打折的折扣系数属服务层
 * TRACE_THRESHOLDS 配置（§4.4.2 前提 3「阈值集中一份」），由调用方合成。
 */
export function weightedCharCounts(markdown: string): {
  textChars: number;
  mathChars: number;
} {
  let textChars = 0;
  let mathChars = 0;
  let inMathBlock = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "$$") {
      inMathBlock = !inMathBlock;
      continue;
    }
    if (inMathBlock) {
      mathChars += countNonWhitespace(line);
      continue;
    }
    // 行内公式 $…$ 与普通文字分离计数（一行可多段）
    let rest = line;
    for (;;) {
      const match = /\$([^$]+)\$/.exec(rest);
      if (match === null) break;
      textChars += countNonWhitespace(rest.slice(0, match.index));
      mathChars += countNonWhitespace(match[1] ?? "");
      rest = rest.slice(match.index + match[0].length);
    }
    textChars += countNonWhitespace(rest);
  }
  return { textChars, mathChars };
}

function countNonWhitespace(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) count += 1;
  }
  return count;
}

/** 指令内部正文（去首尾围栏行） */
function innerMarkdownOf(node: Node, lines: readonly string[]): string {
  const [start, end] = lineRange(node);
  return sliceLines(lines, start + 1, end - 1);
}

/**
 * 解析讲义结构（一次预序遍历：AST 子节点即文档序，标题与指令按遇到顺序
 * 交错处理——fold/steps 的 hostHeadingIndex = 其之前最近 H2/H3 的序号）。
 */
export function analyzeLectureStructure(markdown: string): LectureStructure {
  const tree = processor.parse(markdown) as Root;
  const lines = markdown.split(/\r?\n/);

  const sections: LectureSectionStructure[] = [];
  const folds: LectureFoldStructure[] = [];
  const steps: LectureStepsStructure[] = [];
  /** 各节起始行（1 起），用于切节内容 */
  const sectionStartLines: number[] = [];

  let docIndex = 0;
  const walk = (node: Node): void => {
    for (const child of childNodesOf(node)) {
      if (isHeading(child)) {
        if (child.depth === 2 || child.depth === 3) {
          const text = headingTextOf(child);
          if (text.length > 0) {
            sectionStartLines.push(lineRange(child)[0]);
            sections.push({
              headingIndex: sections.length,
              level: child.depth,
              text,
              textChars: 0, // 内容范围要等下一节的起始行确定后回填
              mathChars: 0,
            });
          }
        }
        continue; // 标题内部无块级指令
      }
      if (isBlockDirective(child)) {
        docIndex += 1;
        const name =
          child.type === "containerDirective"
            ? canonicalName(child)
            : (getDirective(child.name)?.name ?? child.name);
        // hostHeadingIndex：之前最近标题的序号（首个标题前收敛到 0）
        const hostHeadingIndex = Math.max(0, sections.length - 1);
        if (FOLD_DIRECTIVE_NAMES.has(name)) {
          const inner = weightedCharCounts(innerMarkdownOf(child, lines));
          folds.push({
            docIndex,
            name,
            hostHeadingIndex,
            innerTextChars: inner.textChars,
            innerMathChars: inner.mathChars,
          });
        } else if (name === "steps") {
          let totalSteps = 0;
          for (const stepChild of childNodesOf(child)) {
            if (
              stepChild.type === "containerDirective" &&
              canonicalName(stepChild as ContainerDirective) === "step"
            ) {
              totalSteps += 1;
            }
          }
          steps.push({ docIndex, hostHeadingIndex, totalSteps });
        }
        walk(child);
        continue;
      }
      walk(child);
    }
  };
  walk(tree);

  // 回填各节内容字数：第 i 节 = 标题行 + 1 到下一节标题行 − 1（末节到文末）
  for (const [index, section] of sections.entries()) {
    const startLine = sectionStartLines[index] ?? 1;
    const endLine =
      index + 1 < sectionStartLines.length
        ? (sectionStartLines[index + 1] ?? lines.length) - 1
        : lines.length;
    const counts = weightedCharCounts(
      sliceLines(lines, startLine + 1, endLine),
    );
    (section as { textChars: number; mathChars: number }).textChars =
      counts.textChars;
    (section as { textChars: number; mathChars: number }).mathChars =
      counts.mathChars;
  }
  return { sections, folds, steps };
}
