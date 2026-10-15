import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import {
  type GuardedResponse,
  OutboundTargetError,
} from "./outbound-target.ts";
import {
  executeChatCompletions,
  type ProviderTransport,
  type ProviderTransportRequest,
} from "./provider-client.ts";
import {
  dispatchToProvider,
  type ProviderDispatchInput,
} from "./student-ai-provider-adapter.ts";
import type { OutboundAssembly } from "./student-ai-context.ts";

/**
 * SAI-17 页内 AI 执行链的供应商适配层测试（B09 必测第一/二条的归一层）：
 * - executeChatCompletions：在 SAI-16 学生可读壳之下的内部详细结果——
 *   图像 content parts、usage 归一、失败 reason 分类与 Retry-After 解析；
 *   callChatCompletions 的既有学生可读形态不受影响（既有测试锁定）；
 * - dispatchToProvider：服务端批准的装配产物 + 选定图片 → 统一请求格式；
 *   模型不支持图且未减选时出站前阻断（不偷偷丢图）；供应商异常只暴露
 *   受控错误（kind/message 均为固定中文短句，无供应商原文/头/堆栈）。
 */

/** 可捕获请求的假 transport（provider-client.test 同款形态） */
function fakeTransport(
  respond: (request: ProviderTransportRequest) => GuardedResponse | Error,
): {
  transport: ProviderTransport;
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

const okBody = JSON.stringify({
  choices: [
    { message: { role: "assistant", content: "这是模型回复" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const respond = (bodyText: string, headers: Record<string, string> = {}) => ({
  status: 200,
  headers: { "content-type": "application/json", ...headers },
  bodyText,
});

const NO_NOW = () => new Date(Date.parse("2026-06-01T00:00:00.000Z"));

describe("executeChatCompletions（内部详细结果）", () => {
  it("成功：解析回信与 usage（驼峰归一）", async () => {
    const { transport } = fakeTransport(() => respond(okBody));
    const result = await executeChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-key",
      model: "glm-test",
      messages: [{ role: "user", content: "题目求助" }],
      timeoutMs: 60_000,
      requestRef: "task-1",
      transport,
    });
    expect(result).toEqual({
      ok: true,
      content: "这是模型回复",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  it("图像 content parts：消息体按 OpenAI 多模态形态序列化", async () => {
    const { transport, requests } = fakeTransport(() => respond(okBody));
    await executeChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-key",
      model: "glm-test",
      messages: [
        { role: "system", content: "系统段" },
        {
          role: "user",
          content: [
            { type: "text", text: "上下文数据" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
          ],
        },
      ],
      timeoutMs: 60_000,
      requestRef: "task-1",
      transport,
    });
    const body = JSON.parse(requests[0]?.body ?? "{}") as {
      messages?: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages?.[0]).toEqual({ role: "system", content: "系统段" });
    expect(body.messages?.[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "上下文数据" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  it("429：reason=rate_limited，Retry-After 秒数解析为毫秒", async () => {
    const { transport } = fakeTransport(() => ({
      status: 429,
      headers: { "retry-after": "7" },
      bodyText: "{}",
    }));
    const result = await executeChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "q" }],
      timeoutMs: 1000,
      requestRef: "t",
      transport,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "AI_OUTBOUND_FAILED",
      reason: "rate_limited",
      retryAfterMs: 7000,
      message: "请求频率或额度受限，请稍后重试",
    });
  });

  it("429：Retry-After 为 HTTP 日期时按注入时钟换算剩余毫秒", async () => {
    const now = NO_NOW();
    const { transport } = fakeTransport(() => ({
      status: 429,
      headers: {
        "retry-after": new Date(now.getTime() + 30_000).toUTCString(),
      },
      bodyText: "{}",
    }));
    const result = await executeChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "q" }],
      timeoutMs: 1000,
      requestRef: "t",
      transport,
      now,
    });
    expect(result).toMatchObject({ ok: false, reason: "rate_limited", retryAfterMs: 30_000 });
  });

  it("429：Retry-After 异常值（非数字非日期）不产生 retryAfterMs", async () => {
    const { transport } = fakeTransport(() => ({
      status: 429,
      headers: { "retry-after": "soon" },
      bodyText: "{}",
    }));
    const result = await executeChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "q" }],
      timeoutMs: 1000,
      requestRef: "t",
      transport,
    });
    expect(result).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(result).not.toHaveProperty("retryAfterMs");
  });

  it("429：Retry-After 过大（恶意长阻塞）解析封顶 24h", async () => {
    const { transport } = fakeTransport(() => ({
      status: 429,
      headers: { "retry-after": "999999999" },
      bodyText: "{}",
    }));
    const result = await executeChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "q" }],
      timeoutMs: 1000,
      requestRef: "t",
      transport,
    });
    expect(result).toMatchObject({ retryAfterMs: 24 * 60 * 60 * 1000 });
  });

  it("状态分类：401→auth、404→not_found、400→bad_request、5xx→server_error", async () => {
    const cases: Array<[number, string]> = [
      [401, "auth"],
      [404, "not_found"],
      [400, "bad_request"],
      [500, "server_error"],
    ];
    for (const [status, reason] of cases) {
      const { transport } = fakeTransport(() => ({
        status,
        headers: {},
        bodyText: "{}",
      }));
      const result = await executeChatCompletions({
        baseUrl: "https://api.example.com/v1",
        apiKey: "k",
        model: "m",
        messages: [{ role: "user", content: "q" }],
        timeoutMs: 1000,
        requestRef: "t",
        transport,
      });
      expect(result).toMatchObject({ ok: false, reason });
    }
  });

  it("503 带 Retry-After：server_error 且携带毫秒指引", async () => {
    const { transport } = fakeTransport(() => ({
      status: 503,
      headers: { "retry-after": "5" },
      bodyText: "{}",
    }));
    const result = await executeChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "q" }],
      timeoutMs: 1000,
      requestRef: "t",
      transport,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "server_error",
      retryAfterMs: 5000,
    });
  });

  it("200 但结构损坏：reason=bad_response（供应商已处理，不可自动重试语义由上层裁决）", async () => {
    const { transport } = fakeTransport(() => respond("<html>not json</html>"));
    const result = await executeChatCompletions({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "q" }],
      timeoutMs: 1000,
      requestRef: "t",
      transport,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "bad_response",
      message: "供应商响应格式无法解析",
    });
  });

  it("传输异常分类：TIMEOUT→timeout、NETWORK→network、BODY_TOO_LARGE→response_aborted、TARGET_BLOCKED→target_blocked", async () => {
    const cases: Array<[OutboundTargetError["code"], string]> = [
      ["TIMEOUT", "timeout"],
      ["NETWORK", "network"],
      ["BODY_TOO_LARGE", "response_aborted"],
      ["TARGET_BLOCKED", "target_blocked"],
    ];
    for (const [code, reason] of cases) {
      const { transport } = fakeTransport(
        () => new OutboundTargetError(code, "出站请求超时"),
      );
      const result = await executeChatCompletions({
        baseUrl: "https://api.example.com/v1",
        apiKey: "k",
        model: "m",
        messages: [{ role: "user", content: "q" }],
        timeoutMs: 1000,
        requestRef: "t",
        transport,
      });
      expect(result).toMatchObject({ ok: false, reason });
      expect(result.ok === false && result.code === "AI_OUTBOUND_TIMEOUT"
        ? "AI_OUTBOUND_TIMEOUT"
        : reason).toBe(reason === "timeout" ? "AI_OUTBOUND_TIMEOUT" : reason);
    }
  });
});

/** 最小装配产物（真实形态由 student-ai-context.assembleOutboundMessages 产出） */
function assemblyOf(): OutboundAssembly {
  return {
    systemPromptMd: "【系统段】",
    contextDataMd: "【待分析数据】题面与作答",
    messages: [
      { role: "system", content: "【系统段】" },
      { role: "user", content: "【待分析数据】题面与作答" },
      { role: "user", content: "请帮我讲解本题" },
    ],
  };
}

function dispatchInput(
  overrides: Partial<ProviderDispatchInput> = {},
): ProviderDispatchInput {
  return {
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test-key",
    model: "glm-test",
    imageCapability: "unknown",
    assembly: assemblyOf(),
    images: [],
    requestRef: "task-1",
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe("dispatchToProvider（服务端批准上下文 → 统一出站）", () => {
  it("装配：system 保持字符串，首个 user 消息追加 image_url 数据部件，诉求保持文本", async () => {
    const { transport, requests } = fakeTransport(() => respond(okBody));
    const result = await dispatchToProvider(
      dispatchInput({
        images: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
        transport,
      }),
    );
    expect(result.ok).toBe(true);
    const body = JSON.parse(requests[0]?.body ?? "{}") as {
      model?: string;
      stream?: boolean;
      messages?: Array<{ role: string; content: unknown }>;
    };
    expect(body.model).toBe("glm-test");
    expect(body.stream).toBe(false);
    expect(body.messages?.[0]).toEqual({ role: "system", content: "【系统段】" });
    const contextContent = body.messages?.[1]?.content as Array<
      Record<string, unknown>
    >;
    expect(contextContent[0]).toEqual({ type: "text", text: "【待分析数据】题面与作答" });
    expect(contextContent[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AQID" },
    });
    expect(contextContent[2]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,BAU=" },
    });
    expect(body.messages?.[2]).toEqual({ role: "user", content: "请帮我讲解本题" });
  });

  it("模型不支持图且学生未减选：出站前阻断（零出站调用），needs_reconfig 明示", async () => {
    const { transport, requests } = fakeTransport(() => respond(okBody));
    const result = await dispatchToProvider(
      dispatchInput({
        imageCapability: "unsupported",
        images: [new Uint8Array([1])],
        transport,
      }),
    );
    expect(result).toEqual({
      ok: false,
      kind: "needs_reconfig",
      message: expect.stringContaining("不支持识图") as unknown,
    });
    expect(requests.length).toBe(0);
  });

  it("模型不支持图但本次无图：照常出站（仅文字是合法形态）", async () => {
    const { transport, requests } = fakeTransport(() => respond(okBody));
    const result = await dispatchToProvider(
      dispatchInput({ imageCapability: "unsupported", transport }),
    );
    expect(result.ok).toBe(true);
    expect(requests.length).toBe(1);
  });

  it("成功：透传回信与 usage", async () => {
    const { transport } = fakeTransport(() => respond(okBody));
    const result = await dispatchToProvider(dispatchInput({ transport }));
    expect(result).toEqual({
      ok: true,
      content: "这是模型回复",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  it("错误归一：429→rate_limited（携带 retryAfterMs）", async () => {
    const { transport } = fakeTransport(() => ({
      status: 429,
      headers: { "retry-after": "3" },
      bodyText: "{}",
    }));
    const result = await dispatchToProvider(dispatchInput({ transport }));
    expect(result).toEqual({
      ok: false,
      kind: "rate_limited",
      message: "请求频率或额度受限，请稍后重试",
      retryAfterMs: 3000,
    });
  });

  it("错误归一：5xx→server_error（无指引时 retryAfterMs=null）", async () => {
    const { transport } = fakeTransport(() => ({
      status: 502,
      headers: {},
      bodyText: "{}",
    }));
    const result = await dispatchToProvider(dispatchInput({ transport }));
    expect(result).toEqual({
      ok: false,
      kind: "server_error",
      message: "供应商服务暂不可用，请稍后重试",
      retryAfterMs: null,
    });
  });

  it("错误归一：401→needs_reconfig（Key 无效不重试）", async () => {
    const { transport } = fakeTransport(() => ({
      status: 401,
      headers: {},
      bodyText: "{}",
    }));
    const result = await dispatchToProvider(dispatchInput({ transport }));
    expect(result).toEqual({
      ok: false,
      kind: "needs_reconfig",
      message: "API Key 无效或无权限访问该模型",
    });
  });

  it("错误归一：超时→uncertain（可能已收费，状态不明）", async () => {
    const { transport } = fakeTransport(
      () => new OutboundTargetError("TIMEOUT", "出站请求超时"),
    );
    const result = await dispatchToProvider(dispatchInput({ transport }));
    expect(result).toEqual({
      ok: false,
      kind: "uncertain",
      message: "出站请求超时，无法确认供应商是否已处理；已标记为发送结果待确认，请核对后再决定是否重试",
    });
  });

  it("错误归一：响应体超限→uncertain", async () => {
    const { transport } = fakeTransport(
      () => new OutboundTargetError("BODY_TOO_LARGE", "出站响应超出大小上限"),
    );
    const result = await dispatchToProvider(dispatchInput({ transport }));
    expect(result).toMatchObject({ ok: false, kind: "uncertain" });
  });

  it("错误归一：网络失联（未送达）→failed", async () => {
    const { transport } = fakeTransport(
      () => new OutboundTargetError("NETWORK", "出站网络错误"),
    );
    const result = await dispatchToProvider(dispatchInput({ transport }));
    expect(result).toEqual({
      ok: false,
      kind: "failed",
      message: "出站网络错误",
    });
  });

  it("错误归一：结构损坏→failed（不自动重试）", async () => {
    const { transport } = fakeTransport(() => respond("not-json"));
    const result = await dispatchToProvider(dispatchInput({ transport }));
    expect(result).toEqual({
      ok: false,
      kind: "failed",
      message: "供应商响应格式无法解析",
    });
  });

  it("错误归一：出站目标被拦（连接级 SSRF 裁决）→needs_reconfig", async () => {
    const { transport } = fakeTransport(
      () => new OutboundTargetError("TARGET_BLOCKED", "目标地址不允许"),
    );
    const result = await dispatchToProvider(dispatchInput({ transport }));
    expect(result).toEqual({
      ok: false,
      kind: "needs_reconfig",
      message: "目标地址不允许",
    });
  });

  it("对账标识进 User-Agent，不进消息体", async () => {
    const { transport, requests } = fakeTransport(() => respond(okBody));
    await dispatchToProvider(dispatchInput({ transport }));
    expect(requests[0]?.headers["user-agent"]).toContain("task-1");
    expect(requests[0]?.body).not.toContain("task-1");
  });

  it("logger 缺省不抛错（生产注入 pino）", async () => {
    const { transport } = fakeTransport(() => respond(okBody));
    const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;
    const result = await dispatchToProvider(
      dispatchInput({ transport, logger }),
    );
    expect(result.ok).toBe(true);
  });
});
