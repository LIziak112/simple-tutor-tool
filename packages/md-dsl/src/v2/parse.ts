import {
  type DocumentFrontmatter,
  type Lecture,
  type LintIssue,
  type ParsedDocument,
  parsedDocumentSchema,
  type Question,
  type Unit,
} from "@tutor/contract";
import type { Root } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import { extractFrontmatter } from "./frontmatter";
import { headingText, isH1, splitLectures } from "./lecture";
import { extractQuestions, isQuestionContainer } from "./question";
import {
  errorMessage,
  FALLBACK_UNIT_ID,
  FALLBACK_UNIT_TITLE,
  firstNonEmpty,
  isYaml,
  lineRange,
  makeIssue,
  processor,
  zodErrorsText,
} from "./shared";

/**
 * DSL v2 文档解析入口（T1.3 练习题；T1.4 起按 frontmatter kind 分派）：
 * - practice：抽取题目 → 单元（T1.3 行为原样保留）；
 * - lecture：按 H1「第X讲」切分多篇讲义，抽取 H2/H3 目录（lecture.ts）；
 * - mixed：讲义段与题目拆分，题目归入同一单元并经 lectureTitle 关联（lecture.ts）。
 *
 * 依据：docs/技术架构与实施方案.md §5.1（语法与规则要点表）、§5.1.1(4)（原文是真相）、
 * §5.3（讲义自动目录 H2/H3）、docs/开发任务清单.md T1.3/T1.4。
 *
 * 设计约定：
 * 1. 纯函数、不抛异常：结构性错误（缺 frontmatter、坏 YAML、未知题型等）全部记入 issues
 *    （code 为 UPPER_SNAKE，line/column 从 AST position 取、均 1 起）。全面的 lint 规则
 *    属 T1.5，本层只报"解析器自然发现"的错误。
 * 2. 输出最终经 parsedDocumentSchema 校验（契约兜底）：解析器产出永远符合 T1.1 契约。
 */

/**
 * 解析选项（reparse 场景使用）：
 * - unitId：缺省单元 id。无 frontmatter.unit 时用它生成缺省题目 id 与单元 id。
 *   T1.12 单题编辑 / T1.14 reparse 时由调用方传入原单元 id，保证缺省 id 可复现；
 * - questionStartNumber：缺省题目序号起点（缺省 1）。reparse 单题片段时传入原题序号。
 */
export interface ParseOptions {
  readonly unitId?: string;
  readonly questionStartNumber?: number;
}

/**
 * 解析 v2 DSL 文档，返回符合内容契约的 ParsedDocument。
 * 纯函数、不抛异常：任何错误以 issue 形式返回。
 */
export function parseDocument(
  md: string,
  options: ParseOptions = {},
): ParsedDocument {
  try {
    return parseInner(md, options);
  } catch (err) {
    // 兜底：解析器是纯函数，内部缺陷也不得外抛（宁可返回一条内部错误 issue）
    return {
      lectures: [],
      units: [],
      issues: [
        makeIssue(
          "error",
          1,
          1,
          "PARSE_INTERNAL_ERROR",
          `解析器内部错误（这是解析器缺陷，请反馈给开发者）：${errorMessage(err)}`,
        ),
      ],
    };
  }
}

/** 三条 kind 路径共用的解析现场 */
interface ParseContext {
  readonly tree: Root;
  readonly lines: readonly string[];
  readonly frontmatter: DocumentFrontmatter | undefined;
  /** 正文起始行（frontmatter 结束行的下一行；无 frontmatter 时为 1） */
  readonly contentStartLine: number;
  readonly unitId: string;
  readonly unitTitle: string;
  readonly options: ParseOptions;
  readonly issues: LintIssue[];
}

function parseInner(md: string, options: ParseOptions): ParsedDocument {
  const tree: Root = processor.parse(md);
  const lines = md.split(/\r?\n/);
  const issues: LintIssue[] = [];

  // ---- frontmatter ----
  const yamlNode = tree.children.find((child) => isYaml(child));
  let frontmatter: DocumentFrontmatter | undefined;
  if (yamlNode === undefined) {
    issues.push(
      makeIssue(
        "error",
        1,
        1,
        "MISSING_FRONTMATTER",
        "缺少 YAML frontmatter：文档必须以「---」围栏开头，并在其中声明 kind: practice | lecture | mixed",
      ),
    );
  } else {
    frontmatter = extractFrontmatter(yamlNode, issues);
  }

  const ctx: ParseContext = {
    tree,
    lines,
    frontmatter,
    contentStartLine: (yamlNode?.position?.end.line ?? 0) + 1,
    // 单元 id：调用方覆盖 > frontmatter.unit（原样保留中文，仅 trim）> 兜底值
    unitId:
      firstNonEmpty(options.unitId, frontmatter?.unit) ?? FALLBACK_UNIT_ID,
    unitTitle:
      firstNonEmpty(frontmatter?.unit, options.unitId) ?? FALLBACK_UNIT_TITLE,
    options,
    issues,
  };

  // ---- kind 分派：frontmatter 不可用时按 practice 继续（题目仍尽量解析，T1.3 行为） ----
  const kind = frontmatter?.kind ?? "practice";
  const body =
    kind === "lecture"
      ? parseLectureDocument(ctx)
      : kind === "mixed"
        ? parseMixedDocument(ctx)
        : parsePracticeDocument(ctx);

  // ---- 契约兜底：产出必须永远符合 T1.1 契约 ----
  return finalize({ ...body, issues }, frontmatter);
}

// ---------- practice（T1.3 行为原样保留） ----------

function parsePracticeDocument(ctx: ParseContext): {
  lectures: Lecture[];
  units: Unit[];
} {
  const questions = extractQuestions(ctx.tree.children, {
    lines: ctx.lines,
    unitId: ctx.unitId,
    startNumber: ctx.options.questionStartNumber ?? 1,
    issues: ctx.issues,
  });

  // 组装单元：有题目，或是练习文档（空练习也产出单元，供导入层提示）。
  // 注意判空单元看的是「显式 kind: practice」：缺 frontmatter 且无题时不出空单元（T1.3 行为）
  const units: Unit[] = [];
  if (questions.length > 0 || ctx.frontmatter?.kind === "practice") {
    units.push(
      buildUnit(ctx, questions, firstNonEmpty(ctx.frontmatter?.lecture)),
    );
  }
  return { lectures: [], units };
}

// ---------- lecture（T1.4） ----------

function parseLectureDocument(ctx: ParseContext): {
  lectures: Lecture[];
  units: Unit[];
} {
  // kind: lecture 出现题目容器属结构错误（派单裁决）：报 error 建议改 mixed，
  // 题目照常解析收集进单元（不静默丢弃），导入端因 error 拒绝提交
  const questionNodes = ctx.tree.children.filter(isQuestionContainer);
  for (const node of questionNodes) {
    ctx.issues.push(
      makeIssue(
        "error",
        node.position?.start.line ?? 1,
        node.position?.start.column ?? 1,
        "QUESTION_IN_LECTURE",
        "kind: lecture 文档不能包含题目容器：如需讲义与题目混排，请把 frontmatter 的 kind 改为 mixed（该题已照常解析收集进单元，导入将因本 error 被拒绝）",
      ),
    );
  }
  const questions = extractQuestions(ctx.tree.children, {
    lines: ctx.lines,
    unitId: ctx.unitId,
    startNumber: ctx.options.questionStartNumber ?? 1,
    issues: ctx.issues,
  });

  // 讲义切分（题目容器行区间从讲义原文中剔除，与 mixed 一致）
  const split = splitLectures({
    children: ctx.tree.children,
    lines: ctx.lines,
    contentStartLine: ctx.contentStartLine,
    questionRanges: questionNodes.map(lineRange),
    issues: ctx.issues,
  });
  if (split.h1Count === 0) {
    ctx.issues.push(
      makeIssue(
        "error",
        ctx.contentStartLine,
        1,
        "MISSING_HEADING",
        "kind: lecture 文档未找到任何 H1 讲义标题：至少需要一个「# 第X讲 …」用于切分讲义",
      ),
    );
  }

  const units: Unit[] = [];
  if (questions.length > 0) {
    units.push(
      buildUnit(ctx, questions, firstNonEmpty(ctx.frontmatter?.lecture)),
    );
  }
  return { lectures: split.lectures, units };
}

// ---------- mixed（T1.4） ----------

function parseMixedDocument(ctx: ParseContext): {
  lectures: Lecture[];
  units: Unit[];
} {
  // 单次遍历：分流题目容器，并跟踪「最后一题出现位置所处的那一讲」
  //（最后一题之前最近的 H1 标题；全部题目都在第一个 H1 之前则无关联，记 warning）
  const questionNodes: ContainerDirective[] = [];
  let currentH1Title: string | undefined;
  let lastQuestionLectureTitle: string | undefined;
  for (const child of ctx.tree.children) {
    if (isQuestionContainer(child)) {
      questionNodes.push(child);
      lastQuestionLectureTitle = currentH1Title;
    } else if (isH1(child)) {
      currentH1Title = headingText(child).trim();
    }
  }

  const questions = extractQuestions(ctx.tree.children, {
    lines: ctx.lines,
    unitId: ctx.unitId,
    startNumber: ctx.options.questionStartNumber ?? 1,
    issues: ctx.issues,
  });

  const split = splitLectures({
    children: ctx.tree.children,
    lines: ctx.lines,
    contentStartLine: ctx.contentStartLine,
    questionRanges: questionNodes.map(lineRange),
    issues: ctx.issues,
  });

  // 全部题目进同一个单元；关联讲义：显式 frontmatter.lecture 优先，缺省按题目位置推断
  const units: Unit[] = [];
  if (questions.length > 0) {
    let lectureTitle = firstNonEmpty(ctx.frontmatter?.lecture);
    if (lectureTitle === undefined) {
      lectureTitle = firstNonEmpty(lastQuestionLectureTitle);
    }
    if (lectureTitle === undefined) {
      ctx.issues.push(
        makeIssue(
          "warning",
          questionNodes[0]?.position?.start.line ?? 1,
          questionNodes[0]?.position?.start.column ?? 1,
          "QUESTION_BEFORE_FIRST_HEADING",
          "所有题目都出现在第一个 H1 讲义标题之前，练习单元无法关联讲义（unit.lectureTitle 缺省）；请把题目移到对应讲义内容之后，或在 frontmatter 中显式声明 lecture: 讲义标题",
        ),
      );
    }
    units.push(buildUnit(ctx, questions, lectureTitle));
  }
  return { lectures: split.lectures, units };
}

// ---------- 公共组装 ----------

/** 组装单元：id/标题/topic/lectureTitle 清洗规则与 T1.3 完全一致 */
function buildUnit(
  ctx: ParseContext,
  questions: Question[],
  lectureTitle: string | undefined,
): Unit {
  const unit: Unit = {
    id: ctx.unitId,
    title: ctx.unitTitle,
    questions,
  };
  const topic = firstNonEmpty(ctx.frontmatter?.topic);
  if (topic !== undefined) unit.topic = topic;
  const title = firstNonEmpty(lectureTitle);
  if (title !== undefined) unit.lectureTitle = title;
  return unit;
}

/** 输出经契约 schema 校验后返回；不通过则压成一条内部错误（解析器缺陷） */
function finalize(
  result: ParsedDocument,
  frontmatter: DocumentFrontmatter | undefined,
): ParsedDocument {
  const withFrontmatter: ParsedDocument =
    frontmatter === undefined ? result : { ...result, frontmatter };
  const checked = parsedDocumentSchema.safeParse(withFrontmatter);
  if (checked.success) return checked.data;
  return {
    lectures: [],
    units: [],
    issues: [
      makeIssue(
        "error",
        1,
        1,
        "PARSE_OUTPUT_INVALID",
        `解析结果不符合内容契约（这是解析器缺陷，请反馈给开发者）：${zodErrorsText(checked.error)}`,
      ),
    ],
  };
}
