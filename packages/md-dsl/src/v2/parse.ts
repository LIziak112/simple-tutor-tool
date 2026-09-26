import {
  type DocumentFrontmatter,
  frontmatterSchema,
  getDirective,
  type LintIssue,
  type ParsedDocument,
  parsedDocumentSchema,
  type Question,
  type QuestionAnswers,
  type QuestionDirectiveAttrs,
  questionDirective,
  type Unit,
} from "@tutor/contract";
import type { ListItem, Root, RootContent, Text, Yaml } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Node } from "unist";
import { SKIP, visit } from "unist-util-visit";
import { parse as parseYaml, YAMLParseError } from "yaml";

/**
 * DSL v2 练习题解析器（T1.3）。
 *
 * 依据：docs/技术架构与实施方案.md §5.1（语法与规则要点表）、§5.1.1(3)（未知指令降级）、
 * §5.1.1(4)（原文是真相）、docs/开发任务清单.md T1.3。
 *
 * 设计约定：
 * 1. 纯函数、不抛异常：结构性错误（缺 frontmatter、坏 YAML、未知题型等）全部记入 issues
 *    （code 为 UPPER_SNAKE，line/column 从 AST position 取、均 1 起）。全面的 lint 规则
 *    （近似名建议、单选多正确项、判断题答案非法、id 重复等）属 T1.5，本层只报"解析器
 *    自然发现"的错误。
 * 2. 「原文是真相」：每题 sourceMd 用行号切出原始片段（含 ::::question 与配对 :::: 行），
 *    切出的片段可独立重新解析（服务 T1.12 单题编辑与 T1.14 reparse）；题干/提示/答案/详解
 *    同样按行切原文，不重新序列化，保证 roundtrip 无损（代价：换行统一归一为 LF）。
 * 3. 填空/判断标记 [[…]] 只在文本节点识别；$…$ / $$…$$ 数学环境（remark-math 产出的
 *    math/inlineMath 节点）与行内代码/代码块内的 [[…]] 不是作答空位。
 * 4. 题目 id：显式属性优先（{#id} 或 {id=…}），缺省为「单元id-序号」，序号按文档出现顺序
 *    从 1 起（含解析失败被丢弃的题也占号，保证修改后其余题缺省 id 尽量稳定）。
 * 5. 属性经 T1.2 注册表的 question attrs schema 校验（difficulty 缺省 2、type 枚举、
 *    strict 拒未知属性名）；整体失败时逐字段挽救，尽量产出题目。
 * 6. 输出最终经 parsedDocumentSchema 校验（契约兜底）：解析器产出永远符合 T1.1 契约。
 *
 * 范围说明：本任务只处理练习题（kind: practice 的题目抽取）；讲义切分与混合文档拆分在
 * T1.4 扩展。question 容器只认文档顶层直接子级（allowedIn: document，嵌套属 linter 事务）。
 */

/** 解析管线：frontmatter → 数学 → GFM（任务列表等） → 指令容器 */
const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkMath)
  .use(remarkGfm)
  .use(remarkDirective);

/** frontmatter 缺 unit 且调用方未提供时的兜底单元 id */
const FALLBACK_UNIT_ID = "unit";
/** 同上场景的兜底单元标题 */
const FALLBACK_UNIT_TITLE = "未命名单元";

/** 填空/判断标记：[[等价答案|等价答案…]]，内容不含方括号 */
const BLANK_MARKER_RE = /\[\[([^[\]]+?)\]\]/g;
/** GFM 任务列表项首行标记：`- [ ]` / `- [x]`（含有序列表写法） */
const TASK_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s*/;

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
 * 解析 v2 DSL 文档（当前实现练习题抽取），返回符合内容契约的 ParsedDocument。
 * 纯函数、不抛异常：任何错误以 issue 形式返回。
 */
export function parseDocument(
  md: string,
  options: ParseOptions = {},
): ParsedDocument {
  try {
    return parsePractice(md, options);
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

function parsePractice(md: string, options: ParseOptions): ParsedDocument {
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

  // ---- 单元 id：调用方覆盖 > frontmatter.unit（原样保留中文，仅 trim）> 兜底值 ----
  const unitId =
    firstNonEmpty(options.unitId, frontmatter?.unit) ?? FALLBACK_UNIT_ID;
  const unitTitle =
    firstNonEmpty(frontmatter?.unit, options.unitId) ?? FALLBACK_UNIT_TITLE;

  // ---- 题目（按文档出现顺序） ----
  const questions: Question[] = [];
  let number = Math.max(1, Math.floor(options.questionStartNumber ?? 1));
  for (const child of tree.children) {
    if (!isContainer(child) || canonicalName(child) !== "question") continue;
    const question = extractQuestion(child, {
      lines,
      unitId,
      number,
      issues,
    });
    number += 1; // 被丢弃的题也占序号，见文件头注释第 4 条
    if (question !== undefined) questions.push(question);
  }

  // ---- 组装单元：有题目，或是练习文档（空练习也产出单元，供导入层提示） ----
  const units: Unit[] = [];
  if (questions.length > 0 || frontmatter?.kind === "practice") {
    const unit: Unit = { id: unitId, title: unitTitle, questions };
    const topic = firstNonEmpty(frontmatter?.topic);
    const lectureTitle = firstNonEmpty(frontmatter?.lecture);
    if (topic !== undefined) unit.topic = topic;
    if (lectureTitle !== undefined) unit.lectureTitle = lectureTitle;
    units.push(unit);
  }

  // ---- 契约兜底：产出必须永远符合 T1.1 契约 ----
  const result: ParsedDocument = { lectures: [], units, issues };
  if (frontmatter !== undefined) result.frontmatter = frontmatter;
  const checked = parsedDocumentSchema.safeParse(result);
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

interface QuestionContext {
  readonly lines: string[];
  readonly unitId: string;
  readonly number: number;
  readonly issues: LintIssue[];
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
  const hints: string[] = [];
  let answerText: string | undefined;
  let solutionMd: string | undefined;
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
      // 其余容器（:::warning 等版式指令、未知指令）留在题干内
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
    default:
      // solve / apply / find-error：可选 :::answer 为最终答案；无则 answers 缺省
      if (answerText !== undefined)
        answers = { kind: "final", answer: answerText };
      break;
  }

  // ---- 题目 id：显式属性优先，缺省「单元id-序号」 ----
  const explicitId = attrs.id?.trim();
  const id =
    explicitId !== undefined && explicitId.length > 0
      ? explicitId
      : `${ctx.unitId}-${ctx.number}`;

  const question: Question = {
    id,
    type: attrs.type,
    difficulty: attrs.difficulty,
    knowledge: attrs.knowledge !== undefined ? [attrs.knowledge] : [],
    stemMd,
    hints,
    sourceMd: sliceLines(lines, startLine, endLine),
  };
  if (
    scan.taskItems.length > 0 &&
    (attrs.type === "choice" || attrs.type === "multi")
  ) {
    question.options = scan.taskItems.map((item) => ({
      text: item.text,
      correct: item.checked,
    }));
  }
  if (answers !== undefined) question.answers = answers;
  if (solutionMd !== undefined && solutionMd.length > 0)
    question.solutionMd = solutionMd;
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

  const knownKeys = ["type", "difficulty", "knowledge", "id", "class"];
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
        `未知题型 type="${raw.type}"，该题未能入库（合法值：judge | choice | multi | fill | solve | apply | find-error）`,
      ),
    );
  } else {
    issues.push(
      makeIssue(
        "error",
        line,
        column,
        "MISSING_QUESTION_TYPE",
        "question 缺少必填属性 type（judge | choice | multi | fill | solve | apply | find-error）",
      ),
    );
  }
  return undefined;
}

/** frontmatter 解析：YAML 语法错误 / 非映射表 / 字段校验失败分别记 issue */
function extractFrontmatter(
  node: Yaml,
  issues: LintIssue[],
): DocumentFrontmatter | undefined {
  const fenceLine = node.position?.start.line ?? 1;
  const fenceColumn = node.position?.start.column ?? 1;

  let data: unknown;
  try {
    data = parseYaml(node.value);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      // yaml 包的 linePos 相对 frontmatter 内容（1 起），换算回文档行号 = 围栏行 + 相对行
      const pos = err.linePos?.[0];
      issues.push(
        makeIssue(
          "error",
          fenceLine + (pos?.line ?? 1),
          pos?.col ?? fenceColumn,
          "INVALID_FRONTMATTER_YAML",
          `frontmatter 不是合法的 YAML：${err.message}`,
        ),
      );
    } else {
      issues.push(
        makeIssue(
          "error",
          fenceLine,
          fenceColumn,
          "INVALID_FRONTMATTER_YAML",
          `frontmatter 解析失败：${errorMessage(err)}`,
        ),
      );
    }
    return undefined;
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    issues.push(
      makeIssue(
        "error",
        fenceLine + 1,
        fenceColumn,
        "INVALID_FRONTMATTER",
        "frontmatter 必须是「键: 值」形式的映射表，而不是标量或列表",
      ),
    );
    return undefined;
  }

  const result = frontmatterSchema.safeParse(data);
  if (result.success) return result.data;
  for (const zIssue of result.error.issues) {
    const path = zIssue.path.join(".");
    if (path === "kind") {
      if ((data as Record<string, unknown>).kind === undefined) {
        issues.push(
          makeIssue(
            "error",
            fenceLine + 1,
            fenceColumn,
            "MISSING_KIND",
            "frontmatter 缺少 kind（practice | lecture | mixed）",
          ),
        );
      } else {
        issues.push(
          makeIssue(
            "error",
            fenceLine + 1,
            fenceColumn,
            "INVALID_KIND",
            `kind 值不合法：${zIssue.message}（合法值：practice | lecture | mixed）`,
          ),
        );
      }
    } else {
      issues.push(
        makeIssue(
          "error",
          fenceLine + 1,
          fenceColumn,
          "INVALID_FRONTMATTER",
          `frontmatter 字段不合法：${path || "(根)"}：${zIssue.message}`,
        ),
      );
    }
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

// ---------- 原文切分工具（「原文是真相」：按行号切原始文本，不重新序列化） ----------

/** 取 [startLine, endLine]（含端点，1 起）的原文行并拼接 */
function sliceLines(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string {
  const from = Math.max(1, startLine);
  const to = Math.min(endLine, lines.length);
  if (to < from) return "";
  return lines.slice(from - 1, to).join("\n");
}

/** 容器指令内部内容（去掉首尾围栏行），去掉首尾空行 */
function sliceInnerLines(node: Node, lines: readonly string[]): string {
  const [start, end] = lineRange(node);
  const rows = sliceLines(lines, start + 1, end - 1).split("\n");
  return trimBlankEdges(rows).join("\n");
}

/** 取 [startLine, endLine] 的原文行，跳过被排除的行区间（子指令所占行），去掉首尾空行 */
function sliceRangeExcluding(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  excluded: readonly (readonly [number, number])[],
): string {
  const kept: string[] = [];
  for (let ln = Math.max(1, startLine); ln <= endLine; ln++) {
    if (excluded.some(([from, to]) => ln >= from && ln <= to)) continue;
    kept.push(lines[ln - 1] ?? "");
  }
  return trimBlankEdges(kept).join("\n");
}

/** 节点占用的行区间 [起始行, 结束行]（1 起，含端点） */
function lineRange(node: Node): [number, number] {
  const start = node.position?.start.line ?? 1;
  const end = node.position?.end.line ?? start;
  return [start, end];
}

/** 去掉首尾的空白行（仅整行空白，不动内容行内部的空行） */
function trimBlankEdges(rows: readonly string[]): string[] {
  let start = 0;
  let end = rows.length;
  while (start < end && isBlankRow(rows[start] ?? "")) start += 1;
  while (end > start && isBlankRow(rows[end - 1] ?? "")) end -= 1;
  return rows.slice(start, end);
}

function isBlankRow(row: string): boolean {
  return /^\s*$/.test(row);
}

// ---------- 通用工具 ----------

/** 依次取第一个 trim 后非空的值（用于 id/标题等字段清洗） */
function firstNonEmpty(
  ...values: ReadonlyArray<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/** 构造 LintIssue，行列兜底到 ≥1 */
function makeIssue(
  level: LintIssue["level"],
  line: number,
  column: number,
  code: string,
  message: string,
): LintIssue {
  return {
    level,
    line: Math.max(1, Math.trunc(line) || 1),
    column: Math.max(1, Math.trunc(column) || 1),
    code,
    message,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把 zod 校验错误压成一行中文描述（路径：消息；…） */
function zodErrorsText(error: {
  readonly issues: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number | symbol>;
    readonly message: string;
  }>;
}): string {
  return error.issues
    .map((item) => `${item.path.join(".") || "(根)"}：${item.message}`)
    .join("；");
}

// ---------- AST 类型收窄 ----------

function isText(node: Node): node is Text {
  return node.type === "text";
}

function isListItem(node: Node): node is ListItem {
  return node.type === "listItem";
}

function isContainer(node: Node): node is ContainerDirective {
  return node.type === "containerDirective";
}

function isYaml(node: Node): node is Yaml {
  return node.type === "yaml";
}

/** 指令名经注册表归一到主名（改名走 aliases，AGENTS.md 规则 11） */
function canonicalName(node: ContainerDirective): string {
  return getDirective(node.name)?.name ?? node.name;
}
