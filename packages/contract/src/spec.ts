import { z } from "zod";

/**
 * DSL 规范文件契约（T1.13 起为权威定义）：GET /api/public/spec/:file 的
 * 文件名枚举与响应 Content-Type。
 * 依据：docs/技术架构与实施方案.md §3（/spec/* 在公开区）、§5.1 末段"规范文档化"。
 *
 * 说明：这是静态产物直出接口（md/json 原文作为 body，不走 { ok, data } 统一壳），
 * 便于 AI 客户端 / MCP 原样拉取；未知文件名由服务端按统一错误壳返回 404。
 * 文件与 docs/dsl 的物理映射（rules.md → 规范.md 等）属服务端部署细节，不进契约。
 */

/** /api/public/spec/:file 提供的五个文件（docs/dsl 三份文档 + JSON Schema + 能力清单） */
export const specFileNames = [
  "rules.md",
  "example.md",
  "prompt.md",
  "schema.json",
  "capabilities.json",
] as const;

export type SpecFileName = (typeof specFileNames)[number];

/** 请求参数校验：file 路径参数只允许五个枚举值 */
export const specFileNameSchema = z.enum(specFileNames);

/** 每个文件的响应 Content-Type（md 统一 text/markdown，json 为 application/json） */
export const specFileContentTypes: Readonly<Record<SpecFileName, string>> = {
  "rules.md": "text/markdown; charset=utf-8",
  "example.md": "text/markdown; charset=utf-8",
  "prompt.md": "text/markdown; charset=utf-8",
  "schema.json": "application/json; charset=utf-8",
  "capabilities.json": "application/json; charset=utf-8",
};
