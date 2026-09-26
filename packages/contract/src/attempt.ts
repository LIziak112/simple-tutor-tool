import { z } from "zod";
import { assignmentDueAtSchema } from "./assignment.ts";
import { questionAnswersSchema, questionPublicSchema } from "./content.ts";
import { studentAnswerSchema } from "./grading.ts";

/**
 * 作答生命周期契约（T2.6 起为权威定义）：attempt 的创建（幂等）、草稿保存、
 * 交卷与结果视图、详情（未交=草稿视图 / 已交=结果视图）。
 * 依据：docs/技术架构与实施方案.md §5.2（attempts / responses 表）、§5.3（练习：
 * 学生端只拿到公开题目；交卷后接口返回判分结果 + 答案 + 详解）、§5.6（判分：
 * 服务端交卷时执行）、docs/开发任务清单.md T2.6、§0.3（响应壳/主键/时间约定）。
 *
 * 安全口径（AGENTS.md 第 3 条——学生端接口永远不返回「未交卷题目」的答案/详解/提示）：
 * - 草稿视图（attemptDraftData）：题目一律是 QuestionPublic（与 T2.4 试卷同形态），
 *   本人草稿答案收在 drafts 键下（键名刻意避开 assertNoLeak 默认禁用的 answers——
 *   那个键名保留给交卷后的「参考答案」语义）；
 * - 结果视图（attemptResultData）：题目来自作答时的快照（questionSnapshotJson），
 *   允许携带参考答案（answers）、详解（solutionMd）与含答案标记的原始题干——
 *   但仍剥离提示内容（只给 hintCount，提示按需下发是 T2.11），泄露测试用
 *   assertNoLeak({ allow: ["answers", "answer", "solutionMd"] }) 放行后断言无 hints。
 *
 * 学生答案复用 grading.ts 的 StudentAnswer（T2.5），不在本文件重定义。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/**
 * attempt 状态（§5.2 attempts.status）：
 * - draft：进行中（草稿，可保存答案、可交卷）；
 * - submitted：已交卷（自动判分已写入，等待教师批改手写题）；
 * - graded：已批改（T3.2 教师批注后置位）。
 * 学生作业列表的四态（AssignmentStatus）由 computeAssignmentStatus 从本状态推导。
 */
export const attemptStatusSchema = z.enum(["draft", "submitted", "graded"]);

/**
 * attempt 摘要（创建/取回的返回，也内嵌在详情视图里）。
 * 一个作业一人至多一份进行中（draft）attempt；交卷后再次 POST /attempt
 * 返回已交卷的那份（前端据此直接进结果视图，不另开新卷）。
 */
export const attemptSummarySchema = z.object({
  /** attempts.id（crypto.randomUUID） */
  id: z.uuid(),
  /** 所属作业（assignments.id） */
  assignmentId: z.uuid(),
  /** 目标练习单元（units.id，作答期间的题目来源） */
  unitId: z.string().min(1),
  status: attemptStatusSchema,
  /** 开始作答时间：UTC ISO */
  startedAt: z.string().min(1),
  /** 交卷时间：UTC ISO；未交为 null */
  submittedAt: z.string().nullable(),
  /**
   * 自动判分得分（0–100 整数百分比；口径=答对数/可自动判分数）。
   * 无可自动判分的题（全部待批）或未交卷时为 null；T3.2 批改后以 scoreFinal 为准。
   */
  scoreAuto: z.number().int().min(0).max(100).nullable(),
});

/** POST /api/student/assignments/:id/attempt 响应 data（创建或取回进行中/已交的 attempt） */
export const attemptStartDataSchema = attemptSummarySchema;

/** GET /api/student/attempts/:id 的草稿视图（status=draft）响应 data */
export const attemptDraftDataSchema = z.object({
  attempt: attemptSummarySchema,
  /** 作业标题（答题页顶部展示） */
  title: z.string().min(1),
  /** 截止时间：UTC ISO；未设置为 null */
  dueAt: assignmentDueAtSchema.nullable(),
  /** 公开题目（与 T2.4 试卷同形态：QuestionPublic[]，按单元题序） */
  questions: z.array(questionPublicSchema),
  /**
   * 本人草稿答案：questionId → StudentAnswer。未作答的题不在 Map 内；
   * 键名用 drafts（学生自己的答案），与结果视图的 answers（参考答案）区分。
   */
  drafts: z.record(z.string(), studentAnswerSchema),
});

/**
 * 结果视图的单题（题目来自交卷时写入的 questionSnapshotJson）：
 * - snapshot：题目快照的公开形态 + 含答案标记的原始题干（stemMd 为作答时原文）；
 * - answers：参考答案（快照的 QuestionAnswers；题目未给标准答案为 null）；
 * - solutionMd：详解（快照；未提供为 null）；
 * - answer：本人答案（未作为 null）；
 * - autoCorrect：服务端判分结果 true/false；null = 不能自动判定
 *   （未作答、手写题未填最终答案、题目无标准答案——交教师批改，T3.2）。
 * 注意：快照里的提示内容不随本视图下发（hintCount 之外无 hints 字段，T2.11 按需）。
 */
export const attemptResultQuestionSchema = z.object({
  questionId: z.string().min(1),
  snapshot: z.object({
    id: z.string().min(1),
    type: questionPublicSchema.shape.type,
    difficulty: questionPublicSchema.shape.difficulty,
    knowledge: questionPublicSchema.shape.knowledge,
    /** 作答时的原始题干（含 [[答案]] 标记，已交卷允许下发） */
    stemMd: z.string(),
    /** 选项纯文本（仅 choice/multi 携带） */
    options: z.array(z.string()).optional(),
    /** 提示数量（内容不在此下发） */
    hintCount: z.number().int().min(0),
  }),
  answers: questionAnswersSchema.nullable(),
  solutionMd: z.string().nullable(),
  answer: studentAnswerSchema.nullable(),
  autoCorrect: z.boolean().nullable(),
});

/** 结果视图的得分汇总（口径见各字段注释；scoreAuto = correct/autoGradable 的百分比） */
export const attemptScoreSummarySchema = z.object({
  /** 总题数（参与本次作答的题目） */
  total: z.number().int().min(0),
  /** 已作答题数（answer 非 null） */
  answered: z.number().int().min(0),
  /** 自动判对数 */
  correct: z.number().int().min(0),
  /** 自动判错数 */
  wrong: z.number().int().min(0),
  /** 不能自动判定数（autoCorrect=null：未作答 + 需教师批改） */
  pending: z.number().int().min(0),
  /** 未作答题数（answer=null） */
  unanswered: z.number().int().min(0),
  /** 可自动判分题数（autoCorrect 非 null）= correct + wrong */
  autoGradable: z.number().int().min(0),
});

/** POST /api/student/attempts/:id/submit 响应与 GET 详情的结果视图（已交）共用 */
export const attemptResultDataSchema = z.object({
  attempt: attemptSummarySchema,
  /** 作业标题（结果页顶部展示） */
  title: z.string().min(1),
  /** 截止时间：UTC ISO；未设置为 null */
  dueAt: assignmentDueAtSchema.nullable(),
  /** 得分汇总 */
  summary: attemptScoreSummarySchema,
  /** 逐题结果（按单元题序） */
  questions: z.array(attemptResultQuestionSchema),
});

/** PUT /api/student/attempts/:id/answers/:questionId 请求体 */
export const attemptAnswerSaveRequestSchema = z.object({
  answer: studentAnswerSchema,
});

/** PUT /api/student/attempts/:id/answers/:questionId 响应 data */
export const attemptAnswerSaveDataSchema = z.object({
  /** 已保存的题目 id（回显，方便前端对账） */
  questionId: z.string().min(1),
  /** 该题累计保存次数（含本次；T2.10 起用于改答案次数统计） */
  changeCount: z.number().int().min(1),
});

/**
 * GET /api/student/attempts/:id 响应 data：按 attempt.status 二选一
 * （draft → 草稿视图，submitted/graded → 结果视图；判别键在嵌套的 attempt.status
 * 上，Zod 不支持嵌套判别，用普通 union，具体形态由 attempt.ts 契约测试锁定）。
 */
export const attemptDetailDataSchema = z.union([
  attemptDraftDataSchema,
  attemptResultDataSchema,
]);

/**
 * 作答模块错误码（UPPER_SNAKE_CODE 固定子集）：
 * - ASSIGNMENT_NOT_FOUND：创建 attempt 的作业不存在（含已删除）（404）；
 * - ATTEMPT_NOT_FOUND：attempt 不存在（404）；
 * - ALREADY_SUBMITTED：attempt 已交卷，不能再保存草稿 / 重复交卷（409，验收项）；
 * - QUESTION_NOT_FOUND：题目不存在、已软删或不在该作业单元内（404）；
 * - FORBIDDEN：非本人 attempt / 未被指派的作业（403）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义（401 / 400）。
 */
export const attemptErrorCodeSchema = z.enum([
  "ASSIGNMENT_NOT_FOUND",
  "ATTEMPT_NOT_FOUND",
  "ALREADY_SUBMITTED",
  "QUESTION_NOT_FOUND",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

// ---------- 具体化的成功壳 ----------

/** 携带创建/取回 attempt 结果的成功响应壳 */
export const attemptStartOkSchema = apiOkExtend(attemptStartDataSchema);
/** 携带草稿视图的成功响应壳 */
export const attemptDraftOkSchema = apiOkExtend(attemptDraftDataSchema);
/** 携带结果视图的成功响应壳 */
export const attemptResultOkSchema = apiOkExtend(attemptResultDataSchema);
/** 携带草稿保存回执的成功响应壳 */
export const attemptAnswerSaveOkSchema = apiOkExtend(
  attemptAnswerSaveDataSchema,
);

// ---------- 推断类型导出 ----------

export type AttemptStatus = z.infer<typeof attemptStatusSchema>;
export type AttemptSummary = z.infer<typeof attemptSummarySchema>;
export type AttemptStartData = z.infer<typeof attemptStartDataSchema>;
export type AttemptDraftData = z.infer<typeof attemptDraftDataSchema>;
export type AttemptResultQuestion = z.infer<typeof attemptResultQuestionSchema>;
export type AttemptScoreSummary = z.infer<typeof attemptScoreSummarySchema>;
export type AttemptResultData = z.infer<typeof attemptResultDataSchema>;
export type AttemptAnswerSaveRequest = z.infer<
  typeof attemptAnswerSaveRequestSchema
>;
export type AttemptAnswerSaveData = z.infer<typeof attemptAnswerSaveDataSchema>;
export type AttemptErrorCode = z.infer<typeof attemptErrorCodeSchema>;
/** 详情响应 data：草稿视图或结果视图（服务端按 attempt.status 返回其一） */
export type AttemptDetailData = z.infer<typeof attemptDetailDataSchema>;

// ---------- 与作业状态的关系 ----------

/**
 * attempt 状态 → 学生作业列表四态的推导在服务端纯函数 computeAssignmentStatus
 * （assignment-service，T2.2 预留）：graded > submitted > draft > not_started。
 * 本文件的 AttemptStatus（库三态）与 assignment.ts 的 AssignmentStatus（学生端
 * 四态）在此声明对应关系，避免两处枚举各自漂移。
 */
