/** 每次复制使用新的读取标记，减少外部抓取器按相同 URL 沿用缓存的机会。 */
export function buildAiLinkPrompt(ticketUrl: string): string {
  const url = new URL(ticketUrl);
  url.searchParams.set("read", randomUuid());
  return `请读取下面的单题资料，回答其中「学生的问题」。每条链接只包含一道题。
每次回答前，请逐条重新打开本次消息提供的所有链接，不要使用之前的读取结果或缓存；如果有多个链接，请逐一说明实际读到的题号和题干摘要，再分别回答，不要只读取其中一个。
如有链接无法读取、已失效或没有联网能力，请明确指出具体链接并请我提供文字和材料，不要猜测题目内容。
${url.href}`;
}

import { randomUuid } from "@/lib/uuid";
