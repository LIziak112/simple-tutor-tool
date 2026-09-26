import { getDirective, type LintIssue } from "@tutor/contract";
import type { Text, Yaml } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Node } from "unist";

/**
 * v2 解析器公共设施（T1.4 自 T1.3 parse.ts 抽出）：
 * 解析管线、frontmatter 兜底值、原文行切分工具、issue 构造与 AST 类型收窄。
 * practice / lecture / mixed 三条解析路径共用，不得各自复制。
 */

/** 解析管线：frontmatter → 数学 → GFM（任务列表等） → 指令容器 */
export const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkMath)
  .use(remarkGfm)
  .use(remarkDirective);

/** frontmatter 缺 unit 且调用方未提供时的兜底单元 id */
export const FALLBACK_UNIT_ID = "unit";
/** 同上场景的兜底单元标题 */
export const FALLBACK_UNIT_TITLE = "未命名单元";

// ---------- 原文切分工具（「原文是真相」：按行号切原始文本，不重新序列化） ----------

/** 取 [startLine, endLine]（含端点，1 起）的原文行并拼接 */
export function sliceLines(
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
export function sliceInnerLines(node: Node, lines: readonly string[]): string {
  const [start, end] = lineRange(node);
  const rows = sliceLines(lines, start + 1, end - 1).split("\n");
  return trimBlankEdges(rows).join("\n");
}

/** 取 [startLine, endLine] 的原文行，跳过被排除的行区间（子指令/题目容器所占行），去掉首尾空行 */
export function sliceRangeExcluding(
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
export function lineRange(node: Node): [number, number] {
  const start = node.position?.start.line ?? 1;
  const end = node.position?.end.line ?? start;
  return [start, end];
}

/** 去掉首尾的空白行（仅整行空白，不动内容行内部的空行） */
export function trimBlankEdges(rows: readonly string[]): string[] {
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
export function firstNonEmpty(
  ...values: ReadonlyArray<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/** 构造 LintIssue，行列兜底到 ≥1 */
export function makeIssue(
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

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把 zod 校验错误压成一行中文描述（路径：消息；…） */
export function zodErrorsText(error: {
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

export function isText(node: Node): node is Text {
  return node.type === "text";
}

export function isYaml(node: Node): node is Yaml {
  return node.type === "yaml";
}

export function isContainer(node: Node): node is ContainerDirective {
  return node.type === "containerDirective";
}

/** 指令名经注册表归一到主名（改名走 aliases，AGENTS.md 规则 11） */
export function canonicalName(node: ContainerDirective): string {
  return getDirective(node.name)?.name ?? node.name;
}
