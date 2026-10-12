import type {
  Lecture,
  LectureHeading,
  LintIssue,
  Question,
} from "@tutor/contract";
import type { Heading, RootContent } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import type { Node } from "unist";
import { visit } from "unist-util-visit";
import { isQuestionContainer } from "./question.ts";
import {
  firstNonEmpty,
  lineRange,
  makeIssue,
  sliceLines,
  sliceRangeExcluding,
} from "./shared.ts";

/**
 * 讲义切分（T1.4）：kind: lecture 与 kind: mixed 共用；2026-10 讲练一体起
 * kind: lesson 以 keep 模式复用（题块原位保留 + 缺省题目 id 注入开围栏）。
 * 依据：docs/技术架构与实施方案.md §5.1（讲义按 H1「第X讲」切分）、§5.1.1(4)（原文是真相）、
 * §5.3（讲义自动目录只收 H2/H3）；docs/开发任务清单.md T1.4。
 *
 * 设计约定（派单裁决）：
 * 1. 讲义 markdown 保留该讲全部原文（含 H1 行本身）——渲染端自行决定是否重复显示标题；
 *    Lecture.title 取 H1 文本。
 * 2. 第一个 H1 之前若出现正文：并入第一篇讲义（内容不丢失），记 warning
 *    CONTENT_BEFORE_FIRST_HEADING；只有空白则无 issue。
 * 3. strip 模式（lecture/mixed）：题目容器从讲义原文中剔除（行区间排除）：讲义 markdown
 *    不含题目；题目在文档中的位置不必另存，导入端按 unit.lectureTitle 关联（T1.10）。
 *    keep 模式（lesson）：题块行区间保留在讲义 markdown 原位，并对缺省 id 的题目容器
 *    开围栏注入 id="<最终题目id>"（同一注入写进该题 sourceMd，往返稳定，方案决策 8）。
 * 4. H1 标题为空（如 lone「#」）无法满足契约 title min(1)：记 error EMPTY_HEADING，
 *    该讲不产出（error 会阻断导入，内容不会真正丢失）。
 * 5. 目录 headings 收该讲子树内全部 H2/H3（含容器内部，按文档顺序）；H1 是切分边界、
 *    H4 以下不进目录；空标题的 H2/H3 不进目录（契约 text min(1)）。
 */

/**
 * 切分选项：两种模式共有字段（模式专属字段见各变体，mode 为判别键）。
 */
export interface LectureSplitOptionsCommon {
  /** 文档顶层子级（含 frontmatter yaml 节点，切分时自动跳过） */
  readonly children: readonly RootContent[];
  /** 文档按行拆分的原文（「原文是真相」：markdown 按行号切原文，不重新序列化） */
  readonly lines: readonly string[];
  /** 正文起始行（frontmatter 结束行的下一行）：第一篇的切分起点，用于并入 H1 前正文 */
  readonly contentStartLine: number;
  /** issue 输出 */
  readonly issues: LintIssue[];
}

/**
 * strip 模式选项（lecture/mixed 既有行为）：题目容器行区间从讲义原文中剔除。
 */
export interface LectureSplitOptionsStrip extends LectureSplitOptionsCommon {
  readonly mode: "strip";
  /** 题目容器占用的行区间（从讲义原文中剔除；H1 前正文检测同样按此排除） */
  readonly questionRanges: ReadonlyArray<readonly [number, number]>;
}

/**
 * keep 模式选项（lesson 讲练页）：题块行区间保留在讲义 markdown 原位，并对
 * 缺省 id 的题目容器开围栏注入 id="<最终题目id>"（同一注入写进该题 sourceMd，
 * 往返稳定，方案决策 8）；题块行区间按 questionNodes 派生（H1 前正文检测的
 * 排除区间），不再单独收 questionRanges。
 */
export interface LectureSplitOptionsKeep extends LectureSplitOptionsCommon {
  readonly mode: "keep";
  /** 与解析产出同源的题目容器节点（读开围栏属性判显式 id；题块行区间由此派生） */
  readonly questionNodes: readonly ContainerDirective[];
  /** 解析产出的题目（按文档顺序；返回开围栏注入后的新数组） */
  readonly questions: readonly Question[];
}

/** 切分选项（判别联合，按 mode 收窄） */
export type LectureSplitOptions =
  | LectureSplitOptionsStrip
  | LectureSplitOptionsKeep;

/** 切分结果：h1Count 供调用方决定是否记 MISSING_HEADING（仅 kind: lecture 记 error） */
export interface LectureSplitResult {
  readonly lectures: Lecture[];
  readonly h1Count: number;
  /** keep 模式携带：开围栏已注入 id 的题目数组（sourceMd 同步注入）；strip 模式无此键 */
  readonly questions?: readonly Question[];
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
 * 把文档顶层节点按 H1 切分成多篇讲义（kind: lecture / mixed / lesson 共用）。
 * 纯函数：结构性问题（H1 前正文、空 H1）只记 issue，不抛异常。
 */
export function splitLectures(
  options: LectureSplitOptions,
): LectureSplitResult {
  const { children, lines, contentStartLine, issues } = options;
  const h1Nodes = children.filter((child) => isH1(child));
  if (h1Nodes.length === 0) return { lectures: [], h1Count: 0 };

  // keep 模式（讲练页）：先把缺省题目 id 注入题块开围栏（讲义 markdown 与题目
  // sourceMd 同步写入），切分时不再剔除题块行区间；strip 模式维持既有剔除行为
  const injected =
    options.mode === "keep" ? injectQuestionFenceIds(options) : undefined;
  const sliceSource = injected?.lines ?? lines;
  // 题块行区间：strip 用调用方传入（从讲义原文剔除）；keep 按 questionNodes
  // 派生（仅用于 H1 前正文检测的排除区间，讲义切分不剔除题块）
  const questionRanges =
    options.mode === "keep"
      ? options.questionNodes.map(lineRange)
      : options.questionRanges;
  const excluded = options.mode === "keep" ? [] : questionRanges;

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
        sliceSource,
        segmentStart,
        segmentEnd,
        excluded,
      ),
      headings: collectHeadings(children, h1Start, segmentEnd),
    });
  }
  const result: LectureSplitResult = { lectures, h1Count: h1Nodes.length };
  return injected === undefined
    ? result
    : { ...result, questions: injected.questions };
}

// ---------- keep 模式：题目开围栏注入最终题目 id（讲练页，方案决策 8） ----------

/** keep 模式注入结果：替换后的行数组与 sourceMd 同步注入的题目数组 */
interface FenceInjected {
  readonly lines: readonly string[];
  readonly questions: readonly Question[];
}

/**
 * 对每个没有显式 id 的题目容器，把最终题目 id 注入开围栏（行数不变，行号全部
 * 保持有效）。注入同时写进该题 sourceMd（题目编辑/reparse 往返 id 稳定）。
 * 与解析产出的对齐沿用 lint/questions.ts 的对位法：同一容器切同一批原文行，
 * 被丢弃的题（type 缺失/未知，解析层已报 error）不占位、不注入。
 */
function injectQuestionFenceIds(
  options: LectureSplitOptionsKeep,
): FenceInjected {
  const { lines, questionNodes, questions } = options;
  const next = [...lines];
  const updated = [...questions];
  let keptIndex = 0;
  for (const node of questionNodes) {
    const [startLine, endLine] = lineRange(node);
    const question = updated[keptIndex];
    // 与解析产出按行区间精确对齐（同容器同切片；不匹配 = 被丢弃的题）
    if (
      question === undefined ||
      question.sourceMd !== sliceLines(lines, startLine, endLine)
    ) {
      continue;
    }
    keptIndex += 1;
    // 已有显式 id（含 {#id} 简写，remark-directive 归一到 attributes.id）：不重复注入
    if (firstNonEmpty(node.attributes?.id ?? undefined) !== undefined) {
      continue;
    }
    const quoted = quoteDirectiveValue(question.id);
    // id 含两种引号或换行时无法在属性值里安全表示：保持原围栏（重解析仍按缺省规则复原 id）
    if (quoted === undefined) continue;
    const fenceRow = next[startLine - 1] ?? "";
    const injectedRow = appendFenceAttr(fenceRow, "id", quoted);
    if (injectedRow === undefined) continue; // 开围栏行形态意外（防御，不应发生）
    next[startLine - 1] = injectedRow;
    updated[keptIndex - 1] = {
      ...question,
      sourceMd: sliceLines(next, startLine, endLine),
    };
  }
  return { lines: next, questions: updated };
}

/** question 开围栏行：`::::question` 可带 `[标签]` 与 `{属性}`（前后可有空白） */
const QUESTION_FENCE_RE = /^(\s*:+question(?:\[[^\]]*\])?)(\{.*\})?(\s*)$/;

/** 往开围栏行追加一个属性（无属性括号则补上）；形态不匹配返回 undefined（调用方跳过） */
function appendFenceAttr(
  fence: string,
  key: string,
  quotedValue: string,
): string | undefined {
  const match = QUESTION_FENCE_RE.exec(fence);
  if (match === null) return undefined;
  const [, prefix, attrs, trailing] = match;
  if (prefix === undefined) return undefined;
  const attr = `${key}=${quotedValue}`;
  if (attrs === undefined) {
    return `${prefix}{${attr}}${trailing ?? ""}`;
  }
  const inner = attrs.slice(1, -1).trimEnd();
  return `${prefix}{${inner.length > 0 ? `${inner} ` : ""}${attr}}${
    trailing ?? ""
  }`;
}

/**
 * 指令属性值的安全引号形式：remark-directive 的属性值不支持 `\"` 转义
 * （实测双引号值内不能出现双引号、反斜杠按字面保留），因此按值内引号选择
 * 包裹引号；两种引号都出现（或含换行）时无法安全表示，返回 undefined 由
 * 调用方跳过注入。
 */
function quoteDirectiveValue(value: string): string | undefined {
  if (/[\r\n]/.test(value)) return undefined;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return undefined;
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
