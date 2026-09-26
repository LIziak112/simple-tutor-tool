import {
  type DocumentFrontmatter,
  type LintIssue,
  type ParsedDocument,
  parsedDocumentSchema,
  type Unit,
} from "@tutor/contract";
import type { Root } from "mdast";
import { extractFrontmatter } from "./frontmatter";
import { extractQuestions } from "./question";
import {
  errorMessage,
  FALLBACK_UNIT_ID,
  FALLBACK_UNIT_TITLE,
  firstNonEmpty,
  isYaml,
  makeIssue,
  processor,
  zodErrorsText,
} from "./shared";

/**
 * DSL v2 文档解析入口（T1.3 练习题；T1.4 起按 frontmatter kind 分派到
 * practice / lecture / mixed 三条路径，讲义与混合解析见 lecture.ts）。
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

  // ---- 单元 id：调用方覆盖 > frontmatter.unit（原样保留中文，仅 trim）> 兜底值 ----
  const unitId =
    firstNonEmpty(options.unitId, frontmatter?.unit) ?? FALLBACK_UNIT_ID;
  const unitTitle =
    firstNonEmpty(frontmatter?.unit, options.unitId) ?? FALLBACK_UNIT_TITLE;

  // ---- 题目（按文档出现顺序；讲义/混合分派在 T1.4 lecture.ts 落地） ----
  const questions = extractQuestions(tree.children, {
    lines,
    unitId,
    startNumber: options.questionStartNumber ?? 1,
    issues,
  });

  // ---- 组装单元：有题目，或是练习文档（空练习也产出单元，供导入层提示） ----
  // 注意判空单元看的是「显式 kind: practice」：缺 frontmatter 且无题时不出空单元（T1.3 行为）
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
  return finalize({ lectures: [], units, issues }, frontmatter);
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
