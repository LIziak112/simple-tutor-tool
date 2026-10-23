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
