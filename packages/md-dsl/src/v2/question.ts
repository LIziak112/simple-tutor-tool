import {
  defaultItemIdOf,
  defaultOptionIdOf,
  type LintIssue,
  type MaterialRef,
  optionsDirective,
  type Question,
  type QuestionAnswers,
  type QuestionDirectiveAttrs,
  questionDirective,
} from "@tutor/contract";
import type { ListItem, RootContent } from "mdast";
import type { ContainerDirective, LeafDirective } from "mdast-util-directive";
import type { Node } from "unist";
import { SKIP, visit } from "unist-util-visit";
import { materialRefOf, parseRefAttrs } from "./materials.ts";
import type { QmRefSite } from "./references.ts";
import {
  canonicalName,
  FENCE_ATTR_ID_RE,
  isContainer,
  isText,
  lineRange,
  makeIssue,
  QUESTION_FENCE_RE,
  sliceInnerLines,
  sliceLines,
  sliceRangeExcluding,
  zodErrorsText,
} from "./shared.ts";

/**
 * question 容器解析（T1.3 建立，T1.4 抽成公共模块）：
 * practice / lecture（结构错误场景）/ mixed 三条路径共用。
 *
 * 约定（见 T1.3 parse.ts 头注释，此处继续生效）：
 * 1. 纯函数、不抛异常：结构性错误全部记入 issues，全面的 lint 规则属 T1.5；
 * 2. 「原文是真相」：题干/提示/答案/详解/sourceMd 均按行号切原文，不重新序列化；
 * 3. 填空/判断标记 [[…]] 只在文本节点识别，$…$ 数学环境与行内代码/代码块内不识别；
 * 4. 题目 id：显式属性优先，缺省「单元id-序号」，序号按文档出现顺序从 1 起，
 *    被丢弃的题也占号（保证修改后其余题缺省 id 尽量稳定）；
 * 5. 属性经注册表 question attrs schema 校验（strict 拒未知属性名），
 *    整体失败时逐字段挽救，尽量产出题目。
 * question 容器只认文档顶层直接子级（allowedIn: document，嵌套属 linter 事务）。
 */

/** 填空/判断标记：[[等价答案|等价答案…]]，内容不含方括号 */
const BLANK_MARKER_RE = /\[\[([^[\]]+?)\]\]/g;
/** GFM 任务列表项首行标记：`- [ ]` / `- [x]`（含有序列表写法） */
const TASK_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s*/;

/** 顶层 question 容器判定（经注册表别名归一）：practice/lecture/mixed 三条路径的同一谓词 */
export function isQuestionContainer(node: Node): node is ContainerDirective {
  return isContainer(node) && canonicalName(node) === "question";
}

/**
 * 缺省题目 id（单一出处）：`单元id-序号`。
 * 显式 id 属性缺失/为空时的兜底规则——解析器（extractQuestion）与讲练页切段
 * （split-lesson 的无 id 题块兜底对位）同用本函数；占号语义一致：序号按全部
 * 题块计（被丢弃的题也占号），见本文件头注释第 4 条。
 */
export function defaultQuestionIdOf(unitId: string, ordinal: number): string {
  return `${unitId}-${ordinal}`;
}

// ---------- 围栏 id 注入与判定（自 library-service 私有 ensureQuestionId 上移收敛，
// 2026-10 讲练文档 SSOT；导出回写、题库回写讲义与导入预览错位预警共用） ----------

/** 开围栏行的拆解结果（QUESTION_FENCE_RE 的三个捕获组） */
interface QuestionFenceMatch {
  /** 围栏前缀：空白 + 冒号 + question + 可选 [标签]（注入时原样保留） */
  readonly prefix: string;
  /** 属性行（含花括号）；无属性为 null */
  readonly attrs: string | null;
  /** 行尾空白（原样保留） */
  readonly trailing: string;
}

/**
 * 题目 sourceMd 首行（容器开栏行）按解析器宽口径拆解（shared.ts
 * QUESTION_FENCE_RE 单一出处：任意冒号数 + `[标签]` + `{属性}` 组合）；
 * 首行不是 question 开围栏时 null。首行剥离尾随 `\r`——CRLF 输入下 `$`
 * 不再失配（审查修复 1）。withQuestionId / hasExplicitQuestionId 共用同一
 * 「提首行 + 围栏正则」口径，注入与判定的形态基线不漂移。
 */
function matchQuestionFence(sourceMd: string): QuestionFenceMatch | null {
  const newlineIndex = sourceMd.indexOf("\n");
  const firstLine = (
    newlineIndex === -1 ? sourceMd : sourceMd.slice(0, newlineIndex)
  ).replace(/\r$/, "");
  const match = QUESTION_FENCE_RE.exec(firstLine);
  if (match === null) return null;
  return {
    prefix: match[1] ?? "",
    attrs: match[2] ?? null,
    trailing: match[3] ?? "",
  };
}

/**
 * 围栏属性行是否已带显式 id：`id=…` 键（FENCE_ATTR_ID_RE 单一出处，含
 * 「id 排首位紧跟 {」形态）或 remark-directive 的 `{#id}` 简写（`#` 紧跟
 * 左花括号，解析时归一到 attributes.id——注入与判定必须同认，漏认会重复注入）。
 */
function fenceAttrsHaveExplicitId(attrs: string | null): boolean {
  return (
    attrs !== null && (FENCE_ATTR_ID_RE.test(attrs) || attrs.startsWith("{#"))
  );
}

/**
 * 给题目 sourceMd 的容器开始行注入显式 id 属性（无 id 时），与原 library-service
 * 私有 ensureQuestionId 语义逐字一致。为什么：缺省题目 id 按「单元id-序号」由
 * 文档内位置推导——单元删过题后导出，剩余题的缺省 id 会整体前移（练习四-2 变成
 * 练习四-1），「导出→再导入」会错位更新到别的题目、破坏学情统计的 id 延续；
 * 注入显式 id 让往返后题目身份完全稳定。
 * 已带 id= 属性或 {#id} 简写则原样返回；首行非题容器、属性未闭合（不以 } 结尾）
 * 等异常形态不改动，交给 lint。注入位置：`[标签]` 无花括号形态在标签后补
 * `{id="…"}`，有花括号在属性串尾部追加（纯四冒号形态与旧实现逐字节一致）。
 */
export function withQuestionId(sourceMd: string, id: string): string {
  const newlineIndex = sourceMd.indexOf("\n");
  const rest = newlineIndex === -1 ? "" : sourceMd.slice(newlineIndex);
  const fence = matchQuestionFence(sourceMd);
  if (fence === null) return sourceMd; // 结构异常（不应发生）：不改动，交给 lint
  if (fenceAttrsHaveExplicitId(fence.attrs)) return sourceMd;
  // 注入进属性花括号内：{type=judge …} → {type=judge … id="…"}；
  // 无属性则补 {id="…"}（JSON 字符串转义，id 含引号/反斜杠也安全）。
  const attr = `id=${JSON.stringify(id)}`;
  const inner = fence.attrs === null ? "" : fence.attrs.slice(1, -1).trimEnd();
  const injected =
    fence.attrs === null
      ? `${fence.prefix}{${attr}}${fence.trailing}`
      : `${fence.prefix}{${inner.length > 0 ? `${inner} ${attr}` : attr}}${fence.trailing}`;
  return `${injected}${rest}`;
}

/**
 * 题目 sourceMd 首行围栏是否已带显式 id 属性（判定与 withQuestionId 同源：
 * shared.ts QUESTION_FENCE_RE + FENCE_ATTR_ID_RE 单一出处，另认 {#id} 简写）。
 * 导入预览用它区分「缺省派生 id 且命中更新」的题——文档内插题/删题会使这类题
 * 错位更新到别的题（P2b 标红预警的判定面）。
 */
export function hasExplicitQuestionId(sourceMd: string): boolean {
  const fence = matchQuestionFence(sourceMd);
  return fence !== null && fenceAttrsHaveExplicitId(fence.attrs);
}

/** 从文档顶层子级中解析全部 question 容器（按出现顺序），供三条 kind 路径共用 */
export function extractQuestions(
  children: readonly RootContent[],
  ctx: QuestionStreamContext,
): Question[] {
  const questions: Question[] = [];
  let number = Math.max(1, Math.floor(ctx.startNumber));
  for (const child of children) {
    if (!isContainer(child) || canonicalName(child) !== "question") continue;
    const question = extractQuestion(child, {
      lines: ctx.lines,
      unitId: ctx.unitId,
      number,
      issues: ctx.issues,
      ...(ctx.qmRefSites !== undefined ? { qmRefSites: ctx.qmRefSites } : {}),
      ...(ctx.qmEntityLines !== undefined
        ? { qmEntityLines: ctx.qmEntityLines }
        : {}),
    });
    number += 1; // 被丢弃的题也占序号，见文件头注释第 4 条
    if (question !== undefined) questions.push(question);
  }
  return questions;
}

export interface QuestionStreamContext {
  readonly lines: readonly string[];
  readonly unitId: string;
  /** 缺省题目序号起点（缺省 1）。reparse 单题片段时由调用方传入原题序号 */
  readonly startNumber: number;
  readonly issues: LintIssue[];
  /**
   * TT-06 题级 ::ref 站点登记（两遍解析第二遍的行号来源；可选——reparse 等
   * 单题片段路径没有材料/组上下文，不登记）。qmEntityLines 同理记题目起始行。
   */
  readonly qmRefSites?: QmRefSite[];
  readonly qmEntityLines?: Map<string, number>;
}

interface QuestionContext {
  readonly lines: readonly string[];
  readonly unitId: string;
  readonly number: number;
  readonly issues: LintIssue[];
  readonly qmRefSites?: QmRefSite[];
  readonly qmEntityLines?: Map<string, number>;
}

/**
 * 解析单个 question 容器。
 * 返回 undefined 表示该题无法入库（type 缺失/未知——契约要求 type 为七种枚举之一，
 * 记 UNKNOWN_QUESTION_TYPE / MISSING_QUESTION_TYPE issue 后丢弃，其余题不受影响）。
 */
function extractQuestion(
  node: ContainerDirective,
  ctx: QuestionContext,
): Question | undefined {
  const { lines, issues } = ctx;
  const startLine = node.position?.start.line ?? 1;
  const startColumn = node.position?.start.column ?? 1;
  const endLine = node.position?.end.line ?? startLine;

  const rawAttrs: Record<string, string | null | undefined> =
    node.attributes ?? {};
  const attrs = parseQuestionAttrs(rawAttrs, startLine, startColumn, issues);
  if (attrs === undefined) return undefined;

  // ---- 子指令分区：hint（可多个）/ answer / solution 收进对应字段，其余为题干 ----
  // TT-06 新增结构性子指令：::ref（块式）、::::options、:::item、:::variant
  // 一律排除出题干（防泄露边界：选项/项/备选参考正文不得混进 stemMd）；
  // 行内式 ::ref（valid-03「第 1 空。::ref{…}」）是纯文本节点，留在题干
  // 原文（[[…]] 同款纪律：教师侧原文不动，公开投影 publicStemMd 剥离）。
  const hints: string[] = [];
  let answerText: string | undefined;
  let solutionMd: string | undefined;
  const variants: string[] = [];
  let optionsNode: ContainerDirective | undefined;
  const itemNodes: ContainerDirective[] = [];
  const blockRefs: Array<{ ref: MaterialRef; line: number; column: number }> =
    [];
  const excluded: Array<[number, number]> = [];
  const stemNodes: RootContent[] = [];
  for (const child of node.children) {
    if (isContainer(child)) {
      const name = canonicalName(child);
      if (name === "hint") {
        hints.push(sliceInnerLines(child, lines));
        excluded.push(lineRange(child));
        continue;
      }
      if (name === "answer") {
        answerText ??= sliceInnerLines(child, lines); // 多个 answer 取第一个
        excluded.push(lineRange(child));
        continue;
      }
      if (name === "solution") {
        solutionMd ??= sliceInnerLines(child, lines); // 多个 solution 取第一个
        excluded.push(lineRange(child));
        continue;
      }
      if (name === "variant") {
        variants.push(sliceInnerLines(child, lines));
        excluded.push(lineRange(child));
        continue;
      }
      if (name === "options") {
        optionsNode ??= child; // 多个 options 容器取第一个
        excluded.push(lineRange(child));
        continue;
      }
      if (name === "item") {
        itemNodes.push(child);
        excluded.push(lineRange(child));
        continue;
      }
      // 其余容器（:::warning 等版式指令、未知指令）留在题干内
    } else if (
      child.type === "leafDirective" &&
      canonicalName(child as LeafDirective) === "ref"
    ) {
      const ref = materialRefOf((child as LeafDirective).attributes ?? {});
      if (ref !== undefined) {
        blockRefs.push({
          ref,
          line: child.position?.start.line ?? startLine,
          column: child.position?.start.column ?? 1,
        });
      }
      excluded.push(lineRange(child));
      continue;
    }
    stemNodes.push(child);
  }

  // 题干原文 = 容器内部去掉子指令所占行（行级切分，块级指令总在整行边界）
  const stemMd = sliceRangeExcluding(
    lines,
    startLine + 1,
    endLine - 1,
    excluded,
  );

  // ---- 题干扫描：填空标记、判断标记、任务列表选项（跳过公式/代码子树） ----
  const scan = scanStem(stemNodes, lines, issues);

  // ---- 题级 ::ref：块式 + 行内式按文档顺序合并（展示按引用顺序，§5.2.2） ----
  const materialRefs = [...blockRefs, ...collectInlineRefs(stemNodes)].sort(
    (a, b) => a.line - b.line || a.column - b.column,
  );

  // ---- 题目 id：显式属性优先，缺省「单元id-序号」（defaultQuestionIdOf 单一出处） ----
  // （先于答案组装：matching 选项池的缺省 id 与参考校验都依赖最终题目 id）
  const explicitId = attrs.id?.trim();
  const id =
    explicitId !== undefined && explicitId.length > 0
      ? explicitId
      : defaultQuestionIdOf(ctx.unitId, ctx.number);

  // TT-06 站点登记：题级 ::ref 位置（第二遍引用校验）与题目起始行（答案收口定位）
  ctx.qmEntityLines?.set(id, startLine);
  for (const entry of materialRefs) {
    ctx.qmRefSites?.push({
      ownerKind: "question",
      ownerId: id,
      materialRef: entry.ref,
      line: entry.line,
      column: entry.column,
    });
  }

  // ---- matching 选项池（先抽一次，参考答案校验共用同一份 id 集，含缺省 id） ----
  const matchingPool =
    attrs.type === "matching" && optionsNode !== undefined
      ? extractMatchingOptions(optionsNode, id, lines, issues)
      : undefined;

  // ---- 按题型组装答案 ----
  let answers: QuestionAnswers | undefined;
  switch (attrs.type) {
    case "fill":
      if (scan.blanks.length > 0)
        answers = { kind: "fill", blanks: scan.blanks };
      break;
    case "judge":
      if (scan.judge !== undefined)
        answers = { kind: "judge", value: scan.judge };
      break;
    case "choice": {
      // 单选恰一个正确项由 T1.5 linter 保证；解析记录第一个 [x] 项
      const index = scan.taskItems.findIndex((item) => item.checked);
      if (index >= 0) answers = { kind: "choice", index };
      break;
    }
    case "multi": {
      const indexes = scan.taskItems.flatMap((item, i) =>
        item.checked ? [i] : [],
      );
      if (indexes.length > 0) answers = { kind: "multi", indexes };
      break;
    }
    case "response":
      // 主参考 :::answer → referenceMd（Markdown 原文）；备选 :::variant → variantsMd
      if (answerText !== undefined) {
        answers = { kind: "response", referenceMd: answerText };
        if (variants.length > 0) answers.variantsMd = [...variants];
      }
      break;
    case "matching": {
      // 行式参考：每行 `slotId = optionId`（行序无关）；格式不符或引用未声明
      // 选项 → 该参考不落结构化字段（保留原文，发布校验拒绝，§5.4.2）
      if (answerText !== undefined && matchingPool !== undefined) {
        answers = parseMatchingAnswer(answerText, {
          optionIds: new Set(matchingPool.options.map((option) => option.id)),
          line: startLine,
          issues,
        });
      }
      break;
    }
    case "ordering": {
      // 行式参考：每行一个 itemId，行序即正确顺序（固定项也列出）
      if (answerText !== undefined) {
        answers = parseOrderingAnswer(answerText, {
          itemIds: itemNodes.map((item) => item),
          questionId: id,
          line: startLine,
          issues,
        });
      }
      break;
    }
    default:
      // solve / apply / find-error：可选 :::answer 为最终答案；无则 answers 缺省
      if (answerText !== undefined)
        answers = { kind: "final", answer: answerText };
      break;
  }

  const question: Question = {
    id,
    type: attrs.type,
    difficulty: attrs.difficulty,
    knowledge: attrs.knowledge !== undefined ? [attrs.knowledge] : [],
    stemMd,
    hints,
    sourceMd: sliceLines(lines, startLine, endLine),
    // 解析期 id 注入**前**的显式性（契约可选字段）：lesson keep 模式随后把
    // 缺省 id 注进 sourceMd/讲义正文，注入后的围栏看不出原本有无显式 id——
    // 导入预览的缺省题号错位预警以此为准（注入后判定会漏报，PR#40 事故类别）。
    // 仅随解析产物内存携带，不落库、不进作答快照（见契约字段注释）。
    idExplicit: explicitId !== undefined && explicitId.length > 0,
  };
  if (
    scan.taskItems.length > 0 &&
    (attrs.type === "choice" || attrs.type === "multi")
  ) {
    // 选项纯文本：正确项的权威表示是 answers（choice.index/multi.indexes），
    // options 不再冗余携带 correct（契约 optionSchema，2026-10 移除）
    question.options = scan.taskItems.map((item) => ({ text: item.text }));
  }
  if (answers !== undefined) question.answers = answers;
  if (solutionMd !== undefined && solutionMd.length > 0)
    question.solutionMd = solutionMd;
  // ---- TT-06 新字段（§5.8.1 全量可选：缺省不注入键，旧题目键集不变） ----
  if (materialRefs.length > 0) {
    question.materialRefs = materialRefs.map((entry) => entry.ref);
  }
  if (attrs.type === "matching" && matchingPool !== undefined) {
    question.matchingOptions = matchingPool;
  }
  if (attrs.type === "ordering" && itemNodes.length > 0) {
    question.orderingItems = extractOrderingItems(
      itemNodes,
      id,
      lines,
      answers?.kind === "ordering" ? answers.sequence : [],
    );
  }
  if (attrs.type === "response") {
    const wordMin = attrs["word-min"];
    const wordMax = attrs["word-max"];
    if (wordMin !== undefined) question.wordMin = wordMin;
    if (wordMax !== undefined) question.wordMax = wordMax;
  }
  return question;
}

/**
 * question 属性解析：先整体过注册表 schema（strict 拒未知属性名）；
 * 失败则逐级挽救——剔除非法字段重试、再退到仅 type（difficulty 落回缺省 2），
 * 尽量产出题目。type 缺失/未知时返回 undefined（该题丢弃）。
 */
function parseQuestionAttrs(
  raw: Record<string, string | null | undefined>,
  line: number,
  column: number,
  issues: LintIssue[],
): QuestionDirectiveAttrs | undefined {
  const full = questionDirective.attrs.safeParse(raw);
  if (full.success) return full.data;
  issues.push(
    makeIssue(
      "error",
      line,
      column,
      "INVALID_QUESTION_ATTRS",
      `question 属性不合法：${zodErrorsText(full.error)}；已按可恢复的字段继续解析`,
    ),
  );

  const knownKeys = [
    "type",
    "difficulty",
    "knowledge",
    "id",
    "class",
    "word-min",
    "word-max",
  ];
  const filtered: Record<string, string> = {};
  for (const key of knownKeys) {
    const value = raw[key];
    if (typeof value === "string") filtered[key] = value;
  }
  const retry = questionDirective.attrs.safeParse(filtered);
  if (retry.success) return retry.data;

  if (typeof raw.type === "string") {
    const typeOnly = questionDirective.attrs.safeParse({ type: raw.type });
    if (typeOnly.success) return typeOnly.data;
    issues.push(
      makeIssue(
        "error",
        line,
        column,
        "UNKNOWN_QUESTION_TYPE",
        `未知题型 type="${raw.type}"，该题未能入库（合法值：judge | choice | multi | fill | solve | apply | find-error | response | matching | ordering；后三种为新题型，导入入口受部署发布开关控制）`,
      ),
    );
  } else {
    issues.push(
      makeIssue(
        "error",
        line,
        column,
        "MISSING_QUESTION_TYPE",
        "question 缺少必填属性 type（judge | choice | multi | fill | solve | apply | find-error | response | matching | ordering）",
      ),
    );
  }
  return undefined;
}

// ---------- 题干扫描 ----------

interface TaskItem {
  readonly text: string;
  readonly checked: boolean;
}

interface StemScan {
  /** 每个填空标记的可接受答案列表，按出现顺序与题干标记对齐 */
  readonly blanks: string[][];
  /** 第一个合法判断标记（[[正确]]/[[错误]]）映射的布尔值；无则 undefined */
  readonly judge: boolean | undefined;
  /** GFM 任务列表项（选择题选项） */
  readonly taskItems: TaskItem[];
}

/**
 * 扫描题干子树：文本节点识别 [[…]] 标记与任务列表项；
 * math/inlineMath/inlineCode/code 子树整体跳过（$…$ 内的 [[…]] 不是空位）。
 */
function scanStem(
  nodes: readonly RootContent[],
  lines: readonly string[],
  issues: LintIssue[],
): StemScan {
  const blanks: string[][] = [];
  let judge: boolean | undefined;
  const taskItems: TaskItem[] = [];

  for (const node of nodes) {
    visit(node, (current) => {
      if (
        current.type === "math" ||
        current.type === "inlineMath" ||
        current.type === "code" ||
        current.type === "inlineCode"
      ) {
        return SKIP;
      }
      if (isText(current)) {
        const startLine = current.position?.start.line ?? 1;
        const startColumn = current.position?.start.column ?? 1;
        for (const match of current.value.matchAll(BLANK_MARKER_RE)) {
          const content = match[1] ?? "";
          if (judge === undefined) {
            const trimmed = content.trim();
            if (trimmed === "正确") judge = true;
            else if (trimmed === "错误") judge = false;
          }
          const alternatives = content
            .split("|")
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
          if (alternatives.length === 0) {
            issues.push(
              makeIssue(
                "error",
                startLine,
                startColumn + (match.index ?? 0),
                "INVALID_BLANK_MARKER",
                `空的填空标记 ${match[0]}：[[ ]] 内必须写参考答案（等价答案用 | 分隔）`,
              ),
            );
            continue;
          }
          blanks.push(alternatives);
        }
        return;
      }
      if (isListItem(current) && typeof current.checked === "boolean") {
        taskItems.push({
          checked: current.checked,
          text: taskItemText(current, lines),
        });
      }
      return;
    });
  }
  return { blanks, judge, taskItems };
}

/** 选项原文：列表项首行去掉任务标记 `- [ ] `/`- [x] `，保留其余行的 markdown */
function taskItemText(item: ListItem, lines: readonly string[]): string {
  const [start, end] = lineRange(item);
  const rows = sliceLines(lines, start, end).split("\n");
  const first = rows[0] ?? "";
  return [first.replace(TASK_MARKER_RE, ""), ...rows.slice(1)]
    .join("\n")
    .trim();
}

function isListItem(node: Node): node is ListItem {
  return node.type === "listItem";
}

// ---------- TT-06：题级 ::ref 行内式与 matching/ordering 结构抽取 ----------

/** 行内式 ::ref{…} 标记（跟在文字后的写法，valid-03 形态；块式见分区循环） */
const INLINE_REF_RE = /::ref\{([^{}]*)\}/g;

/** 题干子树文本节点里的行内 ::ref（跳过公式/代码子树，[[…]] 识别纪律同款） */
function collectInlineRefs(
  nodes: readonly RootContent[],
): Array<{ ref: MaterialRef; line: number; column: number }> {
  const found: Array<{ ref: MaterialRef; line: number; column: number }> = [];
  for (const node of nodes) {
    visit(node, (current) => {
      if (
        current.type === "math" ||
        current.type === "inlineMath" ||
        current.type === "code" ||
        current.type === "inlineCode"
      ) {
        return SKIP;
      }
      if (!isText(current)) return;
      const baseLine = current.position?.start.line ?? 1;
      const baseColumn = current.position?.start.column ?? 1;
      for (const match of current.value.matchAll(INLINE_REF_RE)) {
        const ref = materialRefOf(parseRefAttrs(match[1] ?? ""));
        if (ref === undefined) continue;
        const index = match.index ?? 0;
        const before = current.value.slice(0, index);
        const newlines = before.split("\n").length - 1;
        const lastNewline = before.lastIndexOf("\n");
        found.push({
          ref,
          line: baseLine + newlines,
          column: lastNewline === -1 ? baseColumn + index : index - lastNewline,
        });
      }
      return;
    });
  }
  return found;
}

/** 选项池 ::::options 容器的结构化抽取（matching 专用；option id 重复报错） */
function extractMatchingOptions(
  node: ContainerDirective,
  questionId: string,
  lines: readonly string[],
  issues: LintIssue[],
): Question["matchingOptions"] {
  const parsedAttrs = optionsDirective.attrs.safeParse(node.attributes ?? {});
  const allowRepeat = parsedAttrs.success
    ? parsedAttrs.data["allow-repeat"]
    : false;
  const options: NonNullable<Question["matchingOptions"]>["options"] = [];
  const seenIds = new Map<string, number>();
  let ordinal = 0;
  for (const child of node.children) {
    if (!isContainer(child) || canonicalName(child) !== "option") continue;
    const [optStart] = lineRange(child);
    const explicit = child.attributes?.id?.trim();
    const id =
      explicit !== undefined && explicit.length > 0
        ? explicit
        : defaultOptionIdOf(questionId, ordinal + 1);
    const first = seenIds.get(id);
    if (first === undefined) seenIds.set(id, optStart);
    else {
      issues.push(
        makeIssue(
          "error",
          optStart,
          1,
          "INVALID_OPTION_REF",
          `选项 id「${id}」（第 ${optStart} 行）与本题第 ${first} 行的选项重复声明：选项池内 id 必须唯一（参考答案与配对作答按 id 解析）`,
        ),
      );
    }
    options.push({
      id,
      text: sliceInnerLines(child, lines),
      distractor: parseBoolAttr(child, "distractor"),
    });
    ordinal += 1;
  }
  if (options.length === 0) return undefined;
  return { allowRepeat, options };
}

/** matching 行式参考：每行 `slotId = optionId`（空格可省、行序无关） */
function parseMatchingAnswer(
  answerText: string,
  ctx: {
    readonly optionIds: ReadonlySet<string>;
    readonly line: number;
    readonly issues: LintIssue[];
  },
): QuestionAnswers | undefined {
  const pairs: Record<string, string> = {};
  let broken = false;
  for (const raw of answerText.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = /^(\S+?)\s*=\s*(\S+)$/.exec(line);
    if (match === null) {
      ctx.issues.push(
        makeIssue(
          "error",
          ctx.line,
          1,
          "INVALID_REFERENCE_ANSWER_FORMAT",
          `matching 参考答案的「${line}」行不是合法的配对行式：每行必须写成 槽位id = 选项id（如 slot-1 = opt-1，空格可省）；该参考答案不落结构化字段，发布校验将拒绝`,
        ),
      );
      broken = true;
      continue;
    }
    const slot = match[1] ?? "";
    const option = match[2] ?? "";
    if (!ctx.optionIds.has(option)) {
      ctx.issues.push(
        makeIssue(
          "error",
          ctx.line,
          1,
          "INVALID_OPTION_REF",
          `matching 参考答案引用了选项池未声明的选项「${option}」（槽位 ${slot}）：参考只能引用本题 ::::options 内声明的 option id；该参考答案不落结构化字段，发布校验将拒绝`,
        ),
      );
      broken = true;
      continue;
    }
    pairs[slot] = option;
  }
  if (broken || Object.keys(pairs).length === 0) return undefined;
  return { kind: "matching", pairs };
}

/** ordering 行式参考：每行一个 itemId，行序即正确顺序（固定项也列出） */
function parseOrderingAnswer(
  answerText: string,
  ctx: {
    readonly itemIds: readonly ContainerDirective[];
    readonly questionId: string;
    readonly line: number;
    readonly issues: LintIssue[];
  },
): QuestionAnswers | undefined {
  // declared 含缺省 id（tt-06b P2-3 对称化：与 matching 的缺省 opt-{qid}-{n}
  // 同口径——先按抽取序生成缺省 item id，再校验参考行，参考可直接引用缺省 id）
  const declared = new Set<string>();
  for (const [index, item] of ctx.itemIds.entries()) {
    const explicit = item.attributes?.id?.trim();
    declared.add(
      explicit !== undefined && explicit.length > 0
        ? explicit
        : defaultItemIdOf(ctx.questionId, index + 1),
    );
  }
  const sequence: string[] = [];
  let broken = false;
  for (const raw of answerText.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (!/^\S+$/.test(line) || !declared.has(line)) {
      ctx.issues.push(
        makeIssue(
          "error",
          ctx.line,
          1,
          "INVALID_REFERENCE_ANSWER_FORMAT",
          `ordering 参考答案的「${line}」行不合法：每行必须恰为本题已声明的一个排序项 id（裸 id、无空格，行序即正确顺序）；该参考答案不落结构化字段，发布校验将拒绝`,
        ),
      );
      broken = true;
      continue;
    }
    sequence.push(line);
  }
  if (broken || sequence.length === 0) return undefined;
  return { kind: "ordering", sequence };
}

/** :::item 容器组 → orderingItems（fixedPosition 由参考序列声明位派生，§6.1-3） */
function extractOrderingItems(
  nodes: readonly ContainerDirective[],
  questionId: string,
  lines: readonly string[],
  sequence: readonly string[],
): NonNullable<Question["orderingItems"]> {
  return nodes.map((node, index) => {
    const explicit = node.attributes?.id?.trim();
    const id =
      explicit !== undefined && explicit.length > 0
        ? explicit
        : defaultItemIdOf(questionId, index + 1);
    const position = sequence.indexOf(id);
    return {
      id,
      text: sliceInnerLines(node, lines),
      // 固定项的锁定位置来自参考序列的声明位（对学生可见的既定位置提示）
      fixedPosition:
        parseBoolAttr(node, "fixed") && position >= 0 ? position + 1 : null,
      // 干扰项：不在参考序列即干扰项（显式声明优先；§5.4.1 解析推导）
      distractor: !!(parseBoolAttr(node, "distractor") || position < 0),
    };
  });
}

/** 布尔属性的轻量读取（true/false 字符串；缺省/非法按 false，注册表已校验） */
function parseBoolAttr(node: ContainerDirective, key: string): boolean {
  return node.attributes?.[key]?.trim() === "true";
}
