import {
  type DocumentFrontmatter,
  frontmatterSchema,
  type LintIssue,
} from "@tutor/contract";
import type { Yaml } from "mdast";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { errorMessage, makeIssue } from "./shared";

/**
 * frontmatter 解析（T1.3 建立，T1.4 抽成公共模块）：
 * YAML 语法错误 / 非映射表 / 字段校验失败分别记 issue，返回 undefined 表示不可用。
 * 调用方约定：返回 undefined 时按 practice 路径继续（题目仍尽量解析，T1.3 行为）。
 */
export function extractFrontmatter(
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
