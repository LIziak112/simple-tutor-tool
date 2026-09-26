import type { Diagnostic } from "@codemirror/lint";
import type { LintIssue } from "@tutor/contract";

/**
 * LintIssue[] → CodeMirror Diagnostic[] 的纯映射（T1.11 导入页编辑器标注）：
 * - LintIssue 行列从 1 起，CodeMirror 偏移从 0 起：换算为文档绝对偏移；
 * - 行/列越界（文档已编辑、issues 尚未刷新）时收敛到最近的合法位置，
 *   保证 from ≤ to 永远成立，不让标注更新把编辑器炸掉；
 * - fix 建议并入 message（CodeMirror 的 hover 面板按 message 渲染），code 写进 source。
 */

/** 计算每行起始偏移（下标 i 对应第 i+1 行；不含结尾换行符） */
function lineStartOffsets(doc: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < doc.length; i += 1) {
    if (doc.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 单条 issue → Diagnostic（行列换算 + 越界收敛） */
function toDiagnostic(
  issue: LintIssue,
  doc: string,
  starts: number[],
): Diagnostic {
  const lineCount = starts.length;
  // 行收敛到 [1, lineCount]；空文档（lineCount=1 且长度 0）落到第 1 行
  const line = clamp(issue.line, 1, lineCount);
  const lineStart = starts[line - 1] ?? 0;
  const lineEnd =
    line < lineCount ? (starts[line] ?? doc.length) - 1 : doc.length;
  const lineLength = Math.max(0, lineEnd - lineStart);

  // 列收敛到该行内；标注宽度至少 1 字符（行非空时），空行退化为零宽
  const column = clamp(issue.column, 1, Math.max(1, lineLength));
  let from = lineStart + column - 1;
  let to = Math.min(from + 1, lineEnd);
  if (lineLength === 0) {
    from = lineStart;
    to = lineStart;
  }

  const message =
    issue.fix !== undefined
      ? `${issue.message}\n修正建议：${issue.fix}`
      : issue.message;

  return {
    from,
    to,
    severity: issue.level === "error" ? "error" : "warning",
    message,
    source: issue.code,
  };
}

/** 批量映射：按文档位置排序（CodeMirror 的 lint 面板期望有序） */
export function lintIssuesToDiagnostics(
  issues: readonly LintIssue[],
  doc: string,
): Diagnostic[] {
  const starts = lineStartOffsets(doc);
  return issues
    .map((issue) => toDiagnostic(issue, doc, starts))
    .sort((a, b) => a.from - b.from || a.to - b.to);
}
