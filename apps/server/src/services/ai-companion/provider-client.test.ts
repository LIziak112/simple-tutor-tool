import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import {
  type GuardedResponse,
  OutboundTargetError,
} from "./outbound-target.ts";
import {
  CONNECTION_TEST_PROBE,
  callChatCompletions,
  chatCompletionsUrl,
  type ProviderTransportRequest,
  testProviderConnection,
} from "./provider-client.ts";

/**
 * SAI-16 供应商客户端（B00 §7 协议：OpenAI 兼容 /chat/completions，
 * fetch/node http 直调零新依赖）：
 * - 请求装配：URL 拼接、Authorization/UA（对账标识）、JSON 体；
 * - 错误脱敏：任何失败只回中文短句与错误码，不透传供应商响应头、
 *   原始报文或堆栈（攻击用例表 secret 行 + §7「异常响应不透传」）；
 * - 日志屏蔽：Authorization 只留 scheme，正文（含题目）不进日志；
 * - 重定向不自动跟随：3xx 即失败，绝不取 Location 再连；
 * - 测试连接探针：固定短文案，绝不携带题面/答案（capability 行）。
 */

/** 收集日志行的假 logger（pino 结构兼容） */
function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = {
    info: (obj: unknown, msg: string) =>
      lines.push(`${msg} ${JSON.stringify(obj)}`),
    warn: (obj: unknown, msg: string) =>
      lines.push(`${msg} ${JSON.stringify(obj)}`),
    error: (obj: unknown, msg: string) =>
      lines.push(`${msg} ${JSON.stringify(obj)}`),
  } as unknown as Logger;
  return { logger, lines };
}

/** 可捕获请求的假 transport */
function fakeTransport(
  respond: (request: ProviderTransportRequest) => GuardedResponse | Error,
): {
  transport: (request: ProviderTransportRequest) => Promise<GuardedResponse>;
  requests: ProviderTransportRequest[];
} {
  const requests: ProviderTransportRequest[] = [];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      const outcome = respond(request);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const okBody = (content: string): string =>
  JSON.stringify({
    choices: [
      { message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { total_tokens: 12 },
  });

describe("chatCompletionsUrl", () => {
  it("baseUrl 带尾斜杠/不带都能拼出 /chat/completions，不吞路径段", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.example.com")).toBe(
      "https://api.example.com/chat/completions",
    );
  });
});

describe("callChatCompletions", () => {
  it("成功：装配 URL/Authorization/UA/JSON 体并解析回信", async () => {
    const { transport, requests } = fakeTransport(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText: okBody("你好，这是回复"),
    }));
    const result = await callChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-live-key-123456",
      model: "glm-test",
      messages: [{ role: "user", content: "题目求助" }],
      timeoutMs: 60_000,
      requestRef: "task-1",
      transport,
    });
    expect(result).toEqual({
      ok: true,
      content: "你好，这是回复",
    });
    const request = requests[0];
    expect(request?.url).toBe("https://api.example.com/v1/chat/completions");
    expect(request?.headers.authorization).toBe("Bearer sk-live-key-123456");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["user-agent"]).toContain("OwnClass");
    expect(request?.headers["user-agent"]).toContain("task-1");
    expect(request?.timeoutMs).toBe(60_000);
    const body = JSON.parse(request?.body ?? "{}") as {
      model?: string;
      stream?: boolean;
      messages?: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("glm-test");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "题目求助" }]);
  });

  it("日志屏蔽：Authorization 只留 scheme，正文与 Key 不进日志", async () => {
    const { logger, lines } = capturingLogger();
    const { transport } = fakeTransport(() => ({
      status: 401,
      headers: { "x-vendor-debug": "sk-live-key-123456" },
      bodyText: "unauthorized",
    }));
    await callChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-live-key-123456",
      model: "glm-test",
      messages: [{ role: "user", content: "这道题答案是 B 吗" }],
      timeoutMs: 60_000,
      requestRef: "task-2",
      transport,
      logger,
    });
    const all = lines.join("\n");
    expect(all).not.toContain("sk-live-key-123456");
    expect(all).toContain("Bearer ***");
    // 正文（学生问题）不进日志
    expect(all).not.toContain("这道题答案是 B 吗");
  });

  it("401/403 → Key 无效；429 → 频率/额度；5xx → 供应商暂不可用；不透传响应体/响应头", async () => {
    const cases: ReadonlyArray<{
      status: number;
      vendorBody: string;
      expectText: RegExp;
    }> = [
      {
        status: 401,
        vendorBody: "invalid api key sk-live",
        expectText: /API Key 无效/,
      },
      { status: 403, vendorBody: "forbidden", expectText: /API Key 无效/ },
      { status: 429, vendorBody: "quota exceeded", expectText: /频率或额度/ },
      { status: 503, vendorBody: "upstream down", expectText: /暂不可用/ },
    ];
    for (const { status, vendorBody, expectText } of cases) {
      const { transport } = fakeTransport(() => ({
        status,
        headers: { "x-vendor-request-id": "req_abc" },
        bodyText: vendorBody,
      }));
      const result = await callChatCompletions({
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-k",
        model: "m",
        messages: [{ role: "user", content: "q" }],
        timeoutMs: 1000,
        requestRef: "task-3",
        transport,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("AI_OUTBOUND_FAILED");
        expect(result.message).toMatch(expectText);
        expect(result.message).not.toContain(vendorBody);
        expect(result.message).not.toContain("req_abc");
      }
    }
  });

  it("3xx 重定向 → 失败且不跟随：transport 只被调用一次", async () => {
    const { transport, requests } = fakeTransport(() => ({
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
      bodyText: "",
    }));
    const result = await callChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-k",
      model: "m",
      messages: [{ role: "user", content: "q" }],
      timeoutMs: 1000,
      requestRef: "task-4",
      transport,
    });
    expect(result).toEqual({
      ok: false,
      code: "AI_OUTBOUND_FAILED",
      message: expect.stringMatching(/重定向/) as unknown as string,
    });
    expect(requests).toHaveLength(1);
  });

  it("2xx 但响应体不可解析 → 供应商响应格式无法解析（不透传原文）", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      headers: {},
      bodyText: "<html>gateway error page</html>",
    }));
    const result = await callChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-k",
      model: "m",
      messages: [{ role: "user", content: "q" }],
      timeoutMs: 1000,
      requestRef: "task-5",
      transport,
    });
    expect(result).toEqual({
      ok: false,
      code: "AI_OUTBOUND_FAILED",
      message: "供应商响应格式无法解析",
    });
  });

  it("TIMEOUT 形态 → AI_OUTBOUND_TIMEOUT；SSRF/网络形态 → AI_OUTBOUND_FAILED 且消息即守卫中文消息", async () => {
    const timeout = fakeTransport(
      () => new OutboundTargetError("TIMEOUT", "出站请求超时"),
    );
    const timeoutResult = await callChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-k",
      model: "m",
      messages: [{ role: "user", content: "q" }],
      timeoutMs: 1000,
      requestRef: "task-6",
      transport: timeout.transport,
    });
    expect(timeoutResult).toEqual({
      ok: false,
      code: "AI_OUTBOUND_TIMEOUT",
      message: "出站请求超时",
    });

    const blocked = fakeTransport(
      () =>
        new OutboundTargetError(
          "TARGET_BLOCKED",
          "出站目标 api.example.com 解析到内网/保留地址，已拒绝连接（安全策略）",
        ),
    );
    const blockedResult = await callChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-k",
      model: "m",
      messages: [{ role: "user", content: "q" }],
      timeoutMs: 1000,
      requestRef: "task-7",
      transport: blocked.transport,
    });
    expect(blockedResult).toEqual({
      ok: false,
      code: "AI_OUTBOUND_FAILED",
      message: expect.stringMatching(/内网\/保留地址/) as unknown as string,
    });
  });

  it("未知异常 → 统一壳，不透传堆栈/消息", async () => {
    const { transport } = fakeTransport(() => new Error("secret stack detail"));
    const result = await callChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-k",
      model: "m",
      messages: [{ role: "user", content: "q" }],
      timeoutMs: 1000,
      requestRef: "task-8",
      transport,
    });
    expect(result).toEqual({
      ok: false,
      code: "AI_OUTBOUND_FAILED",
      message: "出站请求失败，请稍后重试",
    });
  });
});

describe("testProviderConnection", () => {
  it("探针固定文案：请求体不含题面/答案/学生数据，max_tokens 受限，超时取测试时限", async () => {
    const { transport, requests } = fakeTransport(() => ({
      status: 200,
      headers: {},
      bodyText: okBody("ok"),
    }));
    const result = await testProviderConnection({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-k",
      model: "m",
      transport,
    });
    expect(result).toEqual({ ok: true, content: "ok" });
    const body = JSON.parse(requests[0]?.body ?? "{}") as {
      max_tokens?: number;
      messages?: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toEqual([
      { role: "user", content: CONNECTION_TEST_PROBE },
    ]);
    expect(body.max_tokens).toBeLessThanOrEqual(32);
    expect(requests[0]?.timeoutMs).toBe(10_000);
    expect(requests[0]?.headers["user-agent"]).toContain("connection-test");
    // 攻击用例 capability 行：测试连接绝不自动带题面
    const raw = requests[0]?.body ?? "";
    for (const sentinel of [
      "题目",
      "answer",
      "solution",
      "studentId",
      "attemptId",
    ]) {
      expect(raw).not.toContain(sentinel);
    }
  });

  it("探针文案是固定常量（无任何可变学生输入）", () => {
    expect(CONNECTION_TEST_PROBE).toBe("连接测试：请只回复 ok。");
  });
});
