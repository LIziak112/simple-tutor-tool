import {
  type LintIssue,
  type Question,
  type QuestionAnswers,
  type QuestionDirectiveAttrs,
  questionDirective,
} from "@tutor/contract";
import type { ListItem, RootContent } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import type { Node } from "unist";
import { SKIP, visit } from "unist-util-visit";
import {
  canonicalName,
  isContainer,
  isText,
  lineRange,
  makeIssue,
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
}

interface QuestionContext {
  readonly lines: readonly string[];
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
    // 选项纯文本：正确项的权威表示是 answers（choice.index/multi.indexes），
    // options 不再冗余携带 correct（契约 optionSchema，2026-10 移除）
    question.options = scan.taskItems.map((item) => ({ text: item.text }));
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
