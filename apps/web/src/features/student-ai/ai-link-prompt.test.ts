import { describe, expect, it, vi } from "vitest";
import { buildAiLinkPrompt } from "./ai-link-prompt";

describe("发给外部 AI 的链接说明", () => {
  it("HTTP 局域网环境没有 randomUUID 时仍能复制读取说明", () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    try {
      const url = "http://192.0.2.1/api/public/ai/share/test-ticket";
      const first = buildAiLinkPrompt(url);
      expect(first).toContain(`${url}?read=`);
      expect(buildAiLinkPrompt(url)).not.toBe(first);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("每次复制生成新的读取标记，明确逐个重新读取而非复用缓存", () => {
    const url = "https://tutor.example.com/api/public/ai/share/test-ticket";
    const first = buildAiLinkPrompt(url);
    const second = buildAiLinkPrompt(url);
    expect(first).not.toBe(second);
    expect(first).toContain(`${url}?read=`);
    expect(first).toContain("每次回答前");
    expect(first).toContain("逐条重新打开");
    expect(first).toContain("不要使用之前的读取结果或缓存");
    expect(first).toContain("无法读取");
    expect(first).toContain("题号");
  });
});
