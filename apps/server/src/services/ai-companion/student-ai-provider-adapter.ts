import { AI_OUTBOUND_TIMEOUT_MS } from "@tutor/contract";
import type { Logger } from "pino";
import {
  executeChatCompletions,
  type ProviderContentPart,
  type ProviderMessage,
  type ProviderTransport,
  type ProviderUsage,
} from "./provider-client.ts";
import type { OutboundAssembly } from "./student-ai-context.ts";

/**
 * SAI-17 供应商适配层（B09；技术方案 §7 首发 API 协议、批次执行步骤 1/2）。
 *
 * 职责边界——本模块只做「服务端批准的上下文 → 统一出站请求 → 受控结果」：
 * - 输入是服务端装配产物（SAI-09 assembleOutboundMessages 的 OutboundAssembly）
 *   与服务端收集的材料 PNG 字节（SAI-11 collectAiTaskMaterialBytes）；
 *   **不接收客户端 messages 原样代理**——消息序列、system 段、注入防御句
 *   全部来自装配层，客户端无法指定角色结构或夹带额外语义；
 * - 统一请求格式：OpenAI 兼容 chat/completions、stream:false 首发（D4）；
 *   图像以 image_url data URL 部件附在首个 user 消息（上下文数据段）；
 * - 图像能力门禁：连接声明不支持识图且本次含图 → 出站前阻断（需求 §8
 *   「不偷偷丢图」），学生减选材料或换模型后重新发起，绝不静默降级仅文字；
 * - 回复/usage 与错误归一：成功透传回信与 usage；失败按 worker 可裁决的
 *   kind 分类（rate_limited/server_error 可退避重试、needs_reconfig 不重试、
 *   uncertain 状态不明、failed 明确失败），message 恒为 provider-client
 *   收敛后的中文短句——无供应商原文、响应头或堆栈。
 */

/** 图像能力口径（ai_connections.configJson.imageCapability 同源） */
export type ProviderImageCapability = "unknown" | "supported" | "unsupported";

/** 适配层调用输入（除装配产物与图片外均为服务端解析所得，无客户端自报） */
export interface ProviderDispatchInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly imageCapability: ProviderImageCapability;
  /** 服务端批准的单题上下文装配产物（system + 数据段 + 历史 + 诉求） */
  readonly assembly: OutboundAssembly;
  /** 服务端收集的材料 PNG 字节（顺序 = 材料行装载序） */
  readonly images: readonly Uint8Array[];
  /** 对账标识：任务 id（进 User-Agent，绝不进消息体） */
  readonly requestRef: string;
  /** 出站时限（缺省 AI_OUTBOUND_TIMEOUT_MS） */
  readonly timeoutMs?: number;
  readonly transport?: ProviderTransport;
  readonly logger?: Logger;
  /** Retry-After HTTP 日期换算基准（测试注入；缺省当前时间） */
  readonly now?: Date;
}

/** 适配层受控结果（失败只有固定 kind + 中文短句 + 可选退避指引） */
export type ProviderDispatchOutcome =
  | {
      readonly ok: true;
      readonly content: string;
      readonly usage?: ProviderUsage;
    }
  | {
      readonly ok: false;
      /** 可退避重试（明确被拒未计费）：429/临时 5xx */
      readonly kind: "rate_limited" | "server_error";
      readonly message: string;
      /** 供应商指引（ms；无指引为 null），等待上限由 worker 裁剪 */
      readonly retryAfterMs: number | null;
    }
  | {
      readonly ok: false;
      /** 需重配（不重试）：Key 无效/地址模型错/目标被拦/模型不收图 */
      readonly kind: "needs_reconfig";
      readonly message: string;
    }
  | {
      readonly ok: false;
      /** 状态不明（可能已收费，绝不自动重发）：超时/响应体中断 */
      readonly kind: "uncertain";
      readonly message: string;
    }
  | {
      readonly ok: false;
      /** 明确失败（不自动重试）：未送达/结构损坏 */
      readonly kind: "failed";
      readonly message: string;
    };

/** 模型不支持识图且本次含图时的固定阻断文案（出站前，零请求） */
const IMAGE_UNSUPPORTED_MESSAGE =
  "当前连接的模型不支持识图，而本次求助包含书写材料；请更换支持识图的模型，或减少材料后重新发起（不会在不告知的情况下改发仅文字）";

/** 超时的状态不明文案（不自动重发；显式重试前提示可能重复计费） */
const TIMEOUT_UNCERTAIN_MESSAGE =
  "出站请求超时，无法确认供应商是否已处理；已标记为发送结果待确认，请核对后再决定是否重试";

/** 响应体超限中断的状态不明文案（同上：可能已处理） */
const RESPONSE_ABORTED_UNCERTAIN_MESSAGE =
  "供应商响应超出大小上限被中止，无法确认回信内容；已标记为发送结果待确认，请核对后再决定是否重试";

/** 装配消息 → 出站消息：首个 user 消息（上下文数据段）追加图像部件 */
function withImages(
  assembly: OutboundAssembly,
  images: readonly Uint8Array[],
): ProviderMessage[] {
  if (images.length === 0) {
    return assembly.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }
  const imageParts: ProviderContentPart[] = images.map((bytes) => ({
    type: "image_url",
    image_url: {
      url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
    },
  }));
  let attached = false;
  return assembly.messages.map((message): ProviderMessage => {
    if (!attached && message.role === "user") {
      attached = true;
      return {
        role: message.role,
        content: [{ type: "text", text: message.content }, ...imageParts],
      };
    }
    return { role: message.role, content: message.content };
  });
}

/** 详细结果 → 适配层受控结果（message 全部来自 provider-client 收敛短句） */
function outcomeOfDetailed(
  detailed: Awaited<ReturnType<typeof executeChatCompletions>>,
): ProviderDispatchOutcome {
  if (detailed.ok) {
    return {
      ok: true,
      content: detailed.content,
      ...(detailed.usage !== undefined && { usage: detailed.usage }),
    };
  }
  switch (detailed.reason) {
    case "rate_limited":
    case "server_error":
      return {
        ok: false,
        kind: detailed.reason,
        message: detailed.message,
        retryAfterMs: detailed.retryAfterMs ?? null,
      };
    case "auth":
    case "not_found":
    case "bad_request":
    case "redirect":
    case "target_blocked":
      return { ok: false, kind: "needs_reconfig", message: detailed.message };
    case "timeout":
      return {
        ok: false,
        kind: "uncertain",
        message: TIMEOUT_UNCERTAIN_MESSAGE,
      };
    case "response_aborted":
      return {
        ok: false,
        kind: "uncertain",
        message: RESPONSE_ABORTED_UNCERTAIN_MESSAGE,
      };
    default:
      return { ok: false, kind: "failed", message: detailed.message };
  }
}

/**
 * 单次出站（无内部重试——退避节奏归 worker）：能力门禁 → 消息组装 →
 * executeChatCompletions → 受控结果。任何供应商异常都收敛为固定 kind 与
 * 中文短句，绝不透传原文/头/堆栈。
 */
export async function dispatchToProvider(
  input: ProviderDispatchInput,
): Promise<ProviderDispatchOutcome> {
  if (input.imageCapability === "unsupported" && input.images.length > 0) {
    return {
      ok: false,
      kind: "needs_reconfig",
      message: IMAGE_UNSUPPORTED_MESSAGE,
    };
  }
  const detailed = await executeChatCompletions({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    messages: withImages(input.assembly, input.images),
    timeoutMs: input.timeoutMs ?? AI_OUTBOUND_TIMEOUT_MS,
    requestRef: input.requestRef,
    ...(input.transport !== undefined && { transport: input.transport }),
    ...(input.logger !== undefined && { logger: input.logger }),
    ...(input.now !== undefined && { now: input.now }),
  });
  return outcomeOfDetailed(detailed);
}
