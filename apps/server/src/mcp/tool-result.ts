import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpError } from "../lib/http-error";

/**
 * MCP 工具返回与错误结构（教师 server.ts / 学生 student-server.ts / 个人
 * personal-server.ts 三处共用的单源；原在 server.ts 内，模块 0 抽出成独立模块）。
 *
 * 返回统一用 SDK content 结构（text；JSON 数据序列化后作为文本——AI 阅读
 * JSON 与 Markdown 同样有效）；业务错误（HttpError）不抛裸异常给协议层，
 * 转结构化错误文本（isError + {error, message}），lint 错误清单原样透传。
 */

/** JSON 数据 → text content（2 空格缩进） */
export function jsonContent(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** 纯文本 / 已是 JSON 文本的原文 → text content */
export function textContent(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** 业务错误 → 结构化错误文本（不抛裸异常给协议层；lint 错误清单原样透传） */
export function errorContent(err: unknown): CallToolResult {
  if (err instanceof HttpError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: err.code, message: err.message, ...(err.extra ?? {}) },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { error: "INTERNAL", message: "服务器内部错误，请稍后重试" },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/** 包装工具回调：异常统一转结构化错误文本（args 原样透传，保住 SDK 的类型推断） */
export function guard<Args>(
  run: (args: Args) => CallToolResult | Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args): Promise<CallToolResult> => {
    try {
      return await run(args);
    } catch (err) {
      return errorContent(err);
    }
  };
}
