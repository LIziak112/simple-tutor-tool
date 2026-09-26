import type { LintIssue } from "@tutor/contract";

/**
 * tutor-lint CLI 的输出格式化核心（T1.7）：纯函数、不碰 fs/stdout，便于完整测试。
 * 依据：docs/技术架构与实施方案.md §5.1（linter 以 CLI 形式提供）、docs/开发任务清单.md T1.7。
 *
 * 输出契约：
 * - 每条 issue 一行 `文件:行:列  ERROR/WARNING  [CODE] 中文消息`，有 fix 时追加缩进建议行；
 * - 末尾统计 `共检查 N 个文件：E error / W warning`；
 * - 彩色用原生 ANSI 转义码（error 红 / warning 黄 / 摘要绿），零依赖；
 *   入口按 stdout.isTTY 决定是否开启（非 TTY 自动去色，CI 日志干净），并尊重 NO_COLOR。
 */

/** 一个文件的 lint 结果（displayPath 为展示用相对路径，分隔符统一为 /） */
export interface FileLintResult {
  readonly displayPath: string;
  readonly issues: readonly LintIssue[];
}

// ---------- ANSI 转义码（仅此一处定义） ----------

const RESET = "\u001B[0m";
const RED = "\u001B[31m";
const GREEN = "\u001B[32m";
const YELLOW = "\u001B[33m";

function paint(text: string, colorCode: string, color: boolean): string {
  return color ? `${colorCode}${text}${RESET}` : text;
}

// ---------- 行格式化 ----------

/**
 * 一条 issue 的输出行（1–2 行）：
 * 主行 + 可选的 `  建议：…` 缩进行（fix 缺省时不输出）。
 */
export function formatIssueLines(
  displayPath: string,
  issue: LintIssue,
  color: boolean,
): string[] {
  const level = paint(
    issue.level === "error" ? "ERROR" : "WARNING",
    issue.level === "error" ? RED : YELLOW,
    color,
  );
  const main = `${displayPath}:${issue.line}:${issue.column}  ${level}  [${issue.code}] ${issue.message}`;
  if (issue.fix === undefined) return [main];
  return [main, `  ${paint(`建议：${issue.fix}`, "\u001B[2m", color)}`];
}

/** 分别统计 error 与 warning 数量 */
export function countLevels(issues: readonly LintIssue[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.level === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

/** 汇总统计行：无 error 时绿色，有 error 时红色（醒目提醒阻断导入） */
function summaryLine(
  results: readonly FileLintResult[],
  color: boolean,
): string {
  let errors = 0;
  let warnings = 0;
  for (const result of results) {
    const counted = countLevels(result.issues);
    errors += counted.errors;
    warnings += counted.warnings;
  }
  const text = `共检查 ${results.length} 个文件：${errors} error / ${warnings} warning`;
  return paint(text, errors > 0 ? RED : GREEN, color);
}

/** 完整报告文本：逐文件逐 issue 输出 + 末尾统计行 */
export function renderReport(
  results: readonly FileLintResult[],
  color: boolean,
): string {
  const lines: string[] = [];
  for (const result of results) {
    for (const issue of result.issues) {
      lines.push(...formatIssueLines(result.displayPath, issue, color));
    }
  }
  lines.push(summaryLine(results, color));
  return lines.join("\n");
}

/** 退出码：任一文件有 error → 1，否则 0（文件不存在/用法错误由入口直接给 2） */
export function exitCodeFor(results: readonly FileLintResult[]): 0 | 1 {
  return results.some((result) =>
    result.issues.some((issue) => issue.level === "error"),
  )
    ? 1
    : 0;
}
