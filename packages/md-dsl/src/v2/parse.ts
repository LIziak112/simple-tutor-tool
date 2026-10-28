import {
  type DocumentFrontmatter,
  type Lecture,
  type LintIssue,
  type Material,
  type ParsedDocument,
  parsedDocumentSchema,
  type Question,
  type QuestionGroup,
  type Unit,
} from "@tutor/contract";
import type { Root, RootContent } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import { extractFrontmatter } from "./frontmatter.ts";
import { headingText, isH1, splitLectures } from "./lecture.ts";
import {
  extractMaterialsAndGroups,
  type MaterialsResult,
} from "./materials.ts";
import { extractQuestions, isQuestionContainer } from "./question.ts";
import { type QmRefSite, resolveQmReferences } from "./references.ts";
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

/** 两遍解析实体行号合并（题与材料/组同域；后者者覆盖前者——题行只做兜底定位） */
function mergeMaps(
  first: ReadonlyMap<string, number>,
  second: ReadonlyMap<string, number>,
): Map<string, number> {
  return new Map([...first, ...second]);
}

/**
 * DSL v2 文档解析入口（T1.3 练习题；T1.4 起按 frontmatter kind 分派）：
 * - practice：抽取题目 → 单元（T1.3 行为原样保留）；
 * - lecture：按 H1「第X讲」切分多篇讲义，抽取 H2/H3 目录（lecture.ts）；
 * - mixed：讲义段与题目拆分，题目归入同一单元并经 lectureTitle 关联（lecture.ts）；
 * - lesson：讲练页（2026-10 讲练一体）——与 mixed 同构，但题块以 keep 模式
 *   原位保留在讲义 markdown（缺省题目 id 注入开围栏），供学生端单题作答切段。
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
  readonly fallbackUnitId?: string | undefined;
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
        "缺少 YAML frontmatter：文档必须以「---」围栏开头，并在其中声明 kind: practice | lecture | mixed。如这是旧版 v1 格式文档：v1 已停止支持，请按 docs/dsl/规范.md 改写为 v2 后再导入",
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
  // tt-06b / QM-05：顶层材料/组完整形态（含 sourceMd——unit.groups 经契约校验后
  // 是索引形态）；导入落库从这里取实体。仅在存在时挂载（旧文档键集不变）
  let body: {
    lectures: Lecture[];
    units: Unit[];
    materials?: Material[];
    groups?: QuestionGroup[];
  };
  switch (kind) {
    case "lecture":
      body = parseLectureDocument(ctx);
      break;
    case "mixed":
      body = parseMixedDocument(ctx);
      break;
    case "lesson":
      body = parseLessonDocument(ctx);
      break;
    default:
      body = parsePracticeDocument(ctx);
      break;
  }

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

  // TT-06 两遍解析的站点收集器（题级 ::ref 位置与题目起始行；组/材料站点在
  // extractMaterialsAndGroups 内登记，第二遍统一裁决）
  const qmSites: QmRefSite[] = [];
  const qmEntityLines = new Map<string, number>();

  const questions = extractQuestions(ctx.tree.children, {
    lines: ctx.lines,
    unitId: ctx.unitId,
    startNumber: ctx.options.questionStartNumber ?? 1,
    issues: ctx.issues,
    qmRefSites: qmSites,
    qmEntityLines: qmEntityLines,
  });

  // TT-06 材料/组实体（第一遍）：practice 文档顶层声明，挂载进单元叠加元数据
  const qm = extractMaterialsAndGroups(ctx.tree.children, {
    lines: ctx.lines,
    unitId: ctx.unitId,
    issues: ctx.issues,
  });

  // 两遍解析第二遍：引用解析与结构校验（§5.4.4；向后引用在此闭合）
  resolveQmReferences({
    materials: qm.materials,
    groups: qm.groups,
    questions,
    sites: [...qm.sites, ...qmSites],
    entityLines: mergeMaps(qm.entityLines, qmEntityLines),
    issues: ctx.issues,
  });

  // 组装单元：有题目，或是练习文档（空练习也产出单元，供导入层提示）。
  // 注意判空单元看的是「显式 kind: practice」：缺 frontmatter 且无题时不出空单元（T1.3 行为）
  const units: Unit[] = [];
  if (questions.length > 0 || ctx.frontmatter?.kind === "practice") {
    units.push(
      buildUnit(ctx, questions, firstNonEmpty(ctx.frontmatter?.lecture), qm),
    );
  }
  return {
    lectures: [],
    units,
    ...(qm.materials.length > 0 ? { materials: [...qm.materials] } : {}),
    ...(qm.groups.length > 0 ? { groups: [...qm.groups] } : {}),
  };
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
    mode: "strip",
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

// ---------- mixed（T1.4）/ lesson（2026-10 讲练一体） ----------

/**
 * mixed/lesson 共用：单次遍历分流顶层题目容器，并跟踪「最后一题出现位置所处的
 * 那一讲」（最后一题之前最近的 H1 标题；全部题目都在第一个 H1 之前则无关联值）。
 */
function trackQuestionContainers(children: readonly RootContent[]): {
  readonly questionNodes: ContainerDirective[];
  readonly lastQuestionLectureTitle: string | undefined;
} {
  const questionNodes: ContainerDirective[] = [];
  let currentH1Title: string | undefined;
  let lastQuestionLectureTitle: string | undefined;
  for (const child of children) {
    if (isQuestionContainer(child)) {
      questionNodes.push(child);
      lastQuestionLectureTitle = currentH1Title;
    } else if (isH1(child)) {
      currentH1Title = headingText(child).trim();
    }
  }
  return { questionNodes, lastQuestionLectureTitle };
}

/**
 * mixed/lesson 共用的配套讲义推断链：显式 frontmatter.lecture 优先 → 位置推断
 * （单讲义文件指向 title 覆盖后的最终讲义名，即存储后的名字；多讲义逐篇按各自
 * H1，推断值即 H1 文本）→ 都没有记 QUESTION_BEFORE_FIRST_HEADING（warning）。
 */
function inferUnitLectureTitle(
  ctx: ParseContext,
  lectures: Lecture[],
  inferred: string | undefined,
  firstQuestion: ContainerDirective | undefined,
  declared: string | undefined,
): string | undefined {
  let lectureTitle = declared;
  if (lectureTitle === undefined && firstNonEmpty(inferred) !== undefined) {
    const single = lectures.length === 1 ? lectures[0] : undefined;
    lectureTitle =
      single !== undefined ? single.title : firstNonEmpty(inferred);
  }
  if (lectureTitle === undefined) {
    ctx.issues.push(
      makeIssue(
        "warning",
        firstQuestion?.position?.start.line ?? 1,
        firstQuestion?.position?.start.column ?? 1,
        "QUESTION_BEFORE_FIRST_HEADING",
        "所有题目都出现在第一个 H1 讲义标题之前，练习单元无法关联讲义（unit.lectureTitle 缺省）；请把题目移到对应讲义内容之后，或在 frontmatter 中显式声明 lecture: 讲义标题",
      ),
    );
  }
  return lectureTitle;
}

function parseMixedDocument(ctx: ParseContext): {
  lectures: Lecture[];
  units: Unit[];
} {
  const { questionNodes, lastQuestionLectureTitle } = trackQuestionContainers(
    ctx.tree.children,
  );

  // TT-06 站点收集器（与 parsePracticeDocument 同款，见该处注释）
  const qmSites: QmRefSite[] = [];
  const qmEntityLines = new Map<string, number>();

  const questions = extractQuestions(ctx.tree.children, {
    lines: ctx.lines,
    unitId: ctx.unitId,
    startNumber: ctx.options.questionStartNumber ?? 1,
    issues: ctx.issues,
    qmRefSites: qmSites,
    qmEntityLines: qmEntityLines,
  });

  // TT-06 材料/组实体：mixed 的练习单元同款挂载；容器行区间与题块一同从
  // 讲义原文剔除（§5.2.1「与题块同规则」——材料/组是单元结构，不是讲义内容）
  const qm = extractMaterialsAndGroups(ctx.tree.children, {
    lines: ctx.lines,
    unitId: ctx.unitId,
    issues: ctx.issues,
  });

  // 两遍解析第二遍（与 practice 同款）
  resolveQmReferences({
    materials: qm.materials,
    groups: qm.groups,
    questions,
    sites: [...qm.sites, ...qmSites],
    entityLines: mergeMaps(qm.entityLines, qmEntityLines),
    issues: ctx.issues,
  });

  const split = splitLectures({
    mode: "strip",
    children: ctx.tree.children,
    lines: ctx.lines,
    contentStartLine: ctx.contentStartLine,
    questionRanges: [...questionNodes.map(lineRange), ...qm.containerRanges],
    issues: ctx.issues,
  });

  // 先应用 title 讲义命名链（方案 §3）：单讲义被 frontmatter.title 改名后，
  // 下方按题目位置推断的配套指针必须指向覆盖后的最终讲义名（存储后的名字）
  const lectures = applyLectureTitleOverride(ctx, split.lectures);

  // 全部题目进同一个单元；关联讲义：显式 frontmatter.lecture 优先，缺省按题目位置推断
  const units: Unit[] = [];
  if (questions.length > 0) {
    const lectureTitle = inferUnitLectureTitle(
      ctx,
      lectures,
      lastQuestionLectureTitle,
      questionNodes[0],
      firstNonEmpty(ctx.frontmatter?.lecture),
    );
    units.push(buildUnit(ctx, questions, lectureTitle, qm));
  }
  return {
    lectures,
    units,
    ...(qm.materials.length > 0 ? { materials: [...qm.materials] } : {}),
    ...(qm.groups.length > 0 ? { groups: [...qm.groups] } : {}),
  };
}

// ---------- lesson（2026-10 讲练一体：讲练页） ----------

/**
 * 讲练页解析：结构与 mixed 同构（题目全收单单元、lectureTitle 推断链复用、
 * QUESTION_BEFORE_FIRST_HEADING 同款），差异两点：
 * 1. splitLectures 用 keep 模式——题块原位保留在讲义 markdown，缺省题目 id
 *    注入开围栏（同一注入写进题目 sourceMd，往返稳定，方案决策 8）；
 * 2. 讲练页不产生 QUESTION_IN_LECTURE（题块本就合法）；零题记 warning
 *    LESSON_WITHOUT_QUESTION（建议改用 kind: lecture，不阻断）。
 */
function parseLessonDocument(ctx: ParseContext): {
  lectures: Lecture[];
  units: Unit[];
  materials?: Material[];
  groups?: QuestionGroup[];
} {
  const { questionNodes, lastQuestionLectureTitle } = trackQuestionContainers(
    ctx.tree.children,
  );

  // TT-06 两遍解析的站点收集器（题级 ::ref 位置与题目起始行；组/材料站点在
  // extractMaterialsAndGroups 内登记，第二遍统一裁决）
  const qmSites: QmRefSite[] = [];
  const qmEntityLines = new Map<string, number>();

  let questions: Question[] = extractQuestions(ctx.tree.children, {
    lines: ctx.lines,
    unitId: ctx.unitId,
    startNumber: ctx.options.questionStartNumber ?? 1,
    issues: ctx.issues,
    qmRefSites: qmSites,
    qmEntityLines: qmEntityLines,
  });

  // QM-14（讲练原位适配）：材料/组实体抽取与 practice/mixed 同构——组用
  // ::ref 表达、不物理包含子题，故不触碰 lesson 的嵌套安全前提（设计
  // 方案「组声明引用子题，不在 question 中直接嵌 question」）。此前 lesson
  // 不抽取材料/组，题级 ::ref 索引进库而实体缺失，讲练开卷闭包 fail closed
  const qm = extractMaterialsAndGroups(ctx.tree.children, {
    lines: ctx.lines,
    unitId: ctx.unitId,
    issues: ctx.issues,
  });

  // 两遍解析第二遍：引用解析与结构校验（与 practice/mixed 同款）
  resolveQmReferences({
    materials: qm.materials,
    groups: qm.groups,
    questions,
    sites: [...qm.sites, ...qmSites],
    entityLines: mergeMaps(qm.entityLines, qmEntityLines),
    issues: ctx.issues,
  });

  const split = splitLectures({
    mode: "keep",
    children: ctx.tree.children,
    lines: ctx.lines,
    contentStartLine: ctx.contentStartLine,
    issues: ctx.issues,
    questionNodes,
    questions,
  });
  // keep 模式返回注入 id 后的题目数组（浅拷贝回可变形态，契约 Unit.questions 是可变数组）
  if (split.questions !== undefined) questions = [...split.questions];

  // title 讲义命名链与 mixed 同款（推断指针指向覆盖后的最终讲义名）
  const lectures = applyLectureTitleOverride(ctx, split.lectures);

  // 零题守卫：讲练页没有题目就退化为普通讲义（warning 不阻断，讲义照常产出）
  if (questions.length === 0) {
    ctx.issues.push(
      makeIssue(
        "warning",
        1,
        1,
        "LESSON_WITHOUT_QUESTION",
        "讲练页没有题目，建议改用 kind: lecture（warning 不阻断：讲义部分照常导入，只是没有单题作答的练习）",
      ),
    );
  }

  const units: Unit[] = [];
  if (questions.length > 0) {
    // 讲练单元恒关联本篇讲练页自身：frontmatter lecture 只允许指向本篇标题。
    // 与 practice/mixed 的「配套讲义」语义不同——那边按名匹配既有讲义是预期
    // 行为；讲练页若按名匹配到其他讲义，页内将反查不到自己的题目（学生端
    // 零题兜底），2026-10-15 考公案例（lecture 与大标题不一致 + 同名既有讲义）。
    const declared = firstNonEmpty(ctx.frontmatter?.lecture);
    const ownTitles = new Set(lectures.map((lecture) => lecture.title));
    const declaredIsOwn = declared !== undefined && ownTitles.has(declared);
    if (declared !== undefined && !declaredIsOwn) {
      ctx.issues.push(
        makeIssue(
          "warning",
          1,
          1,
          "LESSON_LECTURE_TITLE_MISMATCH",
          `讲练页（kind: lesson）的 frontmatter lecture「${declared}」与本篇任何讲练页标题都不一致：讲练单元不关联其他讲义（那是 practice/mixed 的配套讲义用法），已按题目位置改关联本篇讲练页；请让 lecture 与讲练页大标题一致`,
        ),
      );
    }
    const lectureTitle = inferUnitLectureTitle(
      ctx,
      lectures,
      lastQuestionLectureTitle,
      questionNodes[0],
      declaredIsOwn ? declared : undefined,
    );
    units.push(buildUnit(ctx, questions, lectureTitle, qm));
  }
  return {
    lectures,
    units,
    ...(qm.materials.length > 0 ? { materials: [...qm.materials] } : {}),
    ...(qm.groups.length > 0 ? { groups: [...qm.groups] } : {}),
  };
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
  /** TT-06 材料/组实体（两遍解析第一遍产物）；缺省不注入键（§5.8.1） */
  qm?: MaterialsResult,
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
  // practice 推荐（M5-D1）只对练习形态单元生效：kind practice/mixed 贯通进单元，
  // lecture/lesson 不携带（lint 层 PRACTICE_NOT_APPLICABLE 另行提示作者）。
  // 缺省不注入键（契约同口径）：老文档解析结果形状不变。
  const kind = ctx.frontmatter?.kind ?? "practice";
  if (
    (kind === "practice" || kind === "mixed") &&
    ctx.frontmatter?.practice !== undefined
  ) {
    unit.practice = ctx.frontmatter.practice;
  }
  // TT-06：材料与组是叠加元数据（§5.2.4）——不产生题行、不进 questions 平铺
  // 数组；仅在存在时挂载（旧文档解析结果键集不变）
  if (qm !== undefined && qm.materials.length > 0)
    unit.materials = [...qm.materials];
  if (qm !== undefined && qm.groups.length > 0) unit.groups = [...qm.groups];
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
