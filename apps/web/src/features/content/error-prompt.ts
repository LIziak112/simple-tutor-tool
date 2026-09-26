import type { LintIssue } from "@tutor/contract";

/**
 * "复制错误给 AI"提示词格式化（T1.11，§5.1 制作端闭环）：
 * 把 lint 错误列表 + 待修正原文 + 修正要求拼成一段可直接粘贴给 AI 的提示词。
 * 纯函数：不触碰剪贴板（复制与降级交互在 ErrorPanel 组件处理）。
 */

export interface LintErrorPromptInput {
  /** 导入时填写的文件名（提示词中标注待修正文档） */
  filename: string;
  /** 编辑器当前原文（v1 文档为原始 v1 文本） */
  markdown: string;
  /** lint 问题列表（error + warning 全部带上，warning 也值得让 AI 顺手修） */
  issues: readonly LintIssue[];
  /** 文档版本：v1 时附加"行号对应转换后 v2 文本"的说明 */
  version: 1 | 2;
}

/** 单条 issue → "- 第X行 第Y列 [CODE] 中文消息（修正建议：…）" */
function issueLine(issue: LintIssue): string {
  const fix = issue.fix !== undefined ? `（修正建议：${issue.fix}）` : "";
  return `- 第${issue.line}行 第${issue.column}列 [${issue.code}] ${issue.message}${fix}`;
}

/**
 * 组装提示词。文档代码块用四反引号围栏：原文里允许出现三反引号代码块而不破坏结构。
 */
export function buildLintErrorPrompt(input: LintErrorPromptInput): string {
  const lines: string[] = [
    "我在用一套基于 Markdown 的题目 DSL，以下是 lint 检查出的问题。",
    "",
    "## 待修正的文档",
    input.filename,
    "````markdown",
    input.markdown,
    "````",
    "",
    "## 错误列表",
  ];
  if (input.issues.length === 0) {
    lines.push("（无）");
  } else {
    for (const issue of input.issues) lines.push(issueLine(issue));
  }
  if (input.version === 1) {
    lines.push(
      "",
      "注意：这是旧版 v1 文档，上行号对应自动转换后的 v2 文本，与原始 v1 行号可能不同。",
    );
  }
  lines.push(
    "",
    "## 要求",
    "1. 逐条修正上述错误，不要改动无关内容与题目 id；",
    "2. 输出修正后的完整 markdown（仅代码块，不要解释）。",
  );
  return lines.join("\n");
}
