import {
  AI_CONNECTION_TEST_TIMEOUT_MS,
  AI_OUTBOUND_TIMEOUT_MS,
} from "@tutor/contract";
import type { Logger } from "pino";
import { redactHeaderValue } from "../../lib/log-redact.ts";
import {
  type GuardedResponse,
  OutboundTargetError,
  requestWithTargetGuard,
} from "./outbound-target.ts";

/**
 * SAI-16 供应商客户端（B00 §7：OpenAI 兼容 POST {baseUrl}/chat/completions，
 * stream:false 首发，node http 直调零新依赖；出站目标防护见 outbound-target）。
 *
 * 安全口径（攻击用例表 secret/capability 行）：
 * - Authorization 只出现在请求头；日志经 redactHeaderValue 只留 scheme，
 *   请求正文（含学生问题）绝不写日志；
 * - 一切失败收敛为中文短句 + 错误码，不透传供应商响应头、原始报文或
 *   堆栈（上层 HttpError 直接面向学生）；
 * - 3xx 即失败不跟随（守卫层也不复核 Location——从不发第二次连接）；
 * - User-Agent 固定标识 + 对账标识（任务 id / connection-test），便于
 *   网关侧对账；标识是服务端任务 id，不是学生内部 UUID；
 * - 测试连接探针为固定短文案（无学生数据），max_tokens 受限。
 */

/** 出站消息形态（system/user/assistant；装配层负责内容边界） */
export interface ProviderMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** 传输请求（假 transport 捕获点 = 连接层桩） */
export interface ProviderTransportRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly timeoutMs: number;
}

/** 传输层（缺省守卫直调；测试注入桩） */
export type ProviderTransport = (
  request: ProviderTransportRequest,
) => Promise<GuardedResponse>;

/** 缺省传输：带连接级防护的真实出站（SSRF 策略在 outbound-target） */
export const defaultProviderTransport: ProviderTransport = (request) =>
  requestWithTargetGuard(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    timeoutMs: request.timeoutMs,
  });

/** 调用输入 */
export interface ChatCompletionsInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly messages: ReadonlyArray<ProviderMessage>;
  /** 连接+读完的整体时限（ms；测试连接 AI_CONNECTION_TEST_TIMEOUT_MS、
   * 正式出站 AI_OUTBOUND_TIMEOUT_MS 由调用方选） */
  readonly timeoutMs: number;
  /** 对账标识：任务 id 或 "connection-test"（进 User-Agent，绝不进消息体） */
  readonly requestRef: string;
  /** 响应长度上限（测试连接用小值控费；缺省不设） */
  readonly maxTokens?: number;
  readonly transport?: ProviderTransport;
  readonly logger?: Logger;
}

/** 调用结果：失败只带错误码与中文短句（无供应商原文/头/堆栈） */
export type ChatCompletionsResult =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly code: "AI_OUTBOUND_FAILED" | "AI_OUTBOUND_TIMEOUT";
      readonly message: string;
    };

/** 固定 User-Agent 标识（网关侧对账；不含学生信息） */
const USER_AGENT_PREFIX = "OwnClass-AICompanion/2.0";

/** 拼接 chat/completions 完整 URL（baseUrl 带不带尾斜杠均可） */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}/chat/completions`;
}

/** 连接测试探针（固定文案：无题目、无学生数据；capability 行要求） */
export const CONNECTION_TEST_PROBE = "连接测试：请只回复 ok。";

/** HTTP 状态 → 学生可读的失败短句（只含状态码语义，不含响应内容） */
function failureMessageOf(status: number): string {
  if (status >= 300 && status < 400) {
    return "供应商返回重定向，已拒绝跟随（请检查接口地址）";
  }
  if (status === 401 || status === 403) {
    return "API Key 无效或无权限访问该模型";
  }
  if (status === 404) {
    return "接口地址或模型不存在（请检查接口地址与模型名）";
  }
  if (status === 408 || status === 429) {
    return "请求频率或额度受限，请稍后重试";
  }
  if (status >= 500) {
    return "供应商服务暂不可用，请稍后重试";
  }
  return `请求被供应商拒绝（HTTP ${status}）`;
}

/** 从 OpenAI 兼容响应体取回信文本；形状不符返回 null */
function contentOf(bodyText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== "object" || parsed === null) return null;
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const message = (choices[0] as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) return null;
    const content = (message as { content?: unknown }).content;
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

/** 核心调用：装配 → 传输 → 归一（成功/失败都只回收敛后的形态） */
export async function callChatCompletions(
  input: ChatCompletionsInput,
): Promise<ChatCompletionsResult> {
  const url = chatCompletionsUrl(input.baseUrl);
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": `${USER_AGENT_PREFIX} (ref:${input.requestRef})`,
  };
  const body = JSON.stringify({
    model: input.model,
    messages: input.messages,
    stream: false,
    ...(input.maxTokens !== undefined && { max_tokens: input.maxTokens }),
  });
  const transport = input.transport ?? defaultProviderTransport;
  let response: GuardedResponse;
  try {
    response = await transport({
      url,
      method: "POST",
      headers,
      body,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    // 守卫/网络错误：超时单列，其余统一壳；绝不回显 err.message 之外的
    // 供应商细节（守卫消息本身已是中文短句）
    const result = failureOfTransportError(error);
    input.logger?.warn(
      {
        event: "ai_outbound_failed",
        code: result.code,
        message: result.message,
        ref: input.requestRef,
      },
      "AI 出站请求失败",
    );
    return result;
  }
  input.logger?.info(
    {
      event: "ai_outbound",
      url,
      method: "POST",
      status: response.status,
      // 授权头只留 scheme；正文（学生问题）不进日志
      authorization: redactHeaderValue(headers.authorization ?? ""),
      ref: input.requestRef,
    },
    "AI 出站请求",
  );
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      code: "AI_OUTBOUND_FAILED",
      message: failureMessageOf(response.status),
    };
  }
  const content = contentOf(response.bodyText);
  if (content === null) {
    return {
      ok: false,
      code: "AI_OUTBOUND_FAILED",
      message: "供应商响应格式无法解析",
    };
  }
  return { ok: true, content };
}

/** 传输异常归一（守卫错误码映射；未知异常不透传消息） */
function failureOfTransportError(error: unknown): {
  ok: false;
  code: "AI_OUTBOUND_FAILED" | "AI_OUTBOUND_TIMEOUT";
  message: string;
} {
  if (error instanceof OutboundTargetError) {
    if (error.code === "TIMEOUT") {
      return { ok: false, code: "AI_OUTBOUND_TIMEOUT", message: error.message };
    }
    return { ok: false, code: "AI_OUTBOUND_FAILED", message: error.message };
  }
  return {
    ok: false,
    code: "AI_OUTBOUND_FAILED",
    message: "出站请求失败，请稍后重试",
  };
}

/** 连接测试：固定探针 + 测试时限 + 小 max_tokens（一次真实调用） */
export async function testProviderConnection(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly transport?: ProviderTransport;
  readonly logger?: Logger;
}): Promise<ChatCompletionsResult> {
  return callChatCompletions({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    messages: [{ role: "user", content: CONNECTION_TEST_PROBE }],
    timeoutMs: AI_CONNECTION_TEST_TIMEOUT_MS,
    requestRef: "connection-test",
    maxTokens: 16,
    ...(input.transport !== undefined && { transport: input.transport }),
    ...(input.logger !== undefined && { logger: input.logger }),
  });
}

/** AI_OUTBOUND_TIMEOUT_MS 再导出一次：正式出站调用方（SAI-17）单源取用 */
export { AI_OUTBOUND_TIMEOUT_MS };
