import type { AnswerKindBehavior } from "./types.ts";

/**
 * response 纯行为（TT-05a 域②，§5.3.1/§11.4 定稿）：
 * - isAnswered = body 非空白（纯行为口径；完整度与之分离——filled = body
 *   非空白**或**有正式笔迹、partial = 有笔迹无正文，由呈现/完成度层消费，
 *   I06 纪律）；
 * - 三口径文本化一致：title 非空前置一行 + 正文原样（多段 Markdown 不截断
 *   不清洗——清洗属渲染管线，文本口径只负责可读表示）；
 * - inspectShape 恒空：无结构面（字数提示 word-min/max 仅提示不校验，§5.4.1）。
 */
export const responseBehavior: AnswerKindBehavior<
  { kind: "response"; title?: string; body: string },
  null
> = {
  isAnswered: (answer) => answer.body.trim() !== "",
  formatStudent: (answer) => {
    const title = answer.title?.trim() ?? "";
    if (title === "") return answer.body;
    return `${title}\n${answer.body}`;
  },
  inspectShape: () => [],
};

// ---------- 字数口径（QM-09：契约与 UI 共用单源） ----------

/**
 * CJK 计数字符（逐个计 1）：汉字（含扩展 A 区）+ 假名 + 谚文 + CJK 标点段
 * （U+3000–303F：。、「」『』等）+ 全角形式段（U+FF00–FFEF：！？，（）等）
 * + 中文行文常用的通用标点段（U+2013–2026：——……“”‘’）。作文字数惯例
 * 含标点，故中文标点一并计入。
 */
const CJK_CHAR_RE = "[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿㄰-㆏가-힯＀-￯–-…]";

/**
 * 拉丁词（连续字母/数字 + 内嵌撇号/连字符计 1 词）：it's = 1、well-known = 1、
 * 250 = 1。撇号兼容直撇与弯撇；下划线不属词。
 */
const LATIN_WORD_RE = "[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*";

/**
 * response 正文字数（QM-09 细项 1「字数口径明确」的契约单源）：
 * **中文按字（含中文标点）、英文按词（连续拉丁字母/数字/撇号串计 1）**，
 * 两者相加；空白、换行、英文标点与 Markdown/LaTeX 语法符号不计（公式按其
 * 可见字符同样计入，不特殊处理）。UI 字数统计与服务端口径共用本实现；
 * 输入是待计文本（正文），标题是否并入由调用方决定并在界面说明。
 */
export function countResponseWords(text: string): number {
  const cjk = text.match(new RegExp(CJK_CHAR_RE, "g"))?.length ?? 0;
  const latin = text.match(new RegExp(LATIN_WORD_RE, "g"))?.length ?? 0;
  return cjk + latin;
}
