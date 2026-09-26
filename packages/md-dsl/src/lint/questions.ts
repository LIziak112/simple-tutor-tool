import {
  type LintIssue,
  type ParsedDocument,
  questionTypeSchema,
} from "@tutor/contract";
import type { Root, Text } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import type { Node } from "unist";
import { SKIP, visit } from "unist-util-visit";
import type { ParseOptions } from "../v2/parse";
import { isQuestionContainer } from "../v2/question";
import { canonicalName, lineRange, makeIssue, sliceLines } from "../v2/shared";

/**
 * 题目层 lint 规则（T1.5）：解析层「尽量产出、不重复报错」，把题型语义问题留给本层：
 * CHOICE_NO_CORRECT / CHOICE_MULTIPLE_CORRECT / FILL_NO_BLANK / JUDGE_INVALID_ANSWER /
 * JUDGE_MULTIPLE_MARKERS / DUPLICATE_QUESTION_ID。
 *
 * 数据来源：与解析器同一套 AST（重新 parse 一次，纯函数无共享状态）+ 解析产出
 * （parsed.units 的题目，用于 id 查重与「解析层已报过」的抑制判断）。
 * 题干扫描与解析器 question.ts 的规则严格一致：跳过 hint/answer/solution 子树、
 * $…$ 数学与代码子树；[[…]] 标记与任务列表项在文本/列表项节点上识别。
 * type 缺失/未知的题由解析层报（MISSING_QUESTION_TYPE / UNKNOWN_QUESTION_TYPE），本层跳过。
 */

/** 与解析器同源的填空/判断标记正则（内容不含方括号，至少一个字符） */
const MARKER_RE = /\[\[([^[\]]+?)\]\]/g;
/** 判断题的合法标记内容（trim 后） */
const JUDGE_VALUES = new Set(["正确", "错误"]);
/** 合法题型集合（契约枚举） */
const VALID_TYPES = new Set<string>(questionTypeSchema.options);

/** 题干里的一个 [[…]] 标记（行列换算到标记起始的「[」） */
interface StemMarker {
  readonly raw: string;
  readonly content: string;
  readonly line: number;
  readonly column: number;
}

/** 题干里的一个任务列表项（选择题选项） */
interface StemTaskItem {
  readonly checked: boolean;
  readonly line: number;
}

export function lintQuestions(
  tree: Root,
  lines: readonly string[],
  parsed: ParsedDocument,
  options: ParseOptions,
): LintIssue[] {
  const issues: LintIssue[] = [];
  // 解析产出的题目按文档顺序排列，是题目容器的子序列（被丢弃的题不占位）
  const keptQuestions = parsed.units.flatMap((unit) => unit.questions);
  const startNumber = Math.max(1, Math.floor(options.questionStartNumber ?? 1));
  const idFirstLine = new Map<string, number>();

  let ordinal = startNumber;
  let keptIndex = 0;
  for (const child of tree.children) {
    if (!isQuestionContainer(child)) continue;
    const [startLine, endLine] = lineRange(child);
    lintOneQuestion(child, { ordinal, startLine, endLine, parsed, issues });

    // 与解析产出按 sourceMd 精确对齐（同一容器切同一批原文行），只对入库题做 id 查重
    const sourceMd = sliceLines(lines, startLine, endLine);
    const kept = keptQuestions[keptIndex];
    if (kept !== undefined && kept.sourceMd === sourceMd) {
      keptIndex += 1;
      const firstLine = idFirstLine.get(kept.id);
      if (firstLine === undefined) {
        idFirstLine.set(kept.id, startLine);
      } else {
        issues.push(reportDuplicateId(kept.id, ordinal, startLine, firstLine));
      }
    }
    ordinal += 1; // 与解析器一致：被丢弃的题也占序号
  }
  return issues;
}

interface QuestionRuleContext {
  readonly ordinal: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly parsed: ParsedDocument;
  readonly issues: LintIssue[];
}

function lintOneQuestion(
  node: ContainerDirective,
  ctx: QuestionRuleContext,
): void {
  const rawType = node.attributes?.type;
  if (typeof rawType !== "string" || !VALID_TYPES.has(rawType)) return;

  const scan = scanStem(node);
  const hasParserIssue = (code: string): boolean =>
    ctx.parsed.issues.some(
      (issue) =>
        issue.code === code &&
        issue.line >= ctx.startLine &&
        issue.line <= ctx.endLine,
    );

  switch (rawType) {
    case "choice":
    case "multi": {
      const checkedItems = scan.taskItems.filter((item) => item.checked);
      if (scan.taskItems.length === 0) {
        ctx.issues.push(
          reportChoiceNoCorrect(
            ctx,
            rawType,
            "选项缺失",
            `题干里没有找到任何选项`,
          ),
        );
      } else if (checkedItems.length === 0) {
        ctx.issues.push(
          reportChoiceNoCorrect(
            ctx,
            rawType,
            "无正确项",
            `${scan.taskItems.length} 个选项中没有任何 [x] 正确项`,
          ),
        );
      } else if (rawType === "choice" && checkedItems.length > 1) {
        const checkedLines = checkedItems
          .map((item) => `第 ${item.line} 行`)
          .join("、");
        ctx.issues.push({
          ...makeIssue(
            "error",
            ctx.startLine,
            1,
            "CHOICE_MULTIPLE_CORRECT",
            `第 ${ctx.ordinal} 题是单选题（type=choice），但有 ${checkedItems.length} 个选项标了 [x]（${checkedLines}）：单选只能有一个正确项；请只保留一个 [x]、其余改回 [ ]，或把 type 改为 multi（多选）`,
          ),
          fix: "只保留一个 [x]（多选题则把 type=choice 改为 type=multi）",
        });
      }
      break;
    }
    case "fill": {
      // 与解析器一致：[[a|b]] 按竖线拆分后至少一个非空片段才算有效空
      const hasBlank = scan.markers.some((marker) =>
        marker.content.split("|").some((part) => part.trim().length > 0),
      );
      if (!hasBlank && !hasParserIssue("INVALID_BLANK_MARKER")) {
        ctx.issues.push({
          ...makeIssue(
            "error",
            ctx.startLine,
            1,
            "FILL_NO_BLANK",
            `第 ${ctx.ordinal} 题（type=fill，第 ${ctx.startLine} 行）题干没有任何 [[…]] 填空标记：填空题必须把参考答案写进双方括号（等价答案用 | 分隔），如 [[4]] 或 [[0.5|1/2]]，否则无法自动判分`,
          ),
          fix: "把答案写进 [[…]]，如 [[4]]；等价答案写成 [[0.5|1/2]]",
        });
      }
      break;
    }
    case "judge": {
      const validMarkers = scan.markers.filter((marker) =>
        JUDGE_VALUES.has(marker.content.trim()),
      );
      for (const marker of scan.markers) {
        const trimmed = marker.content.trim();
        // 空标记 [[ ]] 已由解析层报 INVALID_BLANK_MARKER，这里不重复
        if (trimmed.length > 0 && !JUDGE_VALUES.has(trimmed)) {
          ctx.issues.push({
            ...makeIssue(
              "error",
              marker.line,
              marker.column,
              "JUDGE_INVALID_ANSWER",
              `第 ${ctx.ordinal} 题的判断标记 ${marker.raw}（第 ${marker.line} 行）不合法：判断题只接受 [[正确]] 或 [[错误]]，其他写法（如 ${marker.raw}）不会被判分`,
            ),
            fix: `把 ${marker.raw} 改为 [[正确]] 或 [[错误]]`,
          });
        }
      }
      if (scan.markers.length === 0) {
        ctx.issues.push({
          ...makeIssue(
            "error",
            ctx.startLine,
            1,
            "JUDGE_INVALID_ANSWER",
            `第 ${ctx.ordinal} 题（type=judge，第 ${ctx.startLine} 行）题干缺少 [[正确]] 或 [[错误]] 判断标记，无法判分`,
          ),
          fix: "在题干末尾补上 [[正确]] 或 [[错误]]",
        });
      } else if (validMarkers.length > 1) {
        const second = validMarkers[1];
        if (second !== undefined) {
          const markerLines = validMarkers
            .map((marker) => `第 ${marker.line} 行`)
            .join("、");
          ctx.issues.push(
            makeIssue(
              "warning",
              second.line,
              second.column,
              "JUDGE_MULTIPLE_MARKERS",
              `第 ${ctx.ordinal} 题题干出现 ${validMarkers.length} 个判断标记（${markerLines}）：解析按第一个标记判分，请只保留一个 [[正确]]/[[错误]]`,
            ),
          );
        }
      }
      break;
    }
    default:
      // solve / apply / find-error：:::answer 可选，无本题型专属规则
      break;
  }
}

function reportChoiceNoCorrect(
  ctx: QuestionRuleContext,
  type: "choice" | "multi",
  kind: string,
  detail: string,
): LintIssue {
  const extra = type === "choice" ? "" : "（多选题至少要有一个 [x]）";
  return {
    ...makeIssue(
      "error",
      ctx.startLine,
      1,
      "CHOICE_NO_CORRECT",
      `第 ${ctx.ordinal} 题（type=${type}，第 ${ctx.startLine} 行）${kind}：${detail}${extra}；选择题需要用任务列表写出选项，并把正确项标为 [x]`,
    ),
    fix: "把正确选项前的「- [ ]」改为「- [x]」",
  };
}

function reportDuplicateId(
  id: string,
  ordinal: number,
  line: number,
  firstLine: number,
): LintIssue {
  return {
    ...makeIssue(
      "error",
      line,
      1,
      "DUPLICATE_QUESTION_ID",
      `第 ${ordinal} 题（第 ${line} 行）的题目 id「${id}」与第 ${firstLine} 行的题目重复：id 用于学情统计跨版本追踪，同一文档内必须唯一`,
    ),
    fix: `删除该题的 id 属性（缺省会按「单元-序号」生成），或改成唯一的 id`,
  };
}

/** 扫描题干子树：[[…]] 标记与任务列表项（跳过 hint/answer/solution 子树与公式/代码，与解析器一致） */
function scanStem(questionNode: Node): {
  markers: StemMarker[];
  taskItems: StemTaskItem[];
} {
  const markers: StemMarker[] = [];
  const taskItems: StemTaskItem[] = [];
  visit(questionNode, (current) => {
    if (
      current.type === "math" ||
      current.type === "inlineMath" ||
      current.type === "code" ||
      current.type === "inlineCode"
    ) {
      return SKIP;
    }
    if (current.type === "containerDirective") {
      const name = canonicalName(current as ContainerDirective);
      if (name === "hint" || name === "answer" || name === "solution") {
        return SKIP;
      }
    }
    if (current.type === "text") {
      collectMarkers(current as Text, markers);
    }
    const checked = (current as { readonly checked?: unknown }).checked;
    if (current.type === "listItem" && typeof checked === "boolean") {
      taskItems.push({
        checked,
        line: current.position?.start.line ?? 1,
      });
    }
    return;
  });
  return { markers, taskItems };
}

/** 从文本节点收集标记（换行文本按 \n 换算行列，列指向标记起始的「[」） */
function collectMarkers(node: Text, markers: StemMarker[]): void {
  const baseLine = node.position?.start.line ?? 1;
  const baseColumn = node.position?.start.column ?? 1;
  for (const match of node.value.matchAll(MARKER_RE)) {
    const index = match.index ?? 0;
    const before = node.value.slice(0, index);
    const newlineCount = countChar(before, "\n");
    const lastNewline = before.lastIndexOf("\n");
    markers.push({
      raw: match[0],
      content: match[1] ?? "",
      line: baseLine + newlineCount,
      column: lastNewline === -1 ? baseColumn + index : index - lastNewline,
    });
  }
}

function countChar(text: string, target: string): number {
  let count = 0;
  for (const char of text) {
    if (char === target) count += 1;
  }
  return count;
}
