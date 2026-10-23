import { z } from "zod";

/** 管理端 API 契约（T2B.6 起为权威定义）：教师账号管理、注册开关、概览计数、错误码 */
export * from "./admin-api.ts";
/** 学情分析 API 契约（T4.1 起为权威定义，依据 Phase4 清单 §2 D1–D7）：总览/画像/题目三接口 */
export * from "./analytics-api.ts";
/** 题干标注契约（T6R.20 起为权威定义）：固定底图＋独立矢量标注（AnnotationDoc、
 *  底图装配载荷、CAS 上传协议、回看视图、限额常量与错误码；与 note/ink 链隔离） */
export * from "./annotation.ts";
/** 作答纯行为登记表（统一作答适配层 UA-01 起为权威定义，方案 §4.3/§10）：
 *  答案 kind 推导类型（AnswerOf/ReferenceOf）、三文本口径（display/teacher-queue/
 *  ai-context）、answerKindBehaviors 登记表与唯一调度边界 dispatchBehavior/
 *  dispatchIsAnswered、公开结构映射（选项/槽位）；无 React/DOM 依赖，server/web
 *  共用；与 formatQuestionAnswers（参考文本唯一入口）不互相导入 */
export * from "./answer-kinds/index.ts";
/** 作业契约（T2.2 起为权威定义）：教师布置作业 CRUD、学生作业列表与完成状态、错误码 */
export * from "./assignment.ts";
/** 作答生命周期契约（T2.6 起为权威定义）：attempt 创建/草稿/交卷/详情视图、错误码 */
export * from "./attempt.ts";
/** 身份认证契约（T1.9 起为权威定义）：密码策略、setup/login/register 请求体、教师信息、auth 错误码 */
export * from "./auth.ts";
/** 备份与恢复 API 契约（T4.5 起为权威定义，依据 Phase4 清单 §2 D20/D21）：快照列表、
 *  恢复（multipart zip + 登录密码）摘要、上传上限与保留份数、错误码 */
export * from "./backup-api.ts";
/** 指令能力三面与题型桥接表（T7.4 起为权威定义，方案 §4.3）：interaction/evidence/validation
 *  词表、directiveCapabilitySchema、questionCapabilityBindings（服务端 T7.5 校验器路由与
 *  T7.6 capabilities.json 的数据源；只描述既有行为，不生成新控件或判分算法） */
export * from "./capability.ts";
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
export * from "./ink-profile.ts";
/** 学习痕迹事件契约（T2.10 起为权威定义）：事件类型枚举（现 23 种）、批量上报请求/响应、上限常量 */
export * from "./learning-event.ts";
/** AI 学情数据包契约（T4.3 起为权威定义，依据 Phase4 清单 §2 D14–D19）：导出请求（范围×模块×目标×隐私）、
 *  LearningPack 模块化 schema（content/attempts/traces/summary）、preview 响应、prompt.md 模板单一来源 */
export * from "./learning-pack.ts";
/** 资源库 API 契约（T2A.2 起为权威定义）：资源库页面与单元管理的请求/响应、错误码 */
export * from "./library-api.ts";
/** MCP 教师侧配套契约（T4.6 起为权威定义，依据 Phase4 清单 §2 D22/D24）：apiToken
 *  查看/生成重置、reports 列表/删除、save_report 写入参数；/mcp 端点本身无契约变化 */
export * from "./mcp-api.ts";
/** 图片上传 API 契约（媒体管线第一单起为权威定义）：上传响应的内容寻址路径与字节数；
 *  请求为 multipart（无 JSON 请求 schema），MEDIA_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE 走通用 ApiErr */
export * from "./media-api.ts";
/** 题目草稿契约（T6R.2 起为权威定义，依据 Phase6 方案 §5/§6.2/§7）：NoteDoc v1、
 *  四类正交状态、上传协议（CAS+幂等回执）、笔记/版本/图片/证据元信息、限额常量与错误码 */
export * from "./note.ts";
/** 学生端做题反馈 M2 逐题提交与题级反馈契约（2026-10-22 计划 §10.1–§10.4）：
 *  新协议单题提交请求（strict、缺省拒绝）、提交回执与反馈读取共用的单题
 *  授权投影（released/not_submitted/pending_attempt/restricted 判别二态）、
 *  回执 data 与成功响应壳——无秘密态不携带答案/详解/判定 */
export * from "./practice-question-submit.ts";
/** 学生端做题方式与反馈节奏契约（M1a 起为权威定义，2026-10-22 计划 §6.1）：
 *  布局/反馈枚举、strict v1 本设备偏好、practiceWorkflow 裁决投影、题级公开
 *  进度白名单、教师反馈策略与节奏修改（CAS）请求——授权结论只能来自服务端 */
export * from "./practice-workflow.ts";
/** 运行时公开配置契约（T2.12 起为权威定义）：GET /api/public/config 的 pwaEnabled/publicUrl */
export * from "./public-config.ts";
/** 单题完整导出契约（T6R.13 起为权威定义）：review-pack 双角色 pack.json/预览/
 *  review.md 提示词单一来源；学生包 id 剥离与答案剔除为 schema 级不变量 */
export * from "./review-pack.ts";
/** 共享发布 API 契约（T2B.7 起为权威定义）：DATA_DIR/shared 目录的发布/列表/预览/导入/删除 */
export * from "./shared-api.ts";
/** DSL 规范文件契约（T1.13 起为权威定义）：/api/public/spec 文件名枚举与 Content-Type */
export * from "./spec.ts";
/** 学生账号契约（T2.1 起为权威定义）：学生 CRUD、两种登录、自助信息与改密码、错误码 */
export * from "./student.ts";
/** 学生端 AI 伴学：任务、材料与连接领域契约（SAI-03 起为权威定义，依据 B00 技术方案
 *  §3/§4.1/§5/§9）——限额常量单源、任务状态机与允许动作表、上下文快照（受控 AI 出口
 *  合法携带答案解析，教师私注不在 schema）、材料/消息/事实、四视图边界（内部执行载荷 /
 *  学生公开视图 / MCP 领取视图 / 分享视图）、连接器指纹视图与首次凭证、错误码 */
export * from "./student-ai.ts";
/** 学生端 AI 伴学：任务/材料/队列/连接 API 契约（SAI-03 起为权威定义，B00 §4.2 API 表）——
 *  status/tasks/dispatch/followup/cancel/resume/share/queue-summary/connections/test、
 *  MCP 工具载荷、公开票据读、批量复盘逐项结果、教师督学记录；学生请求全部 strict，
 *  分页游标为不透明字符串，明文凭证只在独立的首次凭证 schema 出现一次 */
export * from "./student-ai-api.ts";
export * from "./student-ai-display.ts";
/** 学生端 AI 伴学：教学配置与预设契约（SAI-02 起为权威定义，依据 B00 技术方案 §2/§4.1/§9）——
 *  三模式与继承、有效裁决输出、教师三模板与默认值、学生/作业覆盖、快捷按钮与附件偏好、
 *  限额常量与错误码；裁决是服务端输出，学生请求携带越权字段一律 strict 拒绝 */
export * from "./student-ai-policy.ts";
/** 学生端课程契约（T2A.5 起为权威定义）：我的课程、课程可见目录（D5）、D22 错误码 */
export * from "./student-course-api.ts";
/** 学生端题目笔记本契约（T6R.15 起为权威定义，方案 §5.2/D7）：跨 attempt 聚合的
 *  同题历次轮次（仅已交卷；零答案零解析零题干正文，题目侧只有版本号数字） */
export * from "./student-notebook-api.ts";
/** 学生端记录契约（T3.5 起为权威定义，依据 Phase3 清单 D9/D10/D11）：我的记录索引与错题本 */
export * from "./student-records-api.ts";
/** 教师端作答数据契约（T3.1 起为权威定义，依据 Phase3 清单 D5–D8）：作答列表/详情查询与数据、错误码 */
export * from "./teacher-attempt-api.ts";
/** 教学包声明契约（T7.8 起为权威定义，方案 §4.6）：frontmatter 可选 teachingPack 命名空间——
 *  formatVersion/name/version 与 directives/validators 引用数组的依赖声明（非能力定义） */
export * from "./teaching-pack.ts";

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
