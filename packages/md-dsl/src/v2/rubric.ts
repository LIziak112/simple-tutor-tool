import {
  type LintIssue,
  RUBRIC_ITEM_DESC_MAX_CHARS,
  RUBRIC_ITEM_TITLE_MAX_CHARS,
  RUBRIC_ITEMS_MAX,
  RUBRIC_LEVEL_MAX,
  type Rubric,
} from "@tutor/contract";
import { makeIssue } from "./shared.ts";

const objectiveQuestionTypes = new Set(["judge", "choice", "multi"]);

type RubricItemFields = Omit<Rubric["items"][number], "id">;

function parseRubricItem(text: string): RubricItemFields | string {
  const stripped = text.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
  const splitAt = stripped.search(/[：:]/);
  const title = (splitAt === -1 ? stripped : stripped.slice(0, splitAt)).trim();
  const desc = splitAt === -1 ? "" : stripped.slice(splitAt + 1).trim();
  if (title === "" || title.length > RUBRIC_ITEM_TITLE_MAX_CHARS) {
    return `量表项「${stripped.slice(0, 20)}」不合法：项名不能为空且不超过 ${RUBRIC_ITEM_TITLE_MAX_CHARS} 字`;
  }
  if (desc.length > RUBRIC_ITEM_DESC_MAX_CHARS) {
    return `量表项「${title}」的说明超过 ${RUBRIC_ITEM_DESC_MAX_CHARS} 字`;
  }
  return desc === "" ? { title } : { title, desc };
}

/**
 * `:::rubric` 正文 → 量表（模块 3 通用量表判卷）。每行一项：
 * `- 项名：评什么`（全角 / 半角冒号均可，说明可省；列表记号 - * + 或 1.）。
 * id 按序生成 r1…rN（作答记录只认 id，重排项会换 id——与选项缺省 id 同理）。
 * 客观题（judge/choice/multi）内写量表记 error（没有可评的开放作答）。
 */
export function parseRubricBlock(
  body: string,
  questionType: string,
  line: number,
  column: number,
  issues: LintIssue[],
): Rubric | undefined {
  if (objectiveQuestionTypes.has(questionType)) {
    issues.push(
      makeIssue(
        "error",
        line,
        column,
        "RUBRIC_ON_OBJECTIVE_QUESTION",
        `量表只用于开放题；type=${questionType} 的客观题自动判分，已忽略这份量表`,
      ),
    );
    return undefined;
  }
  const items: Rubric["items"] = [];
  const initialIssueCount = issues.length;
  for (const raw of body.split("\n")) {
    const text = raw.trim();
    if (text === "") continue;
    const item = parseRubricItem(text);
    if (typeof item === "string") {
      issues.push(
        makeIssue("error", line, column, "RUBRIC_ITEM_INVALID", item),
      );
      continue;
    }
    items.push({ id: `r${items.length + 1}`, ...item });
  }
  if (items.length === 0) {
    if (issues.length === initialIssueCount) {
      issues.push(
        makeIssue(
          "error",
          line,
          column,
          "RUBRIC_EMPTY",
          "量表至少要有一项（每行「- 项名：评什么」）",
        ),
      );
    }
    return undefined;
  }
  if (items.length > RUBRIC_ITEMS_MAX) {
    issues.push(
      makeIssue(
        "error",
        line,
        column,
        "RUBRIC_TOO_MANY_ITEMS",
        `量表最多 ${RUBRIC_ITEMS_MAX} 项，当前 ${items.length} 项；已忽略这份量表`,
      ),
    );
    return undefined;
  }
  return { items, levels: RUBRIC_LEVEL_MAX };
}
