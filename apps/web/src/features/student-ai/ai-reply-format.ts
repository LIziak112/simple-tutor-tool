/** 兼容常见定界符和独占行的裸公式；代码与普通正文原样保留。 */
export function normalizeAiReplyMath(source: string): string {
  return source.replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$)|(`+)[^\n]*?\2|\\\[([\s\S]*?)\\\]|\\\(([^\n]*?)\\\)|^( {0,3}(?:>\s*)?)(\\(?:frac|lim|int|sum|prod|sqrt|begin|left|operatorname)(?![a-zA-Z])[^\n$`]*)$/gm,
    (
      whole: string,
      fence: string | undefined,
      code: string | undefined,
      display: string | undefined,
      inline: string | undefined,
      prefix: string | undefined,
      bare: string | undefined,
    ) => {
      if (fence || code) return whole;
      if (display !== undefined) return `\n$$\n${display.trim()}\n$$\n`;
      if (bare !== undefined) {
        const container = prefix?.includes(">") ? prefix : "";
        return `\n${container}$$\n${container}${bare}\n${container}$$\n`;
      }
      return `$${inline}$`;
    },
  );
}

/** 检出无法可靠配对的行内定界符，不猜测或篡改缺失内容。 */
export function hasIncompleteAiReplyMath(source: string): boolean {
  const withoutCode = source.replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$)|(`+)[^\n]*?\2/g,
    "",
  );
  return withoutCode.split("\n").some((line) => {
    if (!/\\[a-zA-Z]+/.test(line) || line.includes("$$")) return false;
    const dollars = line.match(/(?<![\\$])\$(?!\$)/g);
    return (dollars?.length ?? 0) % 2 === 1;
  });
}

/** 纯文本也有固定展示预算；分页不再进入Markdown、KaTeX或链接解析。 */
export function replyTextPage(source: string, requestedPage: number) {
  const size = 4000;
  const count = Math.max(1, Math.ceil(source.length / size));
  const page = Math.max(0, Math.min(count - 1, requestedPage));
  return { text: source.slice(page * size, (page + 1) * size), page, count };
}
