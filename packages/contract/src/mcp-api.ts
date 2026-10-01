import { z } from "zod";

/**
 * MCP 与教师侧配套契约（T4.6 起为权威定义，依据 Phase4 清单 §2 D22/D24 与
 * 架构文档 §5.9 第三层）：
 * - GET  /api/teacher/api-token：查看当前 API Token（D22：可随时查看，不做
 *   「只显示一次」；从未生成时 token=null，前端提示可生成）；
 * - POST /api/teacher/api-token：生成 / 重置（同一动作：无则生成、有则覆盖列值，
 *   旧 token 立即失效；前端重置需二次确认并提示「已配置的客户端需更新」）；
 * - GET  /api/teacher/students/:id/reports：学生报告列表（D24，createdAt 倒序；
 *   他人学生 → 404 不暴露存在性）；
 * - DELETE /api/teacher/reports/:id：删除报告（他人报告 → 404；不做编辑，D24）。
 *
 * MCP 端点 /mcp 本身不走 HTTP 统一壳（SDK 协议格式原样，Phase4 清单 §3 已注明
 * 「MCP 无契约变化」）；save_report 工具的写入参数复用本文件的
 * reportCreateRequestSchema 做同一份校验（服务层 createReport 入口）。
 */

/** API Token 随机字节数（randomBytes(32) → base64url 43 字符；D22 格式定稿） */
export const API_TOKEN_BYTES = 32;

/** 报告标题长度上限（字符） */
export const REPORT_TITLE_MAX = 200;

/** 报告正文长度上限（字符；AI 学情报告远小于此值，防御异常输入） */
export const REPORT_MARKDOWN_MAX = 1_000_000;

// ---------- apiToken（D22） ----------

/** GET /api/teacher/api-token 响应 data */
export const teacherApiTokenDataSchema = z.object({
  /** 当前 token（base64url）；从未生成时为 null（设置页提示可生成） */
  token: z.string().min(1).nullable(),
});

/** POST /api/teacher/api-token 响应 data（生成与重置同一动作，恒返回新 token） */
export const teacherApiTokenResetDataSchema = z.object({
  token: z.string().min(1),
});

// ---------- reports（D24） ----------

/** 报告来源：mcp = AI 经 save_report 写入；manual = 教师手写（预留，本任务无入口） */
export const reportSourceSchema = z.enum(["mcp", "manual"]);

/** 报告写入参数（MCP save_report 工具与服务层 createReport 共用同一份校验） */
export const reportCreateRequestSchema = z.object({
  /** 学生（students.id；非本教师学生 → 404 STUDENT_NOT_FOUND，不暴露存在性） */
  studentId: z.uuid("studentId 必须是 UUID 格式"),
  title: z
    .string()
    .trim()
    .min(1, "title 不能为空")
    .max(REPORT_TITLE_MAX, `标题最长 ${REPORT_TITLE_MAX} 字`),
  markdown: z
    .string()
    .min(1, "markdown 不能为空")
    .max(REPORT_MARKDOWN_MAX, "报告正文过长"),
});

/** 报告摘要行（列表用；markdown 正文不进列表，画像页 T4.7 展示时按需再取） */
export const reportSummarySchema = z.object({
  id: z.uuid(),
  studentId: z.uuid(),
  title: z.string().min(1),
  source: reportSourceSchema,
  /** 创建时间：UTC ISO 字符串 */
  createdAt: z.string().min(1),
});

/** GET /api/teacher/students/:id/reports 响应 data（createdAt 倒序） */
export const reportListDataSchema = z.object({
  reports: z.array(reportSummarySchema),
});

/** save_report 成功回执（MCP 工具与 createReport 服务共用；教师 HTTP 端暂无 POST） */
export const reportCreateDataSchema = z.object({
  id: z.uuid(),
  studentId: z.uuid(),
  title: z.string().min(1),
  source: reportSourceSchema,
  createdAt: z.string().min(1),
});

/**
 * MCP 教师侧错误码：REPORT_NOT_FOUND（报告不存在或非本教师，404）；
 * STUDENT_NOT_FOUND 与 student 模块同义（404 不暴露存在性）。
 * MCP 鉴权 401 在协议层返回（无/错 token/教师已禁用同一文案，防探测，D22），
 * 不进统一壳错误码枚举。
 */
export const mcpErrorCodeSchema = z.enum(["REPORT_NOT_FOUND"]);

// ---------- 推断类型导出 ----------

export type TeacherApiTokenData = z.infer<typeof teacherApiTokenDataSchema>;
export type TeacherApiTokenResetData = z.infer<
  typeof teacherApiTokenResetDataSchema
>;
export type ReportSource = z.infer<typeof reportSourceSchema>;
export type ReportCreateRequest = z.infer<typeof reportCreateRequestSchema>;
export type ReportSummary = z.infer<typeof reportSummarySchema>;
export type ReportListData = z.infer<typeof reportListDataSchema>;
export type ReportCreateData = z.infer<typeof reportCreateDataSchema>;
