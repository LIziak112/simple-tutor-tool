import { checkAiReply } from "@tutor/md-dsl";

export { normalizeAiReplyMath, prepareAiReplyMarkdown } from "@tutor/md-dsl";

/** 与本地和服务端共用确定错误检测。 */
export function hasIncompleteAiReplyMath(source: string): boolean {
  return checkAiReply(source).issues.some(
    (issue) => issue.severity === "error" || issue.code === "SUSPECT_MATH",
  );
}

/** 纯文本也有固定展示预算；分页不再进入Markdown、KaTeX或链接解析。 */
export function replyTextPage(source: string, requestedPage: number) {
  const size = 4000;
  const count = Math.max(1, Math.ceil(source.length / size));
  const page = Math.max(0, Math.min(count - 1, requestedPage));
  return { text: source.slice(page * size, (page + 1) * size), page, count };
}
