import { z } from "zod";

/** 管理端 API 契约（T2B.6 起为权威定义）：教师账号管理、注册开关、概览计数、错误码 */
export * from "./admin-api.ts";
/** 作业契约（T2.2 起为权威定义）：教师布置作业 CRUD、学生作业列表与完成状态、错误码 */
export * from "./assignment.ts";
/** 作答生命周期契约（T2.6 起为权威定义）：attempt 创建/草稿/交卷/详情视图、错误码 */
export * from "./attempt.ts";
/** 身份认证契约（T1.9 起为权威定义）：密码策略、setup/login/register 请求体、教师信息、auth 错误码 */
export * from "./auth.ts";
/** 内容契约（DSL v2）：题目、讲义、单元、解析结果、lint issue，T1.1 起为权威定义 */
export * from "./content.ts";
/** 内容导入 API 契约（T1.10 起为权威定义）：导入预览/提交请求体与响应、LINT_ERROR 错误壳 */
export * from "./content-api.ts";
/** 课程 API 契约（T2A.4 起为权威定义）：课程编辑页（目录编排/可见性/成员）与学生可见预览 */
export * from "./course-api.ts";
/** 指令注册表（DSL v2 可扩展性核心，T1.2 起为权威定义）：defineDirective、按名/别名查询、首发指令 */
export * from "./directives.ts";
/** 判分输入契约（T2.5 起为权威定义）：学生答案按题型判别联合，与 content.ts 的 QuestionAnswers 对应 */
export * from "./grading.ts";
/** 手写笔迹契约（T2.8 起为权威定义）：InkDoc 矢量文档 + 上传/取回/元数据响应、限额与错误码 */
export * from "./ink.ts";
/** 学习痕迹事件契约（T2.10 起为权威定义）：11 种事件类型、批量上报请求/响应、上限常量 */
export * from "./learning-event.ts";
/** 资源库 API 契约（T2A.2 起为权威定义）：资源库页面与单元管理的请求/响应、错误码 */
export * from "./library-api.ts";
/** 运行时公开配置契约（T2.12 起为权威定义）：GET /api/public/config 的 pwaEnabled/publicUrl */
export * from "./public-config.ts";
/** 共享发布 API 契约（T2B.7 起为权威定义）：DATA_DIR/shared 目录的发布/列表/预览/导入/删除 */
export * from "./shared-api.ts";
/** DSL 规范文件契约（T1.13 起为权威定义）：/api/public/spec 文件名枚举与 Content-Type */
export * from "./spec.ts";
/** 学生账号契约（T2.1 起为权威定义）：学生 CRUD、两种登录、自助信息与改密码、错误码 */
export * from "./student.ts";
/** 学生端课程契约（T2A.5 起为权威定义）：我的课程、课程可见目录（D5）、D22 错误码 */
export * from "./student-course-api.ts";
/** 教师端作答数据契约（T3.1 起为权威定义，依据 Phase3 清单 D5–D8）：作答列表/详情查询与数据、错误码 */
export * from "./teacher-attempt-api.ts";

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
