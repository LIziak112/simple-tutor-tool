import { z } from "zod";
import { lintIssueSchema } from "./content.ts";

/**
 * 内容导入 API 契约（T1.10 起为权威定义）：教师端导入预览与提交的请求体/响应 data、
 * 导入相关错误码。
 * 依据：docs/技术架构与实施方案.md §5.1（linter 输出、导入 dry-run 预览）、§5.2（数据模型，
 * 导入落库的七张内容表）、docs/开发任务清单.md T1.10、§0.3（响应壳/主键/时间约定）。
 *
 * 约定（与 auth.ts 一致）：
 * - 本文件只定义请求体与 data 部分；响应壳 { ok, data } / { ok, error, message } 由
 *   index.ts 统一描述，此处仅用局部 helper 具体化成功壳；
 * - 全部为教师端接口（requireTeacher），响应含答案/详解属正常（教师侧，无泄露约束）；
 * - preview 不写库；commit 有 error 级 issue 时返回 422 LINT_ERROR。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/**
 * POST /api/teacher/import/preview 请求体。
 * markdown 为文档原文（v1/v2 均可，服务端 detectVersion 自动识别）；filename 仅用于
 * imports 留档与前端展示，不参与解析。
 */
export const importPreviewRequestSchema = z.object({
  markdown: z.string().min(1, "markdown 不能为空"),
  filename: z.string().min(1, "filename 不能为空"),
});

/**
 * POST /api/teacher/import/commit 请求体。
 * courseId 可选：缺省导入系统默认课程（不存在则自动创建，服务端返回实际 courseId）。
 */
export const importCommitRequestSchema = importPreviewRequestSchema.extend({
  courseId: z.uuid("courseId 必须是 UUID 格式").optional(),
});

/** 预览摘要（commit 响应不含摘要，报告见 importCommitDataSchema） */
export const importSummarySchema = z.object({
  /** 练习单元数 */
  unitCount: z.number().int().min(0),
  /** 讲义篇数（H1 切分） */
  lectureCount: z.number().int().min(0),
  /** 题目总数 */
  questionCount: z.number().int().min(0),
  /** 题型 → 题数（键为 questionTypeSchema 取值；只含出现过的题型） */
  typeDistribution: z.record(z.string(), z.number().int().min(0)),
});

/** POST /api/teacher/import/preview 响应 data：识别版本 + 摘要 + 全部 lint issues（不写库） */
export const importPreviewDataSchema = z.object({
  /** detectVersion 识别结果；v1 文档服务端内部转 v2 处理，但版本号如实返回 */
  version: z.union([z.literal(1), z.literal(2)]),
  summary: importSummarySchema,
  /** lintDocument 的全部 issue（error + warning）；issue 行号对 v1 指向转换后的 v2 文本 */
  issues: z.array(lintIssueSchema),
});

/** 单元导入结果：id 来自 DSL；inserted/updated 互斥（按 unit.id 全局匹配） */
export const importUnitReportSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  inserted: z.boolean(),
  updated: z.boolean(),
});

/** 讲义导入结果：按 (courseId, title) 匹配替换 markdown；id 为导入时生成的 UUID */
export const importLectureReportSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  inserted: z.boolean(),
  updated: z.boolean(),
});

/** 题目导入统计：inserted = 新 id 插入（version=1）；updated = id 已存在更新（version+1） */
export const importQuestionsReportSchema = z.object({
  inserted: z.number().int().min(0),
  updated: z.number().int().min(0),
});

/** POST /api/teacher/import/commit 响应 data：导入统计报告 */
export const importCommitDataSchema = z.object({
  /** imports 留档行 id（crypto.randomUUID，§0.3） */
  importId: z.uuid(),
  /** 实际导入的课程 id（请求缺省时为系统默认课程，自动创建） */
  courseId: z.uuid(),
  units: z.array(importUnitReportSchema),
  lectures: z.array(importLectureReportSchema),
  questions: importQuestionsReportSchema,
});

/**
 * 内容导入相关错误码（UPPER_SNAKE_CODE 固定子集）：
 * - LINT_ERROR：commit 遇 error 级 issue，拒绝写入（422）；
 * - COURSE_NOT_FOUND：请求携带的 courseId 不存在（404）。
 */
export const contentErrorCodeSchema = z.enum([
  "LINT_ERROR",
  "COURSE_NOT_FOUND",
]);

/**
 * commit 的 LINT_ERROR 响应体：统一错误壳 + _issues 附加字段（error 级 issue 列表，
 * 供前端在编辑器对应行标红）。是 apiErrSchema 的超集（附加字段不破坏统一壳解析）。
 */
export const importLintErrorBodySchema = z.object({
  ok: z.literal(false),
  error: z.literal("LINT_ERROR"),
  message: z.string().min(1),
  /** error 级 issue（至少 1 条，否则不会返回该壳） */
  _issues: z.array(lintIssueSchema).min(1),
});

/** 携带预览数据的成功响应壳 */
export const importPreviewOkSchema = apiOkExtend(importPreviewDataSchema);

/** 携带导入报告的成功响应壳 */
export const importCommitOkSchema = apiOkExtend(importCommitDataSchema);

export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;
export type ImportCommitRequest = z.infer<typeof importCommitRequestSchema>;
export type ImportSummary = z.infer<typeof importSummarySchema>;
export type ImportPreviewData = z.infer<typeof importPreviewDataSchema>;
export type ImportUnitReport = z.infer<typeof importUnitReportSchema>;
export type ImportLectureReport = z.infer<typeof importLectureReportSchema>;
export type ImportQuestionsReport = z.infer<typeof importQuestionsReportSchema>;
export type ImportCommitData = z.infer<typeof importCommitDataSchema>;
export type ContentErrorCode = z.infer<typeof contentErrorCodeSchema>;
