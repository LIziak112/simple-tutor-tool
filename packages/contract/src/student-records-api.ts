import { z } from "zod";
import { attemptSourceSchema, attemptStatusSchema } from "./attempt.ts";
import { questionAnswersSchema, questionTypeSchema } from "./content.ts";
import { teacherAttemptSourceSchema } from "./teacher-attempt-api.ts";

/**
 * 学生端「我的记录」与错题本契约（T3.5 起为权威定义，依据 Phase3 清单 §2
 * D9/D10/D11）：
 * - GET /api/student/records：本人全部作答的时间倒序索引（作业 + 课程练习混排，
 *   每条标来源）+ 筛选 + 分页（D10）；
 * - GET /api/student/wrong-questions：按 (studentId, questionId) 跨全部来源聚合
 *   的错题本（D11）；
 * - GET /api/student/attempts/:id 的结果视图扩展（D9：逐题 teacherMark /
 *   teacherComment / finalCorrect、汇总 scoreFinal / pendingCount）在 attempt.ts
 *   （attemptResultQuestionSchema / attemptScoreSummarySchema），不在本文件。
 *
 * 约定（与 student-course-api.ts / attempt.ts 一致）：
 * - 本文件只定义查询参数与 data 部分；响应壳 { ok, data } 由 index.ts 统一描述，
 *   此处仅用局部 helper 具体化成功壳（避免循环依赖）；
 * - 时间一律 UTC ISO 字符串（带 Z 后缀；from/to 与列表排序同一「最近活动时间」
 *   轴：submittedAt ?? startedAt，D6/D10 同口径）；
 * - 来源上下文复用教师端的 teacherAttemptSourceSchema（同一概念同一份定义，
 *   AGENTS 第 1 条）：assignment=assignmentTitle（+可选 courseName）、
 *   course=unitTitle + courseName + attemptNo（前端拼「单元标题 · 第 n 次」）；
 * - 错误码：无本模块专属错误码（401 由会话守卫、400 由查询校验统一产生，
 *   两个接口都只读本人数据，不存在 403/404 路径）。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ---------- 我的记录（GET /api/student/records，D10） ----------

/** 分页 limit：默认 50，最小 1，最大 200（D6 同口径） */
export const STUDENT_RECORDS_PAGE_MAX = 200;

/**
 * GET /api/student/records 查询参数（全部可选，可任意组合）：
 * - sourceType / courseId / assignmentId：按来源类型、课程（assignment 来源取
 *   作业所属课程，course 来源即练习课程）、作业过滤；
 * - status：作答状态（draft=进行中；失权草稿不出现在任何筛选结果中）；
 * - from / to：时间范围（UTC ISO，带 Z 后缀）——按「最近活动时间」
 *   （submittedAt ?? startedAt）过滤，与排序同一时间轴；
 * - limit / offset：分页（limit 默认 50、1–200；offset 默认 0）。
 * 查询参数为字符串，数值字段用 coerce 解析（"50" → 50）。
 */
export const studentRecordsQuerySchema = z.object({
  sourceType: attemptSourceSchema.optional(),
  courseId: z.uuid("courseId 必须是 UUID 格式").optional(),
  assignmentId: z.uuid("assignmentId 必须是 UUID 格式").optional(),
  status: attemptStatusSchema.optional(),
  from: z.iso.datetime({ offset: false }).optional(),
  to: z.iso.datetime({ offset: false }).optional(),
  limit: z.coerce
    .number()
    .int("limit 必须是整数")
    .min(1, "limit 最小为 1")
    .max(STUDENT_RECORDS_PAGE_MAX, `limit 最大为 ${STUDENT_RECORDS_PAGE_MAX}`)
    .default(50),
  offset: z.coerce
    .number()
    .int("offset 必须是整数")
    .min(0, "offset 最小为 0")
    .default(0),
});

/**
 * 记录索引行（本人每一次作答一条；按最近活动时间倒序）：
 * - 得分 score：scoreFinal ?? scoreAuto（D2 展示口径）；draft 或无可判分为 null；
 * - after_due 未公布（answersReleased=false）：score 与 pendingCount 置 null
 *   （前端显示「待公布」，D10）；draft 行恒 answersReleased=true（无结果可公布，
 *   显示「进行中」）；
 * - pendingCount：D4 共享谓词（已交卷 attempt 中 finalCorrect IS NULL 的题数；
 *   draft 恒 0）；
 * - 已交卷记录恒保留（含已移出课程/作业软删后的历史，D7/§5.2）；已失权的
 *   进行中草稿不出现在索引中（可见性口径见服务端 student-records）。
 */
export const studentRecordRowSchema = teacherAttemptSourceSchema.extend({
  /** attempts.id（点击进入 /s/attempts/:attemptId） */
  attemptId: z.uuid(),
  status: attemptStatusSchema,
  /** 得分（0–100 整数百分比；scoreFinal ?? scoreAuto；draft/无可判分/未公布为 null） */
  score: z.number().int().min(0).max(100).nullable(),
  /** 待批题数（D4 口径；draft 恒 0；after_due 未公布置 null） */
  pendingCount: z.number().int().min(0).nullable(),
  /** 该条结果是否已公布（T2A.8；false = after_due 未到截止，score/pendingCount 已置 null） */
  answersReleased: z.boolean(),
  /** 开始作答时间：UTC ISO */
  startedAt: z.string().min(1),
  /** 交卷时间：UTC ISO；未交为 null（进行中条目「继续作答」） */
  submittedAt: z.string().nullable(),
});

/** GET /api/student/records 响应 data（按最近活动时间倒序；total 为筛选后总条数） */
export const studentRecordsDataSchema = z.object({
  records: z.array(studentRecordRowSchema),
  /** 筛选后的总条数（分页前；失权草稿不计入；offset 越界时 records 为空但 total 照常） */
  total: z.number().int().min(0),
});

// ---------- 错题本（GET /api/student/wrong-questions，D11） ----------

/**
 * GET /api/student/wrong-questions 查询参数：
 * - knowledge：考点筛选，**精确匹配**条目展示的考点名（考点来自最近一次判定
 *   作答的题目快照 knowledge，与展示同源；不匹配的题不返回）；
 * - includeResolved：true 额外列出「曾错、最近一次已做对」的题（默认只显示
 *   最近一次判定仍为错的题）。
 */
export const wrongQuestionsQuerySchema = z.object({
  knowledge: z.string().trim().min(1, "knowledge 不能为空").optional(),
  includeResolved: z.stringbool().optional(),
});

/**
 * 错题本条目（聚合键 = (学生, questionId)，跨作业 + 课程练习全部来源）：
 * - 入本条件：任一次**已判定**作答（已交卷且 finalCorrect 非 null；待批不参与）
 *   判错；after_due 未公布作业的作答整体不参与聚合（否则题目出现在错题本就
 *   泄露对错）；
 * - 题目内容（题干/题型/难度/考点/参考答案/详解）取**最近一次判定作答**的
 *   questionSnapshotJson 快照（含 [[答案]] 标记原文——已交卷内容允许下发，
 *   与结果视图同一口径）；快照坏数据的题按缺失计（跳过并留痕）；
 * - answerText：本人最近答案的人类可读序列化（与教师端待批卡片/CSV 同一
 *   serializeStudentAnswer 口径；未作为 null）；
 * - firstCorrect：首次（submittedAt 最早的已判定作答）是否做对；
 * - resolved：最近一次判定是否已做对（true = 曾错已攻克；默认列表不含、
 *   includeResolved=true 才下发）；
 * - 来源上下文与 firstAt/lastAt 均取**最近一次**判定作答所属 attempt。
 */
export const wrongQuestionCardSchema = teacherAttemptSourceSchema.extend({
  /** 题目 id（来自 DSL；聚合键的学生侧另一维） */
  questionId: z.string().min(1),
  /** 题型（快照） */
  type: questionTypeSchema,
  /** 难度 1–5（快照） */
  difficulty: z.number().int().min(1).max(5),
  /** 考点名列表（快照；knowledge 筛选与其同源精确匹配） */
  knowledge: z.array(z.string().min(1)),
  /** 题干 Markdown（快照原文，含 [[答案]] 标记——已交卷允许下发） */
  stemMd: z.string(),
  /** 选项纯文本（仅 choice/multi 快照携带） */
  options: z.array(z.string()).optional(),
  /** 参考答案（快照 QuestionAnswers；题目无标准答案为 null） */
  answers: questionAnswersSchema.nullable(),
  /** 详解（快照；未提供为 null） */
  solutionMd: z.string().nullable(),
  /** 本人最近答案（人类可读序列化；未作为 null） */
  answerText: z.string().nullable(),
  /** 首次已判定作答是否做对（最早一次） */
  firstCorrect: z.boolean(),
  /** 最近一次判定是否已做对（true = 曾错已攻克；默认列表不含该类条目） */
  resolved: z.boolean(),
  /** 首次判定时间（首次已判定作答的 submittedAt）：UTC ISO */
  firstAt: z.string().min(1),
  /** 最近判定时间（最近已判定作答的 submittedAt）：UTC ISO */
  lastAt: z.string().min(1),
});

/**
 * GET /api/student/wrong-questions 响应 data：按最近判定时间倒序
 * （lastAt 降序，questionId 升序兜底稳定）。无分页（单学生错题规模有限，
 * 与待批队列同口径）。
 */
export const wrongQuestionsDataSchema = z.object({
  questions: z.array(wrongQuestionCardSchema),
});

// ---------- 具体化的成功壳 ----------

/** 携带记录索引的成功响应壳 */
export const studentRecordsOkSchema = apiOkExtend(studentRecordsDataSchema);
/** 携带错题本的成功响应壳 */
export const wrongQuestionsOkSchema = apiOkExtend(wrongQuestionsDataSchema);

// ---------- 推断类型导出 ----------

export type StudentRecordsQuery = z.infer<typeof studentRecordsQuerySchema>;
export type StudentRecordRow = z.infer<typeof studentRecordRowSchema>;
export type StudentRecordsData = z.infer<typeof studentRecordsDataSchema>;
export type WrongQuestionsQuery = z.infer<typeof wrongQuestionsQuerySchema>;
export type WrongQuestionCard = z.infer<typeof wrongQuestionCardSchema>;
export type WrongQuestionsData = z.infer<typeof wrongQuestionsDataSchema>;
