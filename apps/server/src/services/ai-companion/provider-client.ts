import { AI_CONNECTION_TEST_TIMEOUT_MS } from "@tutor/contract";
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
 *
 * SAI-17 扩展（页内 AI 异步执行）：executeChatCompletions 输出内部详细结果
 * （usage 归一、失败 reason 分类、Retry-After 指引）供 worker/adapter 裁决；
 * callChatCompletions 保持 SAI-16 学生可读壳语义原样（连接测试等既有调用
 * 不变）。消息内容支持 OpenAI 多模态 content parts（图像 data URL）。
 */

/** 出站消息形态（system/user/assistant；装配层负责内容边界） */
export interface ProviderMessage {
  readonly role: "system" | "user" | "assistant";
  /** 纯文本或 OpenAI 多模态 content parts（SAI-17 图像部件；文本消息保持字符串） */
  readonly content: string | readonly ProviderContentPart[];
}

/** OpenAI 兼容多模态内容部件（图像用 data URL 携带服务端收集的 PNG） */
export type ProviderContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

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
  /** Retry-After 为 HTTP 日期形态时的换算基准（缺省当前时间；测试注入） */
  readonly now?: Date;
}

/** 调用结果：失败只带错误码与中文短句（无供应商原文/头/堆栈） */
export type ChatCompletionsResult =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly code: "AI_OUTBOUND_FAILED" | "AI_OUTBOUND_TIMEOUT";
      readonly message: string;
    };

/** usage 归一（OpenAI 兼容 usage 字段的驼峰形态；供应商缺省则省略） */
export interface ProviderUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

/** 失败分类（worker 重试/需重配/状态不明裁决的输入；不面向学生） */
export type ProviderFailureReason =
  | "rate_limited" // 408/429：明确被拒，未计费，可按时退避重试
  | "auth" // 401/403：Key 无效或无权限，需重配，不重试
  | "not_found" // 404：地址或模型不存在，需重配
  | "bad_request" // 其余 4xx：请求被拒（含模型不收图），需重配/调整
  | "redirect" // 3xx：重定向不跟随，需检查地址
  | "server_error" // 5xx：临时故障，可按时退避重试
  | "other_status" // 其余未知状态码
  | "bad_response" // 200 但结构损坏：供应商已处理，不可自动重试
  | "response_aborted" // 响应体超限中断：可能已处理，状态不明
  | "network" // 未送达（连接被拒等）：明确失败
  | "timeout" // 超时：可能已处理，状态不明
  | "target_blocked"; // 连接级 SSRF 裁决拒绝：目标不允许，需重配

/** 内部详细结果（SAI-17 worker/adapter 消费；学生可读壳仍走 ChatCompletionsResult） */
export type DetailedChatCompletionsResult =
  | { readonly ok: true; readonly content: string; readonly usage?: ProviderUsage }
  | {
      readonly ok: false;
      readonly code: "AI_OUTBOUND_FAILED" | "AI_OUTBOUND_TIMEOUT";
      readonly message: string;
      readonly reason: ProviderFailureReason;
      /** Retry-After 指引（ms；解析失败/未提供则缺省）。解析封顶 24h，
       *  等待上限由 worker 按并发预算裁剪——供应商指引不导致失控长阻塞 */
      readonly retryAfterMs?: number;
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

/** HTTP 状态 → 失败分类（与 failureMessageOf 分支同源对齐） */
function reasonOfStatus(status: number): ProviderFailureReason {
  if (status >= 300 && status < 400) return "redirect";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 408 || status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "bad_request";
  return "other_status";
}

/** Retry-After 解析封顶（24h）：恶意超大值不产生失控等待，等待上限另由 worker 裁剪 */
const RETRY_AFTER_PARSE_MAX_MS = 24 * 60 * 60 * 1000;

/** Retry-After 头解析：整数秒或 HTTP 日期（相对 now）；无效/缺失返回 undefined */
function retryAfterMsOf(
  headers: Record<string, string>,
  now: Date,
): number | undefined {
  const raw = headers["retry-after"];
  if (raw === undefined || raw === "") return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (/^\d+$/.test(raw.trim()) && Number.isFinite(seconds)) {
    return Math.min(seconds * 1000, RETRY_AFTER_PARSE_MAX_MS);
  }
  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    return Math.max(0, Math.min(at - now.getTime(), RETRY_AFTER_PARSE_MAX_MS));
  }
  return undefined;
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

/** usage 字段归一（prompt_tokens 等数值形态；任一存在才返回对象） */
function usageOf(bodyText: string): ProviderUsage | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const usage = (parsed as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null) return undefined;
    const pick = (key: string): number | undefined => {
      const value = (usage as Record<string, unknown>)[key];
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    };
    const promptTokens = pick("prompt_tokens");
    const completionTokens = pick("completion_tokens");
    const totalTokens = pick("total_tokens");
    const normalized: ProviderUsage = {
      ...(promptTokens !== undefined && { promptTokens }),
      ...(completionTokens !== undefined && { completionTokens }),
      ...(totalTokens !== undefined && { totalTokens }),
    };
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/** 传输异常归一（守卫错误码映射；未知异常不透传消息） */
function failureOfTransportError(error: unknown): {
  ok: false;
  code: "AI_OUTBOUND_FAILED" | "AI_OUTBOUND_TIMEOUT";
  message: string;
  reason: ProviderFailureReason;
} {
  if (error instanceof OutboundTargetError) {
    if (error.code === "TIMEOUT") {
      return {
        ok: false,
        code: "AI_OUTBOUND_TIMEOUT",
        message: error.message,
        reason: "timeout",
      };
    }
    const reason: ProviderFailureReason =
      error.code === "BODY_TOO_LARGE"
        ? "response_aborted"
        : error.code === "TARGET_INVALID" || error.code === "TARGET_BLOCKED"
          ? "target_blocked"
          : "network";
    return { ok: false, code: "AI_OUTBOUND_FAILED", message: error.message, reason };
  }
  return {
    ok: false,
    code: "AI_OUTBOUND_FAILED",
    message: "出站请求失败，请稍后重试",
    reason: "network",
  };
}

/**
 * 核心调用（SAI-17 详细形态）：装配 → 传输 → 归一。成功附 usage；失败附
 * reason 分类与 Retry-After 指引，供 worker 裁决退避/需重配/状态不明。
 * 请求装配、脱敏日志与学生可读错误句与 callChatCompletions 单源共用。
 */
export async function executeChatCompletions(
  input: ChatCompletionsInput,
): Promise<DetailedChatCompletionsResult> {
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
    const retryAfterMs = retryAfterMsOf(
      response.headers,
      input.now ?? new Date(),
    );
    return {
      ok: false,
      code: "AI_OUTBOUND_FAILED",
      message: failureMessageOf(response.status),
      reason: reasonOfStatus(response.status),
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    };
  }
  const content = contentOf(response.bodyText);
  if (content === null) {
    return {
      ok: false,
      code: "AI_OUTBOUND_FAILED",
      message: "供应商响应格式无法解析",
      reason: "bad_response",
    };
  }
  const usage = usageOf(response.bodyText);
  return { ok: true, content, ...(usage !== undefined && { usage }) };
}

/**
 * 学生可读壳（SAI-16 既有语义原样）：详细结果收敛为既有的
 * ChatCompletionsResult 形态——连接测试等既有调用方行为不变。
 */
export async function callChatCompletions(
  input: ChatCompletionsInput,
): Promise<ChatCompletionsResult> {
  const detailed = await executeChatCompletions(input);
  if (detailed.ok) {
    return { ok: true, content: detailed.content };
  }
  return { ok: false, code: detailed.code, message: detailed.message };
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
