import { describe, expect, it, vi } from "vitest";
import { OutboundTargetError } from "./outbound-target.ts";
import {
  fetchProviderModels,
  type ProviderTransport,
  testProviderConnection,
} from "./provider-client.ts";

const credentials = {
  baseUrl: "https://ai.example.com/v1/",
  apiKey: "sk-private-sentinel",
};

describe("供应商模型列表", () => {
  it("测试连接必须实际收到模型文字，空回复不能冒充成功", async () => {
    const result = await testProviderConnection({
      ...credentials,
      model: "chat-a",
      transport: async () => ({
        status: 200,
        headers: {},
        bodyText: '{"choices":[{"message":{"content":""}}]}',
      }),
    });
    expect(result.ok).toBe(false);
  });
  it("通过带认证的 GET 获取模型，只保留合法 ID、去重排序，不发送正文", async () => {
    const transport = vi.fn<ProviderTransport>().mockResolvedValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({
        data: [
          { id: "z-chat", owned_by: "不返回" },
          { id: "a-chat" },
          { id: "z-chat" },
          { id: "" },
          { id: 123 },
          { id: "x".repeat(1000) },
        ],
      }),
    });
    expect(await fetchProviderModels({ ...credentials, transport })).toEqual({
      ok: true,
      models: ["a-chat", "z-chat"],
    });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://ai.example.com/v1/models",
        method: "GET",
        body: "",
        headers: expect.objectContaining({
          authorization: "Bearer sk-private-sentinel",
        }),
      }),
    );
  });
  it.each([401, 403, 404, 429, 500, 302])(
    "HTTP %i 给出恢复建议，不透传原始报文",
    async (status) => {
      const transport: ProviderTransport = async () => ({
        status,
        headers: { location: "http://localhost" },
        bodyText: "sk-private-sentinel /SECRET/",
      });
      const result = await fetchProviderModels({ ...credentials, transport });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(
        /sk-private-sentinel|SECRET|localhost/,
      );
      expect(result).toHaveProperty(
        "message",
        expect.stringMatching(/检查|重试|填写/),
      );
    },
  );
  it.each([
    "<html>错误页</html>",
    "{}",
    '{"data":{}}',
    '{"data":[{"id":123}]}',
  ])("拒绝无法使用的响应 %s", async (bodyText) => {
    const result = await fetchProviderModels({
      ...credentials,
      transport: async () => ({ status: 200, headers: {}, bodyText }),
    });
    expect(result.ok).toBe(false);
  });
  it("空列表如实返回，超时和未知错误安全降级", async () => {
    expect(
      await fetchProviderModels({
        ...credentials,
        transport: async () => ({
          status: 200,
          headers: {},
          bodyText: '{"data":[]}',
        }),
      }),
    ).toEqual({ ok: true, models: [] });
    for (const error of [
      new OutboundTargetError("TIMEOUT", "出站请求超时"),
      new Error("sk-private-sentinel"),
    ]) {
      const result = await fetchProviderModels({
        ...credentials,
        transport: async () => {
          throw error;
        },
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(credentials.apiKey);
    }
  });
  it("真实传输仍拒绝内网目标", async () => {
    expect(
      (
        await fetchProviderModels({
          baseUrl: "http://127.0.0.1/v1",
          apiKey: "test",
        })
      ).ok,
    ).toBe(false);
  });
});
