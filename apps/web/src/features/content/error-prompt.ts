import type { ImportBatchConflict, LintIssue } from "@tutor/contract";

/**
 * "复制错误给 AI"提示词格式化（T2A.3 按 D21 重写，替换 T1.11 的全文拼接）：
 * 内容 = 固定修正要求说明 + 逐文件（相对路径 + 错误列表 + 每个错误前后各 3 行的
 * 带行号原文片段，相邻片段合并），**不附全文**。
 * 纯函数：不触碰剪贴板（复制与降级交互在 ErrorPanel / 批量预览组件处理）。
 * 单文件与「复制全部错误」共用：files 传单元素或多元素即可。
 * 批量场景下仅因跨文件冲突（D20：视为 error）被标红、但 lint issues 为空的文件，
 * 错误列表位置输出冲突说明（无原文行号 → 不生成片段）。
 */

/** buildFixPrompt 的单文件输入 */
export interface FixPromptFile {
  /** 文件相对路径（如 "chapter1/练习.md"）；空字符串 = 粘贴内容（无文件路径） */
  readonly path: string;
  /** 文件原文（片段截取的来源） */
  readonly markdown: string;
  /** lint 问题列表（error + warning 全部带上，warning 也值得让 AI 顺手修） */
  readonly issues: readonly LintIssue[];
  /** 同批次跨文件冲突（preview-batch 返回；无原文行号，不参与片段生成） */
  readonly conflicts?: readonly ImportBatchConflict[];
}

/** 每个错误前后各取的行数（D21：±3 行） */
const CONTEXT_LINES = 3;

/** 单文件片段总行数上限（D21：超过 200 行截断并注明） */
const MAX_SNIPPET_LINES = 200;

/** 粘贴内容（无文件路径）时的展示名 */
const NO_PATH_LABEL = "粘贴内容（无文件路径）";

/** 单条 issue → "- 第X行 第Y列 [CODE] 中文消息（修复建议：…）" */
function issueLine(issue: LintIssue): string {
  const fix = issue.fix !== undefined ? `（修复建议：${issue.fix}）` : "";
  return `- 第${issue.line}行 第${issue.column}列 [${issue.code}] ${issue.message}${fix}`;
}

/** 合并后的原文片段（闭区间 [start, end]，1 起行号） */
interface Snippet {
  readonly start: number;
  readonly end: number;
  /** 该片段覆盖的错误行（用于截断时统计"其余 N 处错误略"） */
  readonly issueLines: readonly number[];
}

/**
 * 由错误行列表生成片段：每行 ±CONTEXT_LINES，相邻（重叠或紧邻）合并。
 * 输入错误行需已去重升序。
 */
function buildSnippets(issueLines: readonly number[]): Snippet[] {
  const snippets: Snippet[] = [];
  let current: { start: number; end: number; issueLines: number[] } | null =
    null;
  for (const line of issueLines) {
    const start = line - CONTEXT_LINES;
    const end = line + CONTEXT_LINES;
    if (current !== null && start <= current.end + 1) {
      // 相邻/重叠 → 合并
      current.end = Math.max(current.end, end);
      current.issueLines.push(line);
    } else {
      if (current !== null) {
        snippets.push({ ...current, issueLines: [...current.issueLines] });
      }
      current = { start, end, issueLines: [line] };
    }
  }
  if (current !== null) {
    snippets.push({ ...current, issueLines: [...current.issueLines] });
  }
  return snippets;
}

/** 带行号的片段文本行（如 "    7 | 题干"；行号右对齐 4 位） */
function snippetLines(markdown: string, snippet: Snippet): string[] {
  const all = markdown.split("\n");
  const start = Math.max(1, snippet.start);
  const end = Math.min(all.length, snippet.end);
  const lines: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = all[n - 1] ?? "";
    lines.push(`${String(n).padStart(4)} | ${text}`);
  }
  return lines;
}

/**
 * 组装提示词（D21 新格式）：
 * - 固定修正要求说明（含"若你无法访问文件，请让我提供完整文件"）；
 * - 逐文件：路径（粘贴内容写「粘贴内容（无文件路径）」）+ 错误列表 + 片段
 *   （四反引号围栏：原文里允许出现三反引号代码块而不破坏结构）；
 * - 单文件片段总行数超 200 行时截断并注明「其余 N 处错误略」；
 * - 不附全文：片段之外的正文不出现在提示词里。
 */
export function buildFixPrompt(files: readonly FixPromptFile[]): string {
  const parts: string[] = [
    "我在用一套基于 Markdown 的题目 DSL，以下文件存在 lint 检查出的问题。",
    "请按路径打开这些文件，只修正列出的问题，不要改动其他内容；若你无法访问文件，请让我提供完整文件。",
  ];

  for (const file of files) {
    parts.push("", `## ${file.path.length > 0 ? file.path : NO_PATH_LABEL}`);

    // 错误列表（行号:列、CODE、中文说明、可选修复建议；跨文件冲突无行号，
    // 以冲突说明条目列出——避免「引用了文件却说无错误」的困惑）
    parts.push("", "### 错误列表");
    const conflictEntries = (file.conflicts ?? []).map(
      (conflict) =>
        `- [${conflict.code}] ${conflict.message}（同批次跨文件冲突，请修改本文件或对应文件中的重复内容）`,
    );
    if (file.issues.length === 0 && conflictEntries.length === 0) {
      parts.push("（无）");
    } else {
      for (const issue of file.issues) parts.push(issueLine(issue));
      parts.push(...conflictEntries);
    }

    // 片段（±3 行、相邻合并、单文件累计 ≤200 行）
    const issueLines = [
      ...new Set(file.issues.map((issue) => issue.line)),
    ].sort((a, b) => a - b);
    if (issueLines.length === 0) continue;
    parts.push("", "### 相关片段（行号为原文行号，相邻片段已合并）");
    const snippets = buildSnippets(issueLines);
    const totalLines = file.markdown.split("\n").length;
    let usedLines = 0;
    let omittedIssues = 0;
    let truncated = false;
    for (const snippet of snippets) {
      const count =
        Math.min(snippet.end, totalLines) - Math.max(1, snippet.start) + 1;
      if (count <= 0) continue;
      if (usedLines + count > MAX_SNIPPET_LINES) {
        // 截断（D21）：该片段起（含其后全部）不再展示，只计数
        truncated = true;
      }
      if (truncated) {
        omittedIssues += snippet.issueLines.length;
        continue;
      }
      // 每个片段独立围栏（多个片段并列，各自四反引号包裹）
      parts.push("````markdown");
      parts.push(...snippetLines(file.markdown, snippet));
      parts.push("````");
      usedLines += count;
    }
    if (omittedIssues > 0) {
      parts.push(
        "",
        `（其余 ${omittedIssues} 处错误略：片段总行数已超过 ${MAX_SNIPPET_LINES} 行上限）`,
      );
    }
  }

  return parts.join("\n");
}
