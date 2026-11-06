import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const parser = unified().use(remarkParse).use(remarkGfm);
const mathParser = unified().use(remarkParse).use(remarkMath).use(remarkGfm);

/** 与页面同一 remark-math 语法，区分同一行 $$ 与真正块公式。 */
export function aiReplyMathNodes(source: string) {
  const nodes: Array<{ value: string; start: number; display: boolean }> = [];
  visit(mathParser.parse(source), (node) => {
    if (
      (node.type === "math" || node.type === "inlineMath") &&
      "value" in node &&
      typeof node.value === "string"
    ) {
      nodes.push({
        value: node.value,
        start: node.position?.start.offset ?? 0,
        display: node.type === "math",
      });
    }
  });
  return nodes;
}

/** 普通 Markdown 的代码和显式链接不参与数学转换；裸 URL 不遮住公式闭合符。 */
export function protectedAiReplyRanges(source: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  visit(parser.parse(source), (node) => {
    if (
      !["code", "inlineCode", "link", "image", "definition", "html"].includes(
        node.type,
      )
    )
      return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === "link" && !["[", "<"].includes(source[start] ?? ""))
      return;
    ranges.push({ start, end });
  });
  return ranges.sort((a, b) => a.start - b.start);
}

export function normalizeAiReplyMath(source: string): string {
  let result = "";
  let cursor = 0;
  for (const range of protectedAiReplyRanges(source)) {
    if (range.start < cursor) continue;
    result +=
      normalizeChunk(source.slice(cursor, range.start)) +
      source.slice(range.start, range.end);
    cursor = range.end;
  }
  return result + normalizeChunk(source.slice(cursor));
}

/** 兼容常见定界符和独占行的裸公式；代码与普通正文原样保留。 */
function normalizeChunk(source: string): string {
  return source.replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$)|(`+)[^\n]*?\2|\\\[([\s\S]*?)\\\]|\\\(([^\n]*?)\\\)|(^ {0,3}(?:> ?)?\$\$[^\n]*\n[\s\S]*?^ {0,3}(?:> ?)?\$\$[ \t]*$)|^( {0,3}(?:>\s*)?)([+-]?\\(?:frac|lim|int|sum|prod|sqrt|begin|left|operatorname)(?![a-zA-Z])[^\n$`]*)$/gm,
    (
      whole: string,
      fence: string | undefined,
      code: string | undefined,
      display: string | undefined,
      inline: string | undefined,
      existingBlock: string | undefined,
      prefix: string | undefined,
      bare: string | undefined,
    ) => {
      if (fence || code || existingBlock) return whole;
      if (display !== undefined) return `\n$$\n${display.trim()}\n$$\n`;
      if (bare !== undefined) {
        const container = prefix?.includes(">") ? prefix : "";
        return `\n${container}$$\n${container}${bare}\n${container}$$\n`;
      }
      return `$${inline}$`;
    },
  );
}
