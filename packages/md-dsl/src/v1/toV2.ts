import type { Question } from "@tutor/contract";
import { trimBlankEdges } from "../v2/shared.ts";
import {
  mapQuestion,
  parseV1Detailed,
  type V1ParsedUnit,
  type V1RawQuestion,
} from "./parse.ts";

/**
 * v1 → v2 文本转换（T1.6）：把 v1 旧格式练习册转成合法 v2 DSL 文本，
 * 教师端可一键升级旧文档（docs/技术架构与实施方案.md §5.1 末段「v1 兼容」）。
 *
 * 转换目标（往返质量的关键约束——输出必须 lintDocument 0 error）：
 * - frontmatter：kind: practice + unit/lecture/topic（取自 v1 UNIT 注释或 H2 推断）；
 * - 每题 `::::question{id=… type=… difficulty=… knowledge=…}` 容器：
 *   显式 id = v1 解析的缺省 id（`{单元id}-{题号}`），保证 toV2 后经 v2 解析的
 *   id 与 v1 解析一致（往返强断言），题号不连续/重复去重时也不漂移；
 * - 填空 `____` → `[[答案]]`（按 v1 答案序一一对应；多余答案追加题干末尾不丢判分信息）；
 * - 判断：题干末尾追加 `[[正确]]`/`[[错误]]`；
 * - 选择：A.~D. 选项行 → GFM 任务列表，正确项 `[x]`（多个正确项 → type=multi）；
 * - 手写题 ANSWER → `:::answer` 最终答案；`<details>` 详解 → `:::solution`。
 *
 * 无答案客观题的降级规则（保证 lint 0 error，判分语义本就缺失，交教师批改）：
 * 填空/判断/选择缺 ANSWER 或答案非法时 type 输出为 solve，题干 ____ 原样保留、
 * 选择题选项转普通列表。v2 的 FILL_NO_BLANK / JUDGE_INVALID_ANSWER /
 * CHOICE_NO_CORRECT 是 error 级规则，这些题无法生成对应标记，降级是唯一不撒谎的出路。
 *
 * 多单元文档：v2 一个文档只有一个练习单元，`v1ToV2Units` 按单元拆成多个 v2 文档；
 * `v1ToV2` 返回单文档——单单元即该文档，多单元合并（frontmatter 取第一单元，
 * 各题显式 id 保持原单元前缀，不冲突不漂移）。纯函数、不抛异常。
 */

/** v1 题干填空占位（与 parse.ts 的 V1_BLANK_RE 同源） */
const V1_BLANK_GLOBAL_RE = /_{4,}/g;

export function v1ToV2(md: string): string {
  const { units } = parseV1Detailed(md);
  return buildDocument(units);
}

/** 多单元 v1 文档 → 每单元一个合法 v2 文档（教师端逐单元升级用） */
export function v1ToV2Units(md: string): string[] {
  const { units } = parseV1Detailed(md);
  return units.map((entry) => buildDocument([entry]));
}

// ---------- 文档组装 ----------

function buildDocument(entries: readonly V1ParsedUnit[]): string {
  const fm: string[] = ["---", "kind: practice"];
  // 单单元：元信息完整带出；多单元合并：只带第一单元的（v2 文档只有一份单元元信息）
  const first = entries[0];
  if (first !== undefined) {
    fm.push(`unit: ${yamlQuote(first.raw.id)}`);
    if (first.raw.lecture.length > 0)
      fm.push(`lecture: ${yamlQuote(first.raw.lecture)}`);
    if (first.raw.topic.length > 0)
      fm.push(`topic: ${yamlQuote(first.raw.topic)}`);
  }
  fm.push("---");

  const blocks = entries.flatMap((entry) =>
    entry.raw.questions.map((raw, index) => {
      const mapped = entry.unit.questions[index] ?? mapQuestion(raw, []);
      return buildQuestionBlock(raw, mapped);
    }),
  );
  if (blocks.length === 0) return `${fm.join("\n")}\n`;
  return `${fm.join("\n")}\n\n${blocks.join("\n\n")}\n`;
}

// ---------- 单题转换 ----------

function buildQuestionBlock(raw: V1RawQuestion, mapped: Question): string {
  const effType = effectiveType(mapped);
  const attrs: string[] = [
    `id=${quoteAttr(raw.id)}`,
    `type=${effType}`,
    `difficulty=${mapped.difficulty}`,
  ];
  if (raw.knowledge.length > 0)
    attrs.push(`knowledge=${quoteAttr(raw.knowledge)}`);

  const body: string[] = [];
  const stemRows = stemRowsFor(raw, mapped, effType);
  if (stemRows.length > 0) body.push(stemRows.join("\n"));

  // 手写题（含降级 solve）的最终答案；fill/judge/choice/multi 的答案已编入题干标记
  if (mapped.answers?.kind === "final") {
    body.push([":::answer", mapped.answers.answer, ":::"].join("\n"));
  }
  if (raw.solutionMd.length > 0) {
    body.push([":::solution", raw.solutionMd, ":::"].join("\n"));
  }
  const inner = body.length > 0 ? `\n${body.join("\n\n")}\n` : "\n";
  return `::::question{${attrs.join(" ")}}${inner}::::`;
}

/**
 * 转换后输出的题型：客观题答案可用时按答案形态定（choice/multi 由答案区分）；
 * 填空/判断/选择答案缺失或非法时降级 solve（见文件头注释）；手写题原样。
 */
function effectiveType(mapped: Question): Question["type"] {
  const kind = mapped.answers?.kind;
  switch (mapped.type) {
    case "judge":
      return kind === "judge" ? "judge" : "solve";
    case "fill":
      return kind === "fill" ? "fill" : "solve";
    case "choice":
      return kind === "choice"
        ? "choice"
        : kind === "multi"
          ? "multi"
          : "solve";
    default:
      return mapped.type; // solve / apply / find-error 原样
  }
}

/** 按题型构造题干行（v1 题干原始行 → v2 形态） */
function stemRowsFor(
  raw: V1RawQuestion,
  mapped: Question,
  effType: Question["type"],
): string[] {
  if (effType === "fill" && mapped.answers?.kind === "fill") {
    return fillStemRows(raw.stemLines, mapped.answers.blanks);
  }
  if (effType === "judge" && mapped.answers?.kind === "judge") {
    return judgeStemRows(raw.stemLines, mapped.answers.value);
  }
  if (effType === "choice" || effType === "multi") {
    const rows = trimBlankEdges([...raw.stemLines]);
    // 正确项以 answers 为权威（choice.index / multi.indexes；effectiveType 保证
    // 到这里的答案形态必为二者之一，空集仅为防御）
    const correct =
      mapped.answers?.kind === "choice"
        ? new Set<number>([mapped.answers.index])
        : mapped.answers?.kind === "multi"
          ? new Set<number>(mapped.answers.indexes)
          : new Set<number>();
    const items = (mapped.options ?? []).map(
      (option, index) => `- [${correct.has(index) ? "x" : " "}] ${option.text}`,
    );
    return [...rows, "", ...items];
  }
  // 降级 solve 的选择题：选项转普通列表（无正确项标记可生成，语义交教师批改）
  if (raw.options.length > 0) {
    const rows = trimBlankEdges([...raw.stemLines]);
    return [...rows, "", ...raw.options.map((option) => `- ${option.text}`)];
  }
  return trimBlankEdges([...raw.stemLines]);
}

/** 填空：`____` 按答案序替换为 [[答案|等价答案…]]；答案多于空位时剩余追加末尾 */
function fillStemRows(
  stemLines: readonly string[],
  blanks: readonly (readonly string[])[],
): string[] {
  let cursor = 0;
  const rows = stemLines.map((line) =>
    line.replace(V1_BLANK_GLOBAL_RE, () => {
      const alternatives = blanks[cursor];
      cursor += 1;
      return alternatives === undefined
        ? "____" // 答案少于空位：占位保留原样（v1 解析已记 V1_FILL_BLANK_MISMATCH）
        : `[[${alternatives.join("|")}]]`;
    }),
  );
  const rest = blanks.slice(cursor);
  if (rest.length === 0) return trimBlankEdges(rows);
  const appended = rest.map((alternatives) => `[[${alternatives.join("|")}]]`);
  const trimmed = trimBlankEdges(rows);
  if (trimmed.length === 0) return appended;
  const last = trimmed.length - 1;
  trimmed[last] = `${trimmed[last]} ${appended.join(" ")}`;
  return trimmed;
}

/** 判断：题干末行追加 [[正确]]/[[错误]]；空题干则标记独占一行 */
function judgeStemRows(stemLines: readonly string[], value: boolean): string[] {
  const marker = value ? "[[正确]]" : "[[错误]]";
  const rows = trimBlankEdges([...stemLines]);
  if (rows.length === 0) return [marker];
  const last = rows.length - 1;
  rows[last] = `${rows[last]} ${marker}`;
  return rows;
}

// ---------- 转义 ----------

/** remark-directive 属性值：双引号包裹；含双引号改单引号；两种都含时双引号替换为全角 */
function quoteAttr(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replaceAll('"', "”")}"`;
}

/** YAML 双引号字符串（yaml 库按 YAML 1.2 解析转义） */
function yamlQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
