import {
  type LintIssue,
  type ParsedDocument,
  parsedDocumentSchema,
  type Question,
  type QuestionAnswers,
  type QuestionOption,
  type Unit,
} from "@tutor/contract";
import {
  errorMessage,
  makeIssue,
  trimBlankEdges,
  zodErrorsText,
} from "../v2/shared.ts";

/**
 * v1 兼容解析器（T1.6）：把 v1 旧格式练习册 Markdown 解析为 v2 内容契约的
 * ParsedDocument（与 v2 解析器同一产出类型，见 packages/contract content.ts）。
 *
 * 行为规格 = v1 仓库（main 历史提交 b4ee184）的 parser.py 与
 * docs/01_任务安排与契约.md §4（解析规则）、§1（content.json schema）：
 * - 单元：`## ` H2 切分；其后前 3 行内的 `<!-- UNIT: 名称|讲次|主题 -->` 给出元信息，
 *   缺失时 unit id 取 H2 标题、topic 为去编号标题；无 H2 但有题归「未命名单元」；
 *   无题的段不入库；
 * - 题目：`#### 题 N（★★）` 题号行，难度 = 括号内 ★ 个数；【题型】/【考点】各占一行，
 *   ANSWER 行之前的其余行为题干（其中 `A.~D.` 行抽为选项），`<!-- ANSWER: … -->`
 *   按 `;;` 拆分为答案序，之后的 `<details>` 块（剔除 <summary>）为详解；
 * - 题目 id：`{单元id}-{题号}`，单元内重复题号追加 -2 后缀。
 *
 * v1 → v2 映射（docs/技术架构与实施方案.md §5.1 末段「v1 兼容」）：
 * - 六种旧题型 → v2 七种题型：判断→judge、填空→fill、选择→choice（多个正确项→multi）、
 *   计算→solve、应用→apply、找错→find-error；未知/缺失题型归 solve（对应 v1 前端
 *   「未知类型归入手写题处理」），并记 warning；
 * - frontmatter 由 v1 元信息合成：kind 一律 practice、dsl=1（标识旧版来源），
 *   unit/lecture/topic 取自单元元信息（多单元时不挑边，只声明 kind/dsl）；
 * - sourceMd 保存该题 v1 原文片段（题号行起），供追溯与单题重导。
 *
 * 实现约定（与 v2/parse.ts 一致）：纯函数、不抛异常，错误记入 issues；
 * 零新增依赖——v1 是文本规则格式，逐行扫描 + 正则即可，不需要 remark 管线。
 */

/** v1 六种合法题型（契约 §1 type 字段取值） */
export const V1_QUESTION_TYPES = [
  "判断",
  "填空",
  "选择",
  "计算",
  "应用",
  "找错",
] as const;

/** v1 六题型 → v2 七题型映射；未知值由 mapType 单独处理 */
const TYPE_MAP: Readonly<
  Record<(typeof V1_QUESTION_TYPES)[number], Question["type"]>
> = {
  判断: "judge",
  填空: "fill",
  选择: "choice",
  计算: "solve",
  应用: "apply",
  找错: "find-error",
};

/** v1 判分语义集（契约 §5）：判断题答案文本 → 布尔值 */
const JUDGE_TRUE = new Set(["正确", "对", "√", "✔", "T", "TRUE", "是"]);
const JUDGE_FALSE = new Set(["错误", "错", "×", "✘", "F", "FALSE", "否"]);

/** v1 题干填空占位（样例与规范书写为 4 个及以上下划线） */
const V1_BLANK_RE = /_{4,}/g;

// ---------- 与 parser.py 对齐的正则（行为规格，勿随意改动） ----------

const RE_H2 = /^##\s+(.+?)\s*$/;
const RE_UNIT_COMMENT = /<!--\s*UNIT:\s*(.*?)\s*-->/;
/** 题号行：`#### 题 N（★★）`；题号必须是整数，括号段可选（全角/半角） */
const RE_QUESTION_HEAD =
  /^#{4}\s*题\s*(\d+)\s*(?:[（(]\s*([^）)]*?)\s*[）)])?.*$/;
const RE_ANSWER = /<!--\s*ANSWER:\s*(.*?)\s*-->/;
const RE_TYPE_LINE = /^【题型】\s*(.*?)\s*$/;
const RE_KNOWLEDGE_LINE = /^【考点】\s*(.*?)\s*$/;
/** 选项行：A. / A． / A、 三种分隔符（parser.py 只认 A~D） */
const RE_OPTION_LINE = /^([A-D])[.．、]\s*(.*)$/;
const RE_SUMMARY = /<summary\b[^>]*>.*?<\/summary>/gis;
const RE_DETAILS_BLOCK = /<details\b[^>]*>(.*?)<\/details\s*>/is;
/** 容忍缺失 </details>：取到题末 */
const RE_DETAILS_UNCLOSED = /<details\b[^>]*>(.*)$/is;
/** H2 标题开头的编号前缀（无 UNIT 注释时推断 topic 用） */
const RE_NUMBERING_PREFIX =
  /^\s*(?:第\s*[0-9０-９一二三四五六七八九十百千]+\s*讲|第\s*[0-9０-９一二三四五六七八九十百千]+\s*[章节课单元]|练习\s*[0-9０-９一二三四五六七八九十百千]+|\d+(?:\.\d+)*)\s*[-–—.、:：]?\s*/;

/** v1 兜底单元名（全文无 H2 但有题） */
export const V1_DEFAULT_UNIT_ID = "未命名单元";
/** v1 无星（难度缺失）时落到 v2 注册表缺省难度 */
const V1_DEFAULT_DIFFICULTY = 2;
const V1_MAX_DIFFICULTY = 5;

// ---------- v1 原始形态（toV2 转换的输入，保留 v1 语义字段） ----------

export interface V1RawOption {
  readonly key: string;
  readonly text: string;
}

export interface V1RawQuestion {
  /** 题目 id：`{单元id}-{题号}`，重复题号追加 -2 后缀（v1 去重规则） */
  readonly id: string;
  /** 题号（`#### 题 N` 的 N） */
  readonly number: number;
  /** 括号内 ★ 个数（0 = 未标注） */
  readonly difficultyStars: number;
  /** 【题型】原文（"" = 缺失；未知值原样保留，v1 不转小写不清洗） */
  readonly typeText: string;
  /** 【考点】原文 */
  readonly knowledge: string;
  /** 题干（选项行抽出后其余行 join + strip） */
  readonly stem: string;
  /** 题干原始行（含空行；供 toV2 重建题干形态） */
  readonly stemLines: readonly string[];
  /** A.~D. 选项行（仅顺序与字母保留，非选择题也可能有） */
  readonly options: readonly V1RawOption[];
  /** ANSWER 注释原文（未拆分；null = 无注释） */
  readonly answerText: string | null;
  /** 详解（<details> 剔除 summary 后；"" = 无详解） */
  readonly solutionMd: string;
  /** 该题 v1 原文片段（题号行起、去尾空行） */
  readonly sourceMd: string;
  /** 题号行行号（文档级 1 起，issue 定位用） */
  readonly headLine: number;
}

export interface V1RawUnit {
  /** 单元 id：UNIT 注释第一段（空则 H2 标题）或 H2 标题或「未命名单元」 */
  readonly id: string;
  /** UNIT 注释第二段（讲次；"" = 未标注） */
  readonly lecture: string;
  /** UNIT 注释第三段 / H2 去编号标题（"" = 未标注） */
  readonly topic: string;
  readonly questions: readonly V1RawQuestion[];
}

export interface V1ParsedUnit {
  readonly raw: V1RawUnit;
  readonly unit: Unit;
}

export interface V1DetailedResult {
  readonly units: readonly V1ParsedUnit[];
  readonly issues: LintIssue[];
}

/**
 * 解析 v1 练习册，返回「v1 原始形态 + v2 契约形态」双份结果。
 * toV2 转换消费同一结果，保证转换后经 v2 解析与 parseV1 产出结构一致（往返一致性）。
 * 纯函数、不抛异常。
 */
export function parseV1Detailed(md: string): V1DetailedResult {
  try {
    const issues: LintIssue[] = [];
    const text = normalizeText(md);
    const units = splitSegments(text)
      .map((segment) => buildUnit(segment, issues))
      .filter((unit): unit is V1ParsedUnit => unit !== undefined);
    return { units, issues };
  } catch (err) {
    return {
      units: [],
      issues: [
        makeIssue(
          "error",
          1,
          1,
          "PARSE_INTERNAL_ERROR",
          `v1 解析器内部错误（这是解析器缺陷，请反馈给开发者）：${errorMessage(err)}`,
        ),
      ],
    };
  }
}

/**
 * 解析 v1 练习册，返回符合内容契约的 ParsedDocument（导入入口）。
 * frontmatter 由 v1 元信息合成（kind 一律 practice、dsl=1）；纯函数、不抛异常。
 */
export function parseV1(md: string): ParsedDocument {
  try {
    const { units, issues } = parseV1Detailed(md);
    const result: ParsedDocument = {
      frontmatter: synthesizeFrontmatter(units),
      lectures: [],
      units: units.map((entry) => entry.unit),
      issues,
    };
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
          `v1 解析结果不符合内容契约（这是解析器缺陷，请反馈给开发者）：${zodErrorsText(checked.error)}`,
        ),
      ],
    };
  } catch (err) {
    return {
      lectures: [],
      units: [],
      issues: [
        makeIssue(
          "error",
          1,
          1,
          "PARSE_INTERNAL_ERROR",
          `v1 解析器内部错误（这是解析器缺陷，请反馈给开发者）：${errorMessage(err)}`,
        ),
      ],
    };
  }
}

// ---------- 文本规范化（parser.py _normalize_text） ----------

function normalizeText(md: string): string {
  const noBom = md.startsWith("\uFEFF") ? md.slice(1) : md;
  return noBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ---------- 单元切分（parser.py _split_segments / _build_unit） ----------

interface Segment {
  /** H2 标题（null = 文档开头、H2 之前的段） */
  readonly h2: string | null;
  /** H2 后前 3 行内的 UNIT 注释内容 */
  readonly unitComment: string | null;
  /** 段内正文行（不含 H2 行） */
  readonly lines: readonly string[];
  /** 段内第一行的文档行号（1 起，issue 定位用） */
  readonly baseLine: number;
}

function splitSegments(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let current: {
    h2: string | null;
    unitComment: string | null;
    lines: string[];
    baseLine: number;
  } = { h2: null, unitComment: null, lines: [], baseLine: 1 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = RE_H2.exec(line);
    if (m === null) {
      current.lines.push(line);
      continue;
    }
    if (current.h2 !== null || current.lines.length > 0) {
      segments.push(current);
    }
    // H2 后前 3 行内找 UNIT 注释（parser.py：range(i+1, min(i+4, len))）
    let unitComment: string | null = null;
    const scanEnd = Math.min(i + 4, lines.length);
    for (let j = i + 1; j < scanEnd; j++) {
      const mu = RE_UNIT_COMMENT.exec(lines[j] ?? "");
      if (mu !== null) {
        unitComment = mu[1] ?? "";
        break;
      }
    }
    current = {
      h2: (m[1] ?? "").trim(),
      unitComment,
      lines: [],
      baseLine: i + 2,
    };
  }
  segments.push(current);
  return segments;
}

/** 去掉 H2 标题开头的编号（第 X 讲 / 第 X 章 / 练习X / 纯数字编号），得 topic */
function stripNumbering(h2Title: string): string {
  const stripped = h2Title.replace(RE_NUMBERING_PREFIX, "").trim();
  return stripped.length > 0 ? stripped : h2Title;
}

/** 把一段构建成单元；段内没有题目时返回 None（空单元不入库，parser.py 行为） */
function buildUnit(
  segment: Segment,
  issues: LintIssue[],
): V1ParsedUnit | undefined {
  const rawQuestions = parseQuestions(segment.lines, segment.baseLine);
  if (rawQuestions.length === 0) return undefined;

  let id: string;
  let lecture = "";
  let topic = "";
  if (segment.h2 === null) {
    id = V1_DEFAULT_UNIT_ID;
  } else if (segment.unitComment !== null) {
    const parts = segment.unitComment.split("|").map((p) => p.trim());
    id = parts[0] && parts[0].length > 0 ? parts[0] : segment.h2;
    lecture = parts[1] ?? "";
    topic = parts[2] ?? "";
  } else {
    id = segment.h2;
    topic = stripNumbering(segment.h2);
  }

  // id = {单元id}-{题号}，单元内重复题号追加 -2、-3 … 后缀保证唯一
  const seen = new Map<number, number>();
  const withIds = rawQuestions.map((raw) => {
    const count = (seen.get(raw.number) ?? 0) + 1;
    seen.set(raw.number, count);
    const base = `${id}-${raw.number}`;
    return { ...raw, id: count === 1 ? base : `${base}-${count}` };
  });
  if (seen.size < withIds.length) {
    const duplicateLine = withIds.find(
      (q, index) =>
        withIds.findIndex((other) => other.number === q.number) !== index,
    )?.headLine;
    issues.push(
      makeIssue(
        "warning",
        duplicateLine ?? 1,
        1,
        "V1_DUPLICATE_NUMBER",
        `单元「${id}」内存在重复题号：按 v1 规则对后续题目 id 追加了 -2 后缀，建议修正原文题号`,
      ),
    );
  }

  const questions = withIds.map((raw) => mapQuestion(raw, issues));
  const unit: Unit = { id, title: id, questions };
  if (topic.length > 0) unit.topic = topic;
  if (lecture.length > 0) unit.lectureTitle = lecture;
  return { raw: { id, lecture, topic, questions: withIds }, unit };
}

// ---------- 题目切分（parser.py _parse_questions） ----------

function parseQuestions(
  lines: readonly string[],
  baseLine: number,
): V1RawQuestion[] {
  const questions: V1RawQuestion[] = [];
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const head = RE_QUESTION_HEAD.exec(lines[i] ?? "");
    if (head === null) {
      i += 1;
      continue;
    }
    const headLine = baseLine + i;
    const number = Number.parseInt(head[1] ?? "0", 10);
    const difficultyStars = (head[2] ?? "").match(/★/g)?.length ?? 0;
    const sourceStart = i;
    i += 1;

    let typeText = "";
    let knowledge = "";
    const stemLines: string[] = [];
    let answerText: string | null = null;
    const tailLines: string[] = [];
    while (i < total) {
      const line = lines[i] ?? "";
      if (RE_QUESTION_HEAD.test(line) || RE_H2.test(line)) {
        break; // 下一题 / 下一单元开始
      }
      if (answerText === null) {
        const mt = RE_TYPE_LINE.exec(line);
        if (mt !== null && typeText.length === 0) {
          typeText = (mt[1] ?? "").trim();
          i += 1;
          continue;
        }
        const mk = RE_KNOWLEDGE_LINE.exec(line);
        if (mk !== null && knowledge.length === 0) {
          knowledge = (mk[1] ?? "").trim();
          i += 1;
          continue;
        }
        const ma = RE_ANSWER.exec(line);
        if (ma !== null) {
          answerText = ma[1] ?? "";
          i += 1;
          continue;
        }
        stemLines.push(line);
      } else {
        tailLines.push(line);
      }
      i += 1;
    }

    // 选项抽取：以 A.~D. 开头的行抽为 options，其余拼回 stem
    const options: V1RawOption[] = [];
    const stemParts: string[] = [];
    for (const line of stemLines) {
      const mo = RE_OPTION_LINE.exec(line);
      if (mo !== null) {
        options.push({ key: mo[1] ?? "", text: (mo[2] ?? "").trim() });
      } else {
        stemParts.push(line);
      }
    }
    const stem = stemParts.join("\n").trim();

    questions.push({
      id: "", // 占位，buildUnit 中回填
      number,
      difficultyStars,
      typeText,
      knowledge,
      stem,
      stemLines: stemParts,
      options,
      answerText,
      solutionMd: extractSolution(tailLines),
      sourceMd: trimBlankEdges(lines.slice(sourceStart, i)).join("\n"),
      headLine,
    });
  }
  return questions;
}

/** 从 ANSWER 之后的文本提取 <details>…</details> 详解（parser.py _extract_solution） */
function extractSolution(tailLines: readonly string[]): string {
  const text = tailLines.join("\n");
  let m = RE_DETAILS_BLOCK.exec(text);
  if (m === null) {
    m = RE_DETAILS_UNCLOSED.exec(text); // 容忍缺失 </details>
    if (m === null) return "";
  }
  const inner = (m[1] ?? "").replace(RE_SUMMARY, "");
  const rows = inner.split("\n").map((row) => row.replace(/\s+$/, ""));
  return trimBlankEdges(rows).join("\n").trim();
}

// ---------- v1 → v2 映射 ----------

/** v2 契约题型（局部别名，避免与 v1 typeText 混淆） */
type V2Type = Question["type"];

/** 旧题型映射：六值直查；未知/缺失归 solve（v1 前端「未知类型归手写」），记 warning */
function mapType(
  typeText: string,
  headLine: number,
  issues: LintIssue[],
): V2Type {
  const known = V1_QUESTION_TYPES.find((t) => t === typeText);
  if (known !== undefined) return TYPE_MAP[known];
  if (typeText.length === 0) {
    issues.push(
      makeIssue(
        "warning",
        headLine,
        1,
        "V1_MISSING_TYPE",
        "该题缺少【题型】行：已归为 v2 的 solve（手写题），请人工确认题型",
      ),
    );
    return "solve";
  }
  issues.push(
    makeIssue(
      "warning",
      headLine,
      1,
      "V1_UNKNOWN_TYPE",
      `未知题型「${typeText}」不在 v1 六种题型（判断/填空/选择/计算/应用/找错）内：已归为 v2 的 solve（手写题），请人工确认`,
    ),
  );
  return "solve";
}

/** 难度映射：★ 数 1~5 原样；0（未标注）落 v2 缺省 2；>5 收敛到 5 并告警 */
function mapDifficulty(
  stars: number,
  headLine: number,
  issues: LintIssue[],
): number {
  if (stars === 0) return V1_DEFAULT_DIFFICULTY;
  if (stars <= V1_MAX_DIFFICULTY) return stars;
  issues.push(
    makeIssue(
      "warning",
      headLine,
      1,
      "V1_DIFFICULTY_CLAMPED",
      `难度 ${stars} 星超出 v2 上限（1–5）：已收敛为 5`,
    ),
  );
  return V1_MAX_DIFFICULTY;
}

/** 判断题答案文本 → 布尔值（v1 判分语义集，契约 §5） */
function mapJudgeValue(text: string): boolean | undefined {
  const trimmed = text.trim().toUpperCase();
  if (JUDGE_TRUE.has(trimmed) || JUDGE_TRUE.has(text.trim())) return true;
  if (JUDGE_FALSE.has(trimmed) || JUDGE_FALSE.has(text.trim())) return false;
  return undefined;
}

/** ANSWER 按 ;; 拆分并 trim（parser.py 行为；空文本得空数组） */
function splitAnswerParts(answerText: string | null): string[] {
  if (answerText === null || answerText.trim().length === 0) return [];
  const parts = answerText.split(";;").map((p) => p.trim());
  return parts.length === 1 && parts[0] === "" ? [] : parts;
}

/** 选择题答案段 → 选项下标（A~D 单字母或多字母段如 AC；下标按选项在题干中的行序） */
function parseChoiceIndexes(
  parts: readonly string[],
  options: readonly V1RawOption[],
  headLine: number,
  issues: LintIssue[],
): number[] {
  const indexes: number[] = [];
  for (const part of parts) {
    const segment = part.trim().toUpperCase();
    if (!/^[A-D]+$/.test(segment)) {
      reportInvalidAnswer(
        headLine,
        `选择题答案「${part}」不是合法的选项字母（A~D）`,
        issues,
      );
      return [];
    }
    for (const ch of segment) {
      const index = options.findIndex(
        (option) => option.key.toUpperCase() === ch,
      );
      if (index < 0) {
        reportInvalidAnswer(
          headLine,
          `选择题答案「${part}」的选项 ${ch} 不在实际选项（${options.map((o) => o.key).join("、")}）内`,
          issues,
        );
        return [];
      }
      indexes.push(index);
    }
  }
  return [...new Set(indexes)].sort((a, b) => a - b);
}

function reportInvalidAnswer(
  headLine: number,
  detail: string,
  issues: LintIssue[],
): void {
  issues.push(
    makeIssue(
      "warning",
      headLine,
      1,
      "V1_ANSWER_INVALID",
      `${detail}：该题答案未能映射，导入后无法自动判分，请人工补全`,
    ),
  );
}

/** v1 原始题 → v2 契约题（题型/答案/难度/考点映射与降级规则的总入口） */
export function mapQuestion(raw: V1RawQuestion, issues: LintIssue[]): Question {
  const type = mapType(raw.typeText, raw.headLine, issues);
  const difficulty = mapDifficulty(raw.difficultyStars, raw.headLine, issues);
  const parts = splitAnswerParts(raw.answerText);

  let answers: QuestionAnswers | undefined;
  if (type === "judge") {
    if (parts.length === 0) {
      issues.push(
        makeIssue(
          "warning",
          raw.headLine,
          1,
          "V1_ANSWER_MISSING",
          "判断题缺少 <!-- ANSWER: 正确/错误 --> 注释：导入后无法自动判分，请人工补全",
        ),
      );
    } else {
      const value = mapJudgeValue(parts[0] ?? "");
      if (value === undefined) {
        reportInvalidAnswer(
          raw.headLine,
          `判断题答案「${parts[0]}」不在 v1 判分语义集（正确/对/√/T/是 ↔ 错误/错/×/F/否）内`,
          issues,
        );
      } else {
        answers = { kind: "judge", value };
      }
    }
  } else if (type === "fill") {
    if (parts.length === 0) {
      issues.push(
        makeIssue(
          "warning",
          raw.headLine,
          1,
          "V1_ANSWER_MISSING",
          "填空题缺少 <!-- ANSWER: 答案 --> 注释：导入后无法自动判分，请人工补全",
        ),
      );
    } else {
      answers = { kind: "fill", blanks: parts.map((p) => [p]) };
      const blankCount = raw.stem.match(V1_BLANK_RE)?.length ?? 0;
      if (blankCount !== parts.length) {
        issues.push(
          makeIssue(
            "warning",
            raw.headLine,
            1,
            "V1_FILL_BLANK_MISMATCH",
            `填空题答案数（${parts.length}）与题干空位数（${blankCount} 个 ____）不一致：按 v1 规则以答案序为准，请人工核对`,
          ),
        );
      }
    }
  } else if (type === "choice" || type === "multi") {
    if (parts.length === 0) {
      issues.push(
        makeIssue(
          "warning",
          raw.headLine,
          1,
          "V1_ANSWER_MISSING",
          "选择题缺少 <!-- ANSWER: 选项字母 --> 注释：导入后无法自动判分，请人工补全",
        ),
      );
    } else {
      const indexes = parseChoiceIndexes(
        parts,
        raw.options,
        raw.headLine,
        issues,
      );
      if (indexes.length === 1) {
        answers = { kind: "choice", index: indexes[0] ?? 0 };
      } else if (indexes.length > 1) {
        // v1 选择题为单选交互，多个正确项属异常形态：映射为 v2 multi 并提示人工确认
        answers = { kind: "multi", indexes };
        issues.push(
          makeIssue(
            "warning",
            raw.headLine,
            1,
            "V1_CHOICE_MULTI_ANSWER",
            `选择题答案包含 ${indexes.length} 个正确项：已映射为 v2 的 multi（多选），请人工确认原意`,
          ),
        );
      }
    }
  } else {
    // solve / apply / find-error：ANSWER 为可选「最终答案」，原文不拆 ;;（保真）
    if (parts.length > 0) {
      answers = { kind: "final", answer: (raw.answerText ?? "").trim() };
    }
  }

  const question: Question = {
    id: raw.id,
    type,
    difficulty,
    knowledge: raw.knowledge.length > 0 ? [raw.knowledge] : [],
    stemMd: raw.stem,
    hints: [], // v1 无提示概念
    sourceMd: raw.sourceMd,
  };
  if (raw.options.length > 0 && (type === "choice" || type === "multi")) {
    const correctIndexes =
      answers?.kind === "choice"
        ? [answers.index]
        : answers?.kind === "multi"
          ? answers.indexes
          : [];
    const options: QuestionOption[] = raw.options.map((option, index) => ({
      text: option.text,
      correct: correctIndexes.includes(index),
    }));
    question.options = options;
  }
  if (answers !== undefined) question.answers = answers;
  if (raw.solutionMd.length > 0) question.solutionMd = raw.solutionMd;
  return question;
}

// ---------- frontmatter 合成 ----------

/** 由 v1 元信息合成 frontmatter：kind 一律 practice、dsl=1；单单元时带 unit/lecture/topic */
function synthesizeFrontmatter(
  units: readonly V1ParsedUnit[],
): ParsedDocument["frontmatter"] {
  const frontmatter: NonNullable<ParsedDocument["frontmatter"]> = {
    kind: "practice",
    dsl: 1,
  };
  const only = units.length === 1 ? units[0] : undefined;
  if (only !== undefined) {
    frontmatter.unit = only.unit.id;
    if (only.raw.lecture.length > 0) frontmatter.lecture = only.raw.lecture;
    if (only.raw.topic.length > 0) frontmatter.topic = only.raw.topic;
  }
  return frontmatter;
}
