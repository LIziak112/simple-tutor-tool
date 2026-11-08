import {
  AI_REPLY_CHECK_MAX_CHARS,
  AI_REPLY_CHECK_VERSION,
  AI_REPLY_MAX_FORMULA_CHARS,
  AI_REPLY_MAX_FORMULAS,
  AI_REPLY_RENDER_MAX_BYTES,
  AI_REPLY_RENDER_MAX_NODES,
  type AiReplyCheckResult,
  type AiReplyIssue,
} from "@tutor/contract";
import katex from "katex";
import {
  aiReplyMathNodes,
  normalizeAiReplyMath,
  protectedAiReplyRanges,
} from "./format.ts";

const LATEX =
  /\\(?:frac|sqrt|lim|int|sum|prod|begin|end|left|right|operatorname|to|infty|sin|cos|tan|pm|alpha|beta|theta)(?![a-zA-Z])/;

/** 诊断位置始终引用原始 UTF-16 文本；不把正文或公式写入日志。 */
export function checkAiReply(source: string): AiReplyCheckResult {
  const issues: AiReplyIssue[] = [];
  const add = (
    severity: AiReplyIssue["severity"],
    code: AiReplyIssue["code"],
    start: number,
    end: number,
    message: string,
  ) => {
    if (issues.length >= 49) {
      if (issues.length === 49)
        issues.push({
          severity: "error",
          code: "REPLY_BUDGET",
          start: 0,
          end: source.length,
          line: 1,
          column: 1,
          message: "格式问题过多，请分段整理后重新检查。",
        });
      return;
    }
    const preceding = source.slice(0, start);
    issues.push({
      severity,
      code,
      start,
      end,
      line: preceding.split("\n").length,
      column: start - preceding.lastIndexOf("\n"),
      message,
    });
  };
  const finish = (): AiReplyCheckResult => ({
    version: AI_REPLY_CHECK_VERSION,
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
  });
  if (
    !source.trim() ||
    source.length > AI_REPLY_CHECK_MAX_CHARS ||
    new TextEncoder().encode(source).length > AI_REPLY_RENDER_MAX_BYTES ||
    source.split("\n").length * 3 > AI_REPLY_RENDER_MAX_NODES
  ) {
    add(
      "error",
      "REPLY_BUDGET",
      0,
      source.length,
      "回复超过检查预算，请缩短正文后重试。",
    );
    return finish();
  }
  // 先按普通 Markdown 找代码与链接范围，避免坏数学定界符影响排除范围。
  const excluded = new Uint8Array(source.length);
  const actualMath = new Map(
    aiReplyMathNodes(source).map((node) => [node.start, node]),
  );
  for (const { start, end } of protectedAiReplyRanges(source))
    excluded.fill(1, start, end);
  const escaped = (offset: number) => {
    let count = 0;
    for (let i = offset - 1; i >= 0 && source[i] === "\\"; i--) count++;
    return count % 2 === 1;
  };
  let formulas = 0;
  for (let i = 0; i < source.length; i++) {
    if (excluded[i]) continue;
    const token = source.startsWith("$$", i)
      ? "$$"
      : source[i] === "$"
        ? "$"
        : source.startsWith("\\[", i)
          ? "\\["
          : source.startsWith("\\(", i)
            ? "\\("
            : null;
    if (!token || escaped(i)) continue;
    const closing = token === "\\[" ? "\\]" : token === "\\(" ? "\\)" : token;
    const display = token === "$$" || token === "\\[";
    const newline = source.indexOf("\n", i);
    const limit = display || newline === -1 ? source.length : newline;
    let end = source.indexOf(closing, i + token.length);
    while (
      end !== -1 &&
      end < limit &&
      (excluded[end] ||
        escaped(end) ||
        (closing === "$" && source[end + 1] === "$"))
    )
      end = source.indexOf(closing, end + closing.length);
    if (end === -1 || end >= limit) {
      const lineStart = source.lastIndexOf("\n", i) + 1;
      const definite =
        display ||
        token === "\\(" ||
        LATEX.test(source.slice(lineStart, limit)) ||
        /^\$[a-zA-Z{(]/.test(source.slice(i, limit));
      add(
        definite ? "error" : "warning",
        definite ? "UNCLOSED_MATH" : "AMBIGUOUS_DOLLAR",
        definite ? lineStart : i,
        limit,
        definite
          ? "数学定界符未闭合，请检查这一段；行内公式保持同一行，独立公式用单独成行的 $$。"
          : "此处美元符号含义不明确；若为金额或字面符号，请写作 \\$。",
      );
      if (display) break;
      i = limit - 1;
      continue;
    }
    const actual = actualMath.get(i);
    const value =
      actual?.value ??
      source.slice(i + token.length, end).replace(/^\s*> ?/gm, "");
    const lineStart = source.lastIndexOf("\n", i) + 1;
    if (
      LATEX.test(source.slice(lineStart, i)) &&
      /[\u3400-\u9fff]/.test(
        value.replace(/\\(?:text|operatorname|mbox)\s*\{[^{}]*\}/g, ""),
      )
    ) {
      add(
        "warning",
        "SUSPECT_MATH",
        lineStart,
        end + closing.length,
        "公式前存在裸 LaTeX，配对内容又包含中文，可能遗漏了起始定界符，请复核整行。页面将按文字显示此片段。",
      );
    }
    formulas++;
    if (
      formulas > AI_REPLY_MAX_FORMULAS ||
      value.length > AI_REPLY_MAX_FORMULA_CHARS
    ) {
      add(
        "error",
        "REPLY_BUDGET",
        i,
        end + closing.length,
        "公式数量或单条公式长度超过显示预算，请拆分或简化。",
      );
      break;
    }
    try {
      katex.renderToString(value, {
        displayMode: actual?.display ?? display,
        throwOnError: true,
        trust: false,
        strict: "ignore",
        maxExpand: 1000,
      });
    } catch {
      add(
        "error",
        "INVALID_MATH",
        i,
        end + closing.length,
        "此公式无法由页面 KaTeX 渲染，请检查命令、花括号及 \\left / \\right 配对。",
      );
    }
    excluded.fill(1, i, end + closing.length);
    i = end + closing.length - 1;
  }
  const compatibleMath = aiReplyMathNodes(normalizeAiReplyMath(source));
  if (
    compatibleMath.length > AI_REPLY_MAX_FORMULAS ||
    compatibleMath.some(
      (node) => node.value.length > AI_REPLY_MAX_FORMULA_CHARS,
    )
  ) {
    add(
      "error",
      "REPLY_BUDGET",
      0,
      source.length,
      "兼容处理后的公式数量或长度超过显示预算，请拆分或简化。",
    );
  }
  if (
    source.split("\n").length * 3 +
      formulas * 40 +
      (source.match(/\]\(/g)?.length ?? 0) * 4 >
    AI_REPLY_RENDER_MAX_NODES
  ) {
    add(
      "error",
      "REPLY_BUDGET",
      0,
      source.length,
      "回复显示规模超过预算，请缩短正文。",
    );
  }
  // 裸公式只给建议；正文中的反斜杠词不能一律认定为数学。
  let offset = 0;
  for (const line of source.split("\n")) {
    // 使用码元索引，避免 emoji 改变原文定位。
    const text = line
      .split("")
      .map((char, index) => (excluded[offset + index] ? " " : char))
      .join("");
    const match = LATEX.exec(text);
    if (match)
      add(
        "warning",
        "BARE_LATEX",
        offset + match.index,
        offset + line.length,
        "疑似裸 LaTeX，请将完整公式放进 $…$ 或独占行的 $$…$$。",
      );
    offset += line.length + 1;
  }
  return finish();
}

/** 历史显示仅转义确定有错的片段，不修写原文、不跨段猜补定界符。 */
export function prepareAiReplyMarkdown(source: string): string {
  const normalized = normalizeAiReplyMath(source);
  const result = checkAiReply(normalized);
  const spans = result.issues
    .filter(
      (issue) => issue.severity === "error" || issue.code === "SUSPECT_MATH",
    )
    .sort((a, b) => a.start - b.start);
  let output = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.end <= cursor) continue;
    const start = Math.max(cursor, span.start);
    output += normalized.slice(cursor, start);
    const raw = normalized.slice(start, span.end);
    const ticks = "`".repeat(
      Math.max(
        3,
        ...[...raw.matchAll(/`+/g)].map((match) => match[0].length + 1),
      ),
    );
    // 使用代码文本承载，防止坏公式里的 URL 被 GFM 自动识别为链接。
    output += raw.includes("\n")
      ? `\n${ticks}text\n${raw}\n${ticks}\n`
      : `${ticks} ${raw} ${ticks}`;
    cursor = span.end;
  }
  return output + normalized.slice(cursor);
}

/** 只用于确定为参考答案的短文本，沿用现有显示侧启发式。 */
export function mathifyAiReferenceAnswer(text: string): string {
  return /\\[a-zA-Z]+/.test(text) && !text.includes("$") ? `$${text}$` : text;
}
