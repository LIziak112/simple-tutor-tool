import { z } from "zod";

/** 身份认证契约（T1.9 起为权威定义）：密码策略、setup/login 请求体、教师信息、auth 错误码 */
export * from "./auth.ts";

/** 内容契约（DSL v2）：题目、讲义、单元、解析结果、lint issue，T1.1 起为权威定义 */
export * from "./content.ts";

/** 内容导入 API 契约（T1.10 起为权威定义）：导入预览/提交请求体与响应、LINT_ERROR 错误壳 */
export * from "./content-api.ts";

/** 指令注册表（DSL v2 可扩展性核心，T1.2 起为权威定义）：defineDirective、按名/别名查询、首发指令 */
export * from "./directives.ts";

/**
 * API 响应壳（占位示例）。
 * 约定见 docs/开发任务清单.md §0.3：
 * - 成功：{ ok: true, data }
 * - 失败：{ ok: false, error: "UPPER_SNAKE_CODE", message: "中文说明" }
 * 正式内容契约在 T1.1 定义；此处仅用于打通包结构、Zod 依赖与测试链路，不要过度设计。
 */

/** 错误码：大写字母开头，只含大写字母/数字/下划线 */
export const errorCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "错误码必须是 UPPER_SNAKE_CODE 格式");

/** 成功响应壳 */
export const apiOkSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
});

/** 失败响应壳 */
export const apiErrSchema = z.object({
  ok: z.literal(false),
  error: errorCodeSchema,
  message: z.string().min(1),
});

/** 任意 API 响应（成功或失败的联合，按 ok 判别） */
export const apiResponseSchema = z.discriminatedUnion("ok", [
  apiOkSchema,
  apiErrSchema,
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ApiOk = z.infer<typeof apiOkSchema>;
export type ApiErr = z.infer<typeof apiErrSchema>;
export type ApiResponse = z.infer<typeof apiResponseSchema>;
