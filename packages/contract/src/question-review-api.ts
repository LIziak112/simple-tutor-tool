import { z } from "zod";
import { studentFlagSchema } from "./attempt.ts";
import { questionTypeSchema } from "./content.ts";

/**
 * 学生主页「错题与存疑」聚合端点契约（T-PR4 Web-2②，教师端迭代方案 §3；
 * 2026-10-27 起为权威定义）：GET /api/teacher/students/:id/question-review。
 *
 * - 口径与 MCP-A `query_student_responses` 共用同一查询构造器（服务端
 *   apps/server/src/mcp/teacher-queries.ts 的共享谓词 teacherVisibleResponsesWhere、
 *   EXISTS 片段与游标/截断 helper）：排作废卷、draft 卷只纳入单题已提交的行、
 *   快照缺失幽灵行排除；
 * - 一行 = (questionId, 最新代表作答)：kind 口径下的可见行按（attempt 最近活动
 *   时间, responses.id）取最新一行作代表；redoCount = 该题该 kind 口径下可见
 *   行数 − 1；lastAt = 代表行所属 attempt 的最近活动时间（submittedAt ??
 *   startedAt，与作答列表排序同一时间轴）；
 * - kind 三档（先行级筛选、再按题聚合；Web 端固定筛选形状，MCP 端自由组合）：
 *   - wrong：判错且「答了或有人工判定」（#6980-3 错题口径：未做判错不算错题；
 *     answered 非真但 teacherMark / selfCorrect 显式判错的行仍算）；
 *   - unsure：studentFlag = 'unsure'（学生做题时自标「不会」）；
 *   - corrected：该行存在 correction 阶段订正笔记（与 MCP-A hasCorrection
 *     筛选同一 EXISTS 口径）；
 * - 教师域接口不做泄露投影，但行面只给判定与计数：题干为快照摘要（120 字
 *   截断），**不含参考答案 / 详解 / 选项 / 学生答案**——看全文走作答详情；
 * - 坏快照行按缺失计：题干取不出的行整行跳过（与作答详情「历史题目缺失跳过」
 *   同口径）。
 *
 * 约定（与 teacher-attempt-api.ts 一致）：本文件只定义查询参数与 data 部分，
 * 成功壳由局部 helper 具体化（避免循环依赖）；时间一律 UTC ISO 字符串
 * （带 Z 后缀）；from / to 按 responses.submittedAt（单题提交时刻，与 MCP-A
 * 同轴）过滤；分页为 offset 型不透明 cursor（同 MCP-A decodeCursorOffset）。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/** question-review 单页行数上限（与教师作答列表同上限） */
export const QUESTION_REVIEW_PAGE_MAX = 200;

/** 「错题与存疑」三档 kind（行级筛选口径见文件头注释） */
export const questionReviewKindSchema = z.enum([
  "wrong",
  "unsure",
  "corrected",
]);

/**
 * GET /api/teacher/students/:id/question-review 查询参数：
 * - kind：三档之一，缺省 wrong；
 * - courseId / from / to：可选筛选（course 按 attempt.courseId；时间按单题
 *   提交时刻，UTC ISO）；
 * - limit / cursor：分页（limit 默认 50、1–200；cursor 为上一页返回的
 *   nextCursor，offset 不透明编码）。
 */
export const questionReviewQuerySchema = z.object({
  kind: questionReviewKindSchema.default("wrong"),
  courseId: z.uuid("courseId 必须是 UUID 格式").optional(),
  from: z.iso.datetime({ offset: false }).optional(),
  to: z.iso.datetime({ offset: false }).optional(),
  limit: z.coerce
    .number()
    .int("limit 必须是整数")
    .min(1, "limit 最小为 1")
    .max(QUESTION_REVIEW_PAGE_MAX, `limit 最大为 ${QUESTION_REVIEW_PAGE_MAX}`)
    .default(50),
  cursor: z.string().optional(),
});

/** 「错题与存疑」聚合行：一行 = (questionId, 该 kind 口径下最新代表作答) */
export const questionReviewRowSchema = z.object({
  /** questions.id（来自 DSL） */
  questionId: z.string().min(1),
  /** 代表行所属 attempts.id（整行点击跳作答详情用） */
  attemptId: z.uuid(),
  /** 题型（建卷冻结快照值） */
  type: questionTypeSchema,
  /** 难度 1–5（快照值） */
  difficulty: z.number().int().min(1).max(5),
  /** 考点（快照冻结值；快照缺失/坏数据为空数组，不炸聚合） */
  knowledge: z.array(z.string().min(1)),
  /** 题干快照摘要（120 字截断、不追加省略号；不含答案解析） */
  stemMd: z.string(),
  /** 代表行最终判定（unsure / corrected 档的待批行为 null） */
  finalCorrect: z.boolean().nullable(),
  /** 学生自标「不会」（unsure / null） */
  studentFlag: studentFlagSchema.nullable(),
  /** 代表行是否存在 correction 订正笔记 */
  hasCorrection: z.boolean(),
  /** 代表行是否创建过 AI 任务 */
  hasAiHelp: z.boolean(),
  /** 该题该 kind 口径下可见作答行数 − 1（0 = 只做过一次） */
  redoCount: z.number().int().min(0),
  /** 代表行所属 attempt 最近活动时间（submittedAt ?? startedAt，UTC ISO） */
  lastAt: z.string().min(1),
});

/** GET /api/teacher/students/:id/question-review 响应 data */
export const questionReviewDataSchema = z.object({
  /** 聚合后的题目总数（分页前） */
  total: z.number().int().min(0),
  /** 下一页游标；没有更多为 null */
  nextCursor: z.string().nullable(),
  /** 聚合行（按 lastAt 倒序，同刻按 questionId 稳定） */
  questions: z.array(questionReviewRowSchema),
});

// ---------- 具体化的成功壳 ----------

/** 携带「错题与存疑」聚合结果的成功响应壳 */
export const questionReviewOkSchema = apiOkExtend(questionReviewDataSchema);

// ---------- 推断类型导出 ----------

export type QuestionReviewKind = z.infer<typeof questionReviewKindSchema>;
export type QuestionReviewQuery = z.infer<typeof questionReviewQuerySchema>;
export type QuestionReviewRow = z.infer<typeof questionReviewRowSchema>;
export type QuestionReviewData = z.infer<typeof questionReviewDataSchema>;
