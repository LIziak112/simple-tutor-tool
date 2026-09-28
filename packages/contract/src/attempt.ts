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
 * - 分步提示（T2.11）：提示内容只经 POST /attempts/:id/hints 按需逐条下发；
 *   两个视图只回显「已解锁」的提示条目（hintsOpened，学生自己看过的不算泄露），
 *   未解锁条目的内容文本绝不出现在任何学生端响应（泄露矩阵专项断言，见
 *   routes/student-hints.test.ts）；
 * - 公布时机（T2A.8，D11）：assignment 来源 answerRelease='after_due' 且未到
 *   截止时，结果视图降级为受限形态（answersReleased=false，见
 *   attemptResultDataSchema.answersReleased 注释）；截止后自动恢复完整形态。
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
 * 作答来源（T2A.6，Phase 2A 清单 D9）：
 * - assignment：作业作答（记 assignmentId；courseId 可空，T2A.7 起取作业所属课程）；
 * - course：课程练习作答（记 courseId + unitId，可重做，attemptNo 递增）。
 * 两种来源共用同一套作答接口与答题页（判分/快照/提示/笔迹/事件全按 attemptId）。
 */
export const attemptSourceSchema = z.enum(["assignment", "course"]);

/**
 * attempt 摘要（创建/取回的返回，也内嵌在详情视图里）。
 * - assignment 来源：一个作业一人至多一份进行中（draft）attempt；交卷后再次 POST
 *   /attempt 返回已交的那份（前端据此直接进结果视图，不另开新卷）；
 * - course 来源：同一 (学生, 课程, 单元) 同时最多 1 份 draft；已交卷后「再做一次」
 *   创建新 attempt（attemptNo 递增，从 1 起，新一次从空白开始，D10）。
 */
export const attemptSummarySchema = z.object({
  /** attempts.id（crypto.randomUUID） */
  id: z.uuid(),
  /** 作答来源（D9） */
  sourceType: attemptSourceSchema,
  /** 所属作业（assignments.id）；course 来源为 null */
  assignmentId: z.uuid().nullable(),
  /** 课程练习所属课程（courses.id）；assignment 来源取作业所属课程（可空，D9/T2A.7） */
  courseId: z.uuid().nullable(),
  /**
   * 目标练习单元（units.id）：course 来源恒有值（单单元）；assignment 来源
   * 自 T2A.7 多单元化起为 null——题目集合改由 assignment_units 决定
   * （题号全卷连续），不再落在单个单元上。
   */
  unitId: z.string().min(1).nullable(),
  /** 第几次作答（course 来源从 1 递增；assignment 来源恒 1） */
  attemptNo: z.number().int().min(1),
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

/** POST /api/student/assignments/:id/attempt 与 POST /api/student/courses/:cid/units/:uid/attempts 响应 data（创建或取回 attempt） */
export const attemptStartDataSchema = attemptSummarySchema;

/**
 * 已解锁的提示条目（T2.11）：草稿视图/结果视图回显、解锁响应共用的最小形态。
 * - index：提示序号（0 起，对齐 hint_open 事件的 index 语义与题目 hintsJson 数组下标）；
 * - text：提示内容（RichMarkdown 渲染）。**只有已解锁（学生自己请求过）的条目携带
 *   text**；未解锁条目的内容绝不进任何学生端响应（AGENTS 第 3 条）。
 */
export const hintOpenedEntrySchema = z.object({
  index: z.number().int().min(0),
  text: z.string(),
});

/**
 * 草稿视图的单元分组（T2A.7）：题目按所属单元分节下发。
 * assignment 来源按 assignment_units.order 排列（题号全卷连续）；course 来源
 * 恒为单组（单元标题）。live 题数为 0 的单元不出现（与试卷口径一致）。
 */
export const attemptDraftUnitSchema = z.object({
  /** 练习单元 id（来自 DSL） */
  id: z.string().min(1),
  /** 单元标题（当前值；答题页分节标题） */
  title: z.string().min(1),
  /** 该单元的公开题目（QuestionPublic 形态，按单元内题序） */
  questions: z.array(questionPublicSchema),
});

/** GET /api/student/attempts/:id 的草稿视图（status=draft）响应 data */
export const attemptDraftDataSchema = z.object({
  attempt: attemptSummarySchema,
  /** 标题（答题页顶部展示）：assignment=作业标题；course=单元标题 */
  title: z.string().min(1),
  /**
   * 来源课程名：course 来源恒有值（顶部来源行「课程：xx · 第 n 次」）；
   * assignment 来源自 T2A.7 起有所属课程时返回课程名（来源行「作业 · 课程名」），
   * 无课程为 null。
   */
  courseName: z.string().nullable(),
  /** 截止时间：UTC ISO；未设置为 null（course 来源恒 null，练习不限截止） */
  dueAt: assignmentDueAtSchema.nullable(),
  /** 公开题目分组（与试卷同形态：按单元分节，题号全卷连续） */
  units: z.array(attemptDraftUnitSchema),
  /**
   * 本人草稿答案：questionId → StudentAnswer。未作答的题不在 Map 内；
   * 键名用 drafts（学生自己的答案），与结果视图的 answers（参考答案）区分。
   */
  drafts: z.record(z.string(), studentAnswerSchema),
  /**
   * 已解锁提示（T2.11）：questionId → 已解锁条目（含内容，刷新页面后回显）。
   * 未解锁提示的内容不在此（也不在任何学生端响应）。
   */
  hintsOpened: z.record(z.string(), hintOpenedEntrySchema.array()),
});

/**
 * 结果视图的单题（题目来自交卷时写入的 questionSnapshotJson）：
 * - snapshot：题目快照的公开形态 + 含答案标记的原始题干（stemMd 为作答时原文）；
 * - answers：参考答案（快照的 QuestionAnswers；题目未给标准答案为 null）；
 * - solutionMd：详解（快照；未提供为 null）；
 * - answer：本人答案（未作为 null）；
 * - autoCorrect：服务端判分结果 true/false；null = 不能自动判定
 *   （未作答、手写题未填最终答案、题目无标准答案——交教师批改，T3.2）；
 * - hintsOpened：做题时已解锁的提示条目（含内容；交卷后回看自己用过的提示，
 *   T2.11）。快照里的其余提示内容仍不随本视图下发（hintCount 是唯一计数形态）。
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
    /** 提示数量（未解锁的提示内容不在此下发） */
    hintCount: z.number().int().min(0),
  }),
  answers: questionAnswersSchema.nullable(),
  solutionMd: z.string().nullable(),
  answer: studentAnswerSchema.nullable(),
  autoCorrect: z.boolean().nullable(),
  /** 做题时已解锁的提示（按序号升序；未解锁过为空数组） */
  hintsOpened: hintOpenedEntrySchema.array(),
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

/** 结果视图的单元分组（T2A.7）：逐题结果按交卷时的单元归属分节（单元序+题序） */
export const attemptResultUnitSchema = z.object({
  /** 练习单元 id（来自 DSL） */
  id: z.string().min(1),
  /** 单元标题（当前值；结果页分节标题） */
  title: z.string().min(1),
  /** 该单元的逐题结果（按单元内题序） */
  questions: z.array(attemptResultQuestionSchema),
});

/** POST /api/student/attempts/:id/submit 响应与 GET 详情的结果视图（已交）共用 */
export const attemptResultDataSchema = z.object({
  attempt: attemptSummarySchema,
  /** 标题（结果页顶部展示）：assignment=作业标题；course=单元标题 */
  title: z.string().min(1),
  /**
   * 来源课程名：course 来源恒有值；assignment 来源自 T2A.7 起有所属课程时
   * 返回课程名（「作业 · 课程名」），无课程为 null。
   */
  courseName: z.string().nullable(),
  /** 截止时间：UTC ISO；未设置为 null（course 来源恒 null） */
  dueAt: assignmentDueAtSchema.nullable(),
  /**
   * 答案是否已公布（T2A.8，D11）。false = 受限形态（assignment 来源且
   * answerRelease='after_due' 且 now < dueAt，交卷瞬间未到截止同样适用）：
   * - 逐题 answers / solutionMd / autoCorrect 一律 null（不下发参考答案、详解、
   *   对错）；answer（本人答案）与 hintsOpened（本人已解锁提示）照常下发；
   * - snapshot.stemMd 为 publicStemMd 公开化版（[[答案]] 标记替换为 [[]]，
   *   与草稿视图同一防泄露口径）；
   * - attempt.scoreAuto 置 null 投影（库里保留，截止后恢复真实值）；
   * - summary 不泄露对错：correct/wrong/autoGradable = 0，pending 按 answered
   *   口径（每道已答题都显示为「待批」），total/answered/unanswered 照常。
   * 截止后（now ≥ dueAt）读时自动恢复完整形态（无定时任务）；on_submit 与
   * course 来源恒为 true。
   */
  answersReleased: z.boolean(),
  /** 得分汇总 */
  summary: attemptScoreSummarySchema,
  /** 逐题结果分组（T2A.7：assignment 按单元序分节，course 单组；组内按题序） */
  units: z.array(attemptResultUnitSchema),
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
 * POST /api/student/attempts/:id/hints 请求体（T2.11 分步提示）：
 * 获取该题第 index 条提示（0 起）并解锁（服务端记录 hint_open 事件与已解锁集合）。
 * index 只拦非整数；越界（<0 或 ≥该题提示总数）统一由服务端判
 * HINT_INDEX_OUT_OF_RANGE（400，T2.11 验收项），保证两个越界方向同一错误码。
 */
export const hintOpenRequestSchema = z.object({
  questionId: z.string().min(1, "questionId 不能为空"),
  index: z.number().int({ message: "index 必须是整数" }),
});

/**
 * POST /api/student/attempts/:id/hints 响应 data：
 * 只含**被请求的那一条**提示内容 + 计数（总数/已解锁数/剩余数）。
 * hint 是全部学生端接口中唯一允许携带提示内容的键（泄露测试用
 * assertNoLeak({ allow: ["hint"] }) 放行后，专项比对未解锁条目绝不出现）。
 * draft 与 submitted/graded 均可用（交卷后回看自己请求过的提示，验收项）。
 */
export const hintOpenDataSchema = z.object({
  /** 本次请求的题目 id（回显） */
  questionId: z.string().min(1),
  /** 本次请求的提示序号（回显） */
  index: z.number().int().min(0),
  /** 第 index 条提示的内容（唯一提示内容字段） */
  hint: z.string(),
  /** 该题提示总数 */
  hintCount: z.number().int().min(0),
  /** 已解锁提示数（去重后的集合大小；responses.hintsUsed 同口径） */
  hintsUsed: z.number().int().min(0),
  /** 尚未解锁的提示数（= hintCount - hintsUsed） */
  hintsRemaining: z.number().int().min(0),
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
 * - QUESTION_NOT_FOUND：题目不存在、已软删或不在该次作答的单元集合内（404，
 *   T2A.7 起多单元作业为集合包含判断）；
 * - HINT_INDEX_OUT_OF_RANGE：提示序号越界（<0 或 ≥该题提示总数，含无提示题；
 *   400，T2.11 验收项）；
 * - FORBIDDEN：非本人 attempt / 未被指派的作业（403）；
 * - COURSE_ACCESS_DENIED：课程来源作答失去访问权（非成员/学生归档/课程归档，
 *   D7+D22；403）——前端草稿同步与事件上报收到它（或 404）必须按终态停止重试；
 * - NOT_FOUND：课程来源作答的单元条目已隐藏/未到发布/资源删除（D22 的不暴露
 *   存在性口径，404）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义（401 / 400）。
 */
export const attemptErrorCodeSchema = z.enum([
  "ASSIGNMENT_NOT_FOUND",
  "ATTEMPT_NOT_FOUND",
  "ALREADY_SUBMITTED",
  "QUESTION_NOT_FOUND",
  "HINT_INDEX_OUT_OF_RANGE",
  "FORBIDDEN",
  "COURSE_ACCESS_DENIED",
  "NOT_FOUND",
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
/** 携带提示解锁结果的成功响应壳（hint 是唯一放行的提示内容键） */
export const hintOpenOkSchema = apiOkExtend(hintOpenDataSchema);

// ---------- 推断类型导出 ----------

export type AttemptStatus = z.infer<typeof attemptStatusSchema>;
export type AttemptSource = z.infer<typeof attemptSourceSchema>;
export type AttemptSummary = z.infer<typeof attemptSummarySchema>;
export type AttemptStartData = z.infer<typeof attemptStartDataSchema>;
export type AttemptDraftData = z.infer<typeof attemptDraftDataSchema>;
export type AttemptDraftUnit = z.infer<typeof attemptDraftUnitSchema>;
export type AttemptResultQuestion = z.infer<typeof attemptResultQuestionSchema>;
export type AttemptResultUnit = z.infer<typeof attemptResultUnitSchema>;
export type AttemptScoreSummary = z.infer<typeof attemptScoreSummarySchema>;
export type AttemptResultData = z.infer<typeof attemptResultDataSchema>;
export type AttemptAnswerSaveRequest = z.infer<
  typeof attemptAnswerSaveRequestSchema
>;
export type AttemptAnswerSaveData = z.infer<typeof attemptAnswerSaveDataSchema>;
export type HintOpenedEntry = z.infer<typeof hintOpenedEntrySchema>;
export type HintOpenRequest = z.infer<typeof hintOpenRequestSchema>;
export type HintOpenData = z.infer<typeof hintOpenDataSchema>;
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
