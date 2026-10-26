import type { LintIssue, ParsedDocument } from "@tutor/contract";
import type { Root } from "mdast";
import { isYaml, makeIssue } from "../v2/shared.ts";

/**
 * frontmatter `practice:` 推荐适用性提示（M5-D1，练习反馈升级）：
 * practice 推荐只对练习形态单元（kind practice/mixed）生效；lecture/lesson 文档
 * 带该字段不报错也不生效（解析层不贯通进单元），仅记 warning 提示作者删除或改
 * kind——warning 不阻断导入，与 TITLE_NOT_APPLICABLE 同口径（写了无处安放的字段
 * 就提示，不静默吞）。practice/mixed 带推荐、或不带该字段，均零 issue。
 */
export function lintPracticeRecommendation(
  tree: Root,
  parsed: ParsedDocument,
): LintIssue[] {
  const recommendation = parsed.frontmatter?.practice;
  if (recommendation === undefined) return [];
  const kind = parsed.frontmatter?.kind ?? "practice";
  if (kind === "practice" || kind === "mixed") return [];

  // 行锚：frontmatter 映射首行（围栏行的下一行）；无位置信息时兜底第 1 行
  const yamlNode = tree.children.find(isYaml);
  const line = (yamlNode?.position?.start.line ?? 0) + 1;
  return [
    makeIssue(
      "warning",
      line,
      1,
      "PRACTICE_NOT_APPLICABLE",
      "practice 推荐仅适用于练习（practice/mixed）单元，对讲练不生效；请删除该字段，或把 kind 改为 practice / mixed",
    ),
  ];
}
