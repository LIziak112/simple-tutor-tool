/** 只兼容明确的LaTeX定界符；代码与普通方括号原样保留，不猜测公式。 */
export function normalizeAiReplyMath(source: string): string {
  return source.replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$)|(`+)[^\n]*?\2|\\\[([\s\S]*?)\\\]|\\\(([^\n]*?)\\\)/g,
    (
      whole: string,
      fence: string | undefined,
      code: string | undefined,
      display: string | undefined,
      inline: string | undefined,
    ) => {
      if (fence || code) return whole;
      if (display !== undefined) return `\n$$\n${display.trim()}\n$$\n`;
      return `$${inline}$`;
    },
  );
}

/** 纯文本也有固定展示预算；分页不再进入Markdown、KaTeX或链接解析。 */
export function replyTextPage(source: string, requestedPage: number) {
  const size = 4000;
  const count = Math.max(1, Math.ceil(source.length / size));
  const page = Math.max(0, Math.min(count - 1, requestedPage));
  return { text: source.slice(page * size, (page + 1) * size), page, count };
}
