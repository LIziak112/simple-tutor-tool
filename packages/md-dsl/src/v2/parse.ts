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
import { extractFrontmatter } from "./frontmatter.ts";
import { headingText, isH1, splitLectures } from "./lecture.ts";
import { extractQuestions, isQuestionContainer } from "./question.ts";
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
} from "./shared.ts";

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
 * - fallbackUnitId：单元名缺省锚定文件名（内容模型与导入规范化方案 §2，仅 frontmatter.unit
 *   缺失时生效）：优先级低于 frontmatter 与 unitId（reparse/单题编辑路径行为不变），
 *   导入分析（analyzeImport）按文件名传入；生效时记 warning UNIT_FROM_FALLBACK。
 */
export interface ParseOptions {
  readonly unitId?: string;
  readonly questionStartNumber?: number;
  readonly fallbackUnitId?: string;
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
  /**
   * 单元名实际取自 fallbackUnitId（方案 §2）时的值；其余来源为 undefined。
   * 非 undefined 时组装单元要记 warning UNIT_FROM_FALLBACK。
   */
  readonly unitFromFallback: string | undefined;
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

  // 单元名链（方案 §2）：unitId 取 调用方覆盖 > frontmatter.unit > fallbackUnitId（文件名）> 兜底值；
  // unitTitle 同链但 frontmatter.unit 优先（现状）。fallback 仅在前两者都缺时生效并记入 unitFromFallback
  const frontmatterUnit = firstNonEmpty(frontmatter?.unit);
  const optionUnitId = firstNonEmpty(options.unitId);
  const fallbackUnit = firstNonEmpty(options.fallbackUnitId);
  const ctx: ParseContext = {
    tree,
    lines,
    frontmatter,
    contentStartLine: (yamlNode?.position?.end.line ?? 0) + 1,
    unitId: optionUnitId ?? frontmatterUnit ?? fallbackUnit ?? FALLBACK_UNIT_ID,
    unitTitle:
      frontmatterUnit ?? optionUnitId ?? fallbackUnit ?? FALLBACK_UNIT_TITLE,
    unitFromFallback:
      frontmatterUnit === undefined && optionUnitId === undefined
        ? fallbackUnit
        : undefined,
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
  // practice 文档不产出讲义，title 无处安放（方案 §3）：声明了就提示删除
  if (firstNonEmpty(ctx.frontmatter?.title) !== undefined) {
    ctx.issues.push(
      makeIssue(
        "warning",
        1,
        1,
        "TITLE_NOT_APPLICABLE",
        "kind: practice 文档没有讲义，frontmatter 的 title 不适用（title 是讲义显示名，仅 lecture/mixed 生效）；请删除该字段",
      ),
    );
  }

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
  return { lectures: applyLectureTitleOverride(ctx, split.lectures), units };
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

  // 先应用 title 讲义命名链（方案 §3）：单讲义被 frontmatter.title 改名后，
  // 下方按题目位置推断的配套指针必须指向覆盖后的最终讲义名（存储后的名字）
  const lectures = applyLectureTitleOverride(ctx, split.lectures);

  // 全部题目进同一个单元；关联讲义：显式 frontmatter.lecture 优先，缺省按题目位置推断
  const units: Unit[] = [];
  if (questions.length > 0) {
    let lectureTitle = firstNonEmpty(ctx.frontmatter?.lecture);
    const inferred = firstNonEmpty(lastQuestionLectureTitle);
    if (lectureTitle === undefined && inferred !== undefined) {
      // 推断命中且是单讲义文件：配套指针指向 title 覆盖后的最终讲义名（存储后的名字）；
      // 多讲义文件逐篇按各自 H1，推断值即 H1 文本（不变）
      const single = lectures.length === 1 ? lectures[0] : undefined;
      lectureTitle = single !== undefined ? single.title : inferred;
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
  return { lectures, units };
}

// ---------- 公共组装 ----------

/**
 * 应用 frontmatter.title 讲义命名链（内容模型与导入规范化方案 §3）：
 * - 单讲义文件（产出恰 1 篇）：title 覆盖该讲显示名，markdown 原文不动（H1 行保留）；
 * - 多讲义文件（≥2 篇）：逐篇按各自 H1（现状不变），声明的 title 记 warning 提示被忽略；
 * - 未声明 title：原样返回（现状）。
 */
function applyLectureTitleOverride(
  ctx: ParseContext,
  lectures: Lecture[],
): Lecture[] {
  const declared = firstNonEmpty(ctx.frontmatter?.title);
  if (declared === undefined) return lectures;
  const [single] = lectures;
  if (single !== undefined && lectures.length === 1) {
    return [{ ...single, title: declared }];
  }
  if (lectures.length >= 2) {
    ctx.issues.push(
      makeIssue(
        "warning",
        1,
        1,
        "TITLE_IGNORED_MULTI_LECTURE",
        `frontmatter 的 title 在多讲义文件中被忽略（本文件切分为 ${lectures.length} 篇讲义，逐篇按各自 H1 命名）；如需指定讲义名，请直接修改对应 H1 标题`,
      ),
    );
  }
  return lectures;
}

/** 组装单元：id/标题/topic/lectureTitle 清洗规则与 T1.3 完全一致 */
function buildUnit(
  ctx: ParseContext,
  questions: Question[],
  lectureTitle: string | undefined,
): Unit {
  if (ctx.unitFromFallback !== undefined) {
    ctx.issues.push(
      makeIssue(
        "warning",
        1,
        1,
        "UNIT_FROM_FALLBACK",
        `单元名取自文件名「${ctx.unitFromFallback}」（frontmatter 未声明 unit）：建议在 frontmatter 显式声明 unit——文件改名会改变单元身份，重导时将新建单元而非合并`,
      ),
    );
  }
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
