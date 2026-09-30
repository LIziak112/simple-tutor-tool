import { z } from "zod";
import { attemptSourceSchema, attemptStatusSchema } from "./attempt.ts";
import { questionAnswersSchema, questionTypeSchema } from "./content.ts";
import { studentAnswerSchema } from "./grading.ts";

/**
 * 教师端作答数据页契约（T3.1，依据 Phase3 清单 D5–D8）：
 * GET /api/teacher/attempts 作答卡片列表（三视图/来源筛选共用一套查询）
 * 与 GET /api/teacher/attempts/:id 作答详情（D5：draft 亦可用）。
 * T3.2b 增补（D3/D4）：POST /api/teacher/responses/:id/mark 批注与
 * GET /api/teacher/pending-marks 待批队列。
 * 依据：docs/Phase3任务清单.md §2 D5（草稿可见）、D6（三视图与来源筛选）、
 * D7（详情逐题字段）、D8（入口衔接）、D3（批注语义）、D4（待批队列口径）；
 * 全局约定见 docs/开发任务清单.md §0.3。
 *
 * 约定（与 assignment.ts / attempt.ts 一致）：
 * - 本文件只定义查询参数与 data 部分；响应壳统一由 index.ts 描述，
 *   此处仅用局部 helper 具体化成功壳（避免循环依赖）；
 * - 时间一律 UTC ISO 字符串（带 Z 后缀；前端本地时间提交前转 UTC）；
 * - 教师端不受 AGENTS.md 第 3 条泄露约束，但 **draft 详情整卷不下发
 *   参考答案与详解**（D7：draft 无快照，且未交卷不展示答案对比）。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/** 分页 limit：默认 50，最小 1，最大 200（D6） */
export const TEACHER_ATTEMPT_PAGE_MAX = 200;

/**
 * GET /api/teacher/attempts 查询参数（全部可选，可任意组合）：
 * - studentId / courseId / assignmentId：按学生、课程（assignment 来源取作业
 *   所属课程，course 来源即练习课程）、作业过滤；
 * - unitId：课程练习单元（DSL id，非 UUID）——assignment 来源的 attempt 不带
 *   单单元（多单元题目集合在 assignment_units），故本筛选只命中 course 来源；
 * - sourceType / status：来源类型与作答状态（draft=进行中，D5）；
 * - from / to：时间范围（UTC ISO，带 Z 后缀）——按「最近活动时间」
 *   （submittedAt ?? startedAt）过滤，与列表排序同一时间轴；
 * - limit / offset：分页（limit 默认 50、1–200；offset 默认 0）。
 * 查询参数为字符串，数值字段用 coerce 解析（"50" → 50）。
 */
export const teacherAttemptListQuerySchema = z.object({
  studentId: z.uuid("studentId 必须是 UUID 格式").optional(),
  courseId: z.uuid("courseId 必须是 UUID 格式").optional(),
  assignmentId: z.uuid("assignmentId 必须是 UUID 格式").optional(),
  unitId: z.string().min(1, "unitId 不能为空").optional(),
  sourceType: attemptSourceSchema.optional(),
  status: attemptStatusSchema.optional(),
  from: z.iso.datetime({ offset: false }).optional(),
  to: z.iso.datetime({ offset: false }).optional(),
  limit: z.coerce
    .number()
    .int("limit 必须是整数")
    .min(1, "limit 最小为 1")
    .max(TEACHER_ATTEMPT_PAGE_MAX, `limit 最大为 ${TEACHER_ATTEMPT_PAGE_MAX}`)
    .default(50),
  offset: z.coerce
    .number()
    .int("offset 必须是整数")
    .min(0, "offset 最小为 0")
    .default(0),
});

/**
 * 来源上下文（列表卡片与详情头共用）：
 * - assignment 来源：assignmentId / assignmentTitle 非空（标题为布置时快照），
 *   courseId / courseName 取作业所属课程（未挂课程为 null）；展示「作业标题」
 *   （挂课程时配课程名）；unitId / unitTitle 为 null（多单元题目集合在
 *   assignment_units），attemptNo 恒 1；
 * - course 来源：courseId / courseName / unitId / unitTitle 非空、attemptNo
 *   从 1 递增；展示「单元标题 · 第 n 次」；assignmentId / assignmentTitle 为 null。
 */
export const teacherAttemptSourceSchema = z.object({
  sourceType: attemptSourceSchema,
  /** 所属课程 id：course 来源即练习课程；assignment 来源取作业所属课程（可空） */
  courseId: z.uuid().nullable(),
  /** 课程名（当前值）；无课程为 null */
  courseName: z.string().min(1).nullable(),
  /** 作业 id（assignments.id）；course 来源为 null */
  assignmentId: z.uuid().nullable(),
  /** 作业标题（布置时快照，不随单元改名联动）；course 来源为 null */
  assignmentTitle: z.string().min(1).nullable(),
  /** 课程练习目标单元 id（来自 DSL）；assignment 来源为 null */
  unitId: z.string().min(1).nullable(),
  /** 单元标题（当前值；course 来源展示「单元标题 · 第 n 次」）；assignment 来源为 null */
  unitTitle: z.string().min(1).nullable(),
  /** 第几次作答（course 来源从 1 递增；assignment 来源恒 1） */
  attemptNo: z.number().int().min(1),
});

/**
 * 教师批改标记（D3 持久化口径：teacherMark 优先于 autoCorrect）。
 * T3.2b 的 mark 接口落地写入；本阶段（T3.1）库内恒 null，只读下发。
 */
export const teacherMarkSchema = z.enum(["correct", "wrong"]);

/**
 * 列表的单张作答卡片（平铺；按最近活动时间倒序）。
 * 待批数口径（D4 共享谓词，T3.2a 起）：已交卷 responses 中
 * `finalCorrect IS NULL` 的题数（draft 恒 0，未交卷不构成待批；含只写笔迹
 * 未填最终答案的手写题）。由此「待批数 = 0 ⇔ status = graded」。
 */
export const teacherAttemptCardSchema = teacherAttemptSourceSchema.extend({
  /** attempts.id（crypto.randomUUID） */
  attemptId: z.uuid(),
  /** 作答学生 id */
  studentId: z.uuid(),
  /** 学生姓名（students.displayName 当前值） */
  studentName: z.string().min(1),
  /** attempt 的单元数（course 来源恒 1；assignment 来源 = assignment_units 行数） */
  unitCount: z.number().int().min(0),
  /** 题数（draft = 当前 live 题数；已交卷 = responses 冻结行数） */
  questionCount: z.number().int().min(0),
  status: attemptStatusSchema,
  /** 自动判分得分（0–100；无可判分或未交卷为 null） */
  scoreAuto: z.number().int().min(0).max(100).nullable(),
  /** 最终得分（D2/D3：交卷全部判定完成即写入；未批为 null；展示口径：scoreFinal ?? scoreAuto） */
  scoreFinal: z.number().int().min(0).max(100).nullable(),
  /** 待批数（口径见本 schema 头注释） */
  pendingCount: z.number().int().min(0),
  /** 开始作答时间：UTC ISO */
  startedAt: z.string().min(1),
  /** 交卷时间：UTC ISO；未交为 null（D5：draft 也出现在列表，前端标「进行中」） */
  submittedAt: z.string().nullable(),
  /** 有效作答用时（秒；服务端按事件计算，未计算为 null） */
  activeSec: z.number().int().min(0).nullable(),
});

/** GET /api/teacher/attempts 响应 data（按最近活动时间 submittedAt ?? startedAt 倒序） */
export const teacherAttemptListDataSchema = z.object({
  attempts: z.array(teacherAttemptCardSchema),
  /** 筛选后的总条数（分页前；offset 越界时 attempts 为空但 total 照常） */
  total: z.number().int().min(0),
});

/**
 * 详情逐题的手写信息：按 ink 表 (attemptId, questionId) 关联取得
 * （D7：**不读 responses.inkId**——该列从未写入；draft 期也可能有笔迹无
 * responses 行）。无 ink 行（非手写题 / 未书写）为 null。
 */
export const teacherAttemptInkSchema = z.object({
  /** ink.id（教师端 PNG/回放接口的定位 id） */
  inkId: z.uuid(),
  /** 快照 PNG 地址（相对路径，GET /api/teacher/ink/{inkId}.png） */
  pngUrl: z.string().min(1),
  /** 是否有笔画（ink.strokeCount > 0；只写笔迹未填最终答案的题也为 true） */
  hasStrokes: z.boolean(),
});

/**
 * 详情的逐题行（D7 全字段）：
 * - 题干：已交卷取 questionSnapshotJson 快照原文（含 [[答案]] 标记，教师端允许）；
 *   draft 取当前库题目并经 publicStemMd 公开化（与学生草稿视图同源——不随
 *   详情下发参考答案，题干标记里的答案同样不外露，D7）；
 * - answer：学生答案（StudentAnswer 原样 JSON；未作为 null）；
 * - autoCorrect / finalCorrect / teacherMark / teacherComment：均 nullable，
 *   draft 整卷为 null（未交卷无判定，判定列显示「未交卷」，D5）；
 * - answers / solutionMd：**仅已交卷 attempt 下发**（draft 详情整卷缺省不发，
 *   optional + nullable：题目本身无标准答案 / 未提供详解时为 null）。
 */
export const teacherAttemptDetailQuestionSchema = z.object({
  /** 题目 id（来自 DSL） */
  questionId: z.string().min(1),
  /**
   * responses.id（POST /responses/:id/mark 的定位 id，D3 详情页内联批改用）：
   * 仅已交卷 attempt 的逐题行携带（冻结 responses 行的 id）；draft 逐题来自
   * 当前库题目、可能尚无 responses 行，恒 null（draft 本就不可批注）。
   */
  responseId: z.uuid().nullable(),
  /** 全卷连续题号（1 起 = attempt 单元顺序 × 单元内题序） */
  no: z.number().int().min(1),
  /** 所在单元 id */
  unitId: z.string().min(1),
  /** 所在单元节标题（当前值；含软删单元——attempt 数据不随单元软删消失，D16） */
  unitTitle: z.string().min(1),
  /** 题型（快照或当前库值） */
  type: questionTypeSchema,
  /** 难度 1–5 */
  difficulty: z.number().int().min(1).max(5),
  /** 考点名列表（快照或当前关联值） */
  knowledge: z.array(z.string().min(1)),
  /** 题干 Markdown（口径见本 schema 头注释） */
  stemMd: z.string(),
  /** 选项纯文本（仅 choice/multi 携带） */
  options: z.array(z.string()).optional(),
  /** 学生答案（未作为 null） */
  answer: studentAnswerSchema.nullable(),
  /** 自动判定（true/false）；不能自动判定为 null；draft 为 null */
  autoCorrect: z.boolean().nullable(),
  /** 最终判定（teacherMark ?? autoCorrect 持久化口径，T3.2 启用）；draft 为 null */
  finalCorrect: z.boolean().nullable(),
  /** 教师批改标记（D3；本阶段恒 null） */
  teacherMark: teacherMarkSchema.nullable(),
  /** 教师评语（T3.2；未评为 null） */
  teacherComment: z.string().nullable(),
  /** 每题有效用时（秒；未计算为 null） */
  activeSec: z.number().int().min(0).nullable(),
  /** 已解锁提示数 */
  hintsUsed: z.number().int().min(0),
  /** 答案保存（改答案）次数 */
  changeCount: z.number().int().min(0),
  /** 手写信息（口径见 teacherAttemptInkSchema 注释）；无笔迹为 null */
  ink: teacherAttemptInkSchema.nullable(),
  /** 参考答案（快照 QuestionAnswers；仅已交卷下发——draft 缺省不发；无标准答案为 null） */
  answers: questionAnswersSchema.nullable().optional(),
  /** 详解（仅已交卷下发——draft 缺省不发；未提供为 null） */
  solutionMd: z.string().nullable().optional(),
});

/**
 * GET /api/teacher/attempts/:id 响应 data（D7；draft 亦可用，D5）。
 * 对/错/待批计数用统一展示口径 `effectiveCorrect = finalCorrect ?? autoCorrect`
 * （T3.2a 起交卷即写 finalCorrect，故等价 finalCorrect；T3.2b 批注后以教师判定
 * 优先）；draft 全 0（未交卷）。
 */
export const teacherAttemptDetailDataSchema = teacherAttemptSourceSchema.extend(
  {
    /** attempts.id */
    attemptId: z.uuid(),
    studentId: z.uuid(),
    studentName: z.string().min(1),
    status: attemptStatusSchema,
    scoreAuto: z.number().int().min(0).max(100).nullable(),
    scoreFinal: z.number().int().min(0).max(100).nullable(),
    /** 判对题数（effectiveCorrect = true） */
    correctCount: z.number().int().min(0),
    /** 判错题数（effectiveCorrect = false） */
    wrongCount: z.number().int().min(0),
    /** 待批数（effectiveCorrect = null；口径同列表卡片 pendingCount） */
    pendingCount: z.number().int().min(0),
    startedAt: z.string().min(1),
    submittedAt: z.string().nullable(),
    activeSec: z.number().int().min(0).nullable(),
    /** 逐题列表（全卷连续题号编排；draft 与已交卷的来源差异见逐题 schema 注释） */
    questions: z.array(teacherAttemptDetailQuestionSchema),
  },
);

// ---------- 错误码 ----------

/**
 * 教师端作答数据错误码（UPPER_SNAKE_CODE 固定子集）：
 * - ATTEMPT_NOT_FOUND：attempt 不存在或非本教师学生的作答（404，不暴露存在性，
 *   T2B 域隔离口径）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义（401 / 400）。
 */
export const teacherAttemptErrorCodeSchema = z.enum([
  "ATTEMPT_NOT_FOUND",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

// ---------- T3.2b 批注与待批队列（D3/D4） ----------

/** 教师评语长度上限（D3：契约层校验，超出 400 VALIDATION_ERROR） */
export const TEACHER_COMMENT_MAX = 2000;

/**
 * POST /api/teacher/responses/:id/mark 请求体（D3）：判定与评语两字段一次提交
 * （UI 上一起保存），两个字段**都必须显式携带**（值可为 null）：
 * - mark：'correct' | 'wrong' | null——null 清除教师判定（finalCorrect 回落
 *   autoCorrect）；
 * - comment：string | null——先按原始长度校验 ≤2000（超出 400），再 trim 归一化：
 *   去首尾空白后空串按 null（清除评语），其余存 trim 后文本。服务层收到的一定是
 *   归一化结果，不再二次处理。
 * 允许对任何**已交卷**的题批注/改判（含自动判过的题）；draft attempt → 409
 * NOT_SUBMITTED；非本人教师 → 404 RESPONSE_NOT_FOUND（见 teacherMarkErrorCodeSchema）。
 */
export const markRequestSchema = z.object({
  mark: teacherMarkSchema.nullable(),
  comment: z
    .string({ message: "comment 必须是字符串" })
    .max(TEACHER_COMMENT_MAX, `评语最长 ${TEACHER_COMMENT_MAX} 字`)
    .nullable()
    .transform((value) => {
      const trimmed = value === null ? null : value.trim();
      return trimmed === "" || trimmed === null ? null : trimmed;
    }),
});

/**
 * POST /api/teacher/responses/:id/mark 响应 data：批注写回后的最新状态
 * （事务内落库后回读）。整卷字段按 D2 状态机重算：全部 finalCorrect 非 null →
 * graded + scoreFinal；任一待批 → submitted + null。pendingCount 为该 attempt
 * 剩余待批数（D4 共享谓词口径），前端据此更新批改进度 x/y。
 */
export const markResponseDataSchema = z.object({
  /** responses.id（批注定位的题） */
  responseId: z.uuid(),
  /** 题目 id（来自 DSL） */
  questionId: z.string().min(1),
  /** 所属 attempt */
  attemptId: z.uuid(),
  /** 批注后的教师判定（mark=null 即已清除） */
  teacherMark: teacherMarkSchema.nullable(),
  /** 批注后的评语（契约已归一化：trim 后空串为 null） */
  teacherComment: z.string().nullable(),
  /** 本题最终判定（持久化口径 teacherMark ?? autoCorrect 的写回结果） */
  finalCorrect: z.boolean().nullable(),
  /** 批注后整卷状态（批注只发生在已交卷 attempt，draft 不可达） */
  attemptStatus: z.enum(["submitted", "graded"]),
  /** 批注后整卷最终得分（D2：round(对÷全部×100)；仍有待批为 null） */
  scoreFinal: z.number().int().min(0).max(100).nullable(),
  /** 该 attempt 剩余待批数（D4 共享谓词） */
  pendingCount: z.number().int().min(0),
});

/**
 * GET /api/teacher/pending-marks 查询参数（全部可选，可任意组合；D4）：
 * courseId / assignmentId / studentId 按课程（assignment 来源取作业所属课程）、
 * 作业、学生过滤。教师域过滤恒生效（乙只见自己的学生），排序恒 submittedAt
 * 升序（先交先批），无分页（单教师待批队列规模有限，连续批改一次取全量）。
 */
export const pendingMarkListQuerySchema = z.object({
  courseId: z.uuid("courseId 必须是 UUID 格式").optional(),
  assignmentId: z.uuid("assignmentId 必须是 UUID 格式").optional(),
  studentId: z.uuid("studentId 必须是 UUID 格式").optional(),
});

/**
 * 待批队列的单题卡片（D4 口径 ≡ 已交卷 attempt 中 finalCorrect IS NULL 的
 * responses；含只写笔迹未填最终答案的手写题）。教师端不受泄露约束——题干取
 * questionSnapshotJson 快照原文（含 [[答案]] 标记），参考答案照常下发（批改要用）。
 * 学生最终答案序列化为人类可读文本 answerText（多选按序字母、多空按序拼接、
 * 手写题为最终答案原文；未作为 null——与 D13 CSV 序列化同一口径）。
 */
export const pendingMarkCardSchema = teacherAttemptSourceSchema.extend({
  /** responses.id（POST /responses/:id/mark 的定位 id） */
  responseId: z.uuid(),
  /** 所属 attempt */
  attemptId: z.uuid(),
  /** 题目 id（来自 DSL） */
  questionId: z.string().min(1),
  /** 作答学生 id */
  studentId: z.uuid(),
  /** 学生姓名（students.displayName 当前值） */
  studentName: z.string().min(1),
  /** 题型（快照） */
  type: questionTypeSchema,
  /** 难度 1–5（快照） */
  difficulty: z.number().int().min(1).max(5),
  /** 考点名列表（快照） */
  knowledge: z.array(z.string().min(1)),
  /** 题干 Markdown（快照原文，含 [[答案]] 标记） */
  stemMd: z.string(),
  /** 选项纯文本（仅 choice/multi 快照携带） */
  options: z.array(z.string()).optional(),
  /** 参考答案（快照 QuestionAnswers；题目无标准答案为 null） */
  answers: questionAnswersSchema.nullable(),
  /** 学生最终答案（人类可读序列化；未作为 null） */
  answerText: z.string().nullable(),
  /** 手写信息（ink 表 (attemptId, questionId) 关联，D7 同口径）；无笔迹为 null */
  ink: teacherAttemptInkSchema.nullable(),
  /** 每题有效用时（秒；未计算为 null） */
  activeSec: z.number().int().min(0).nullable(),
  /** 已解锁提示数 */
  hintsUsed: z.number().int().min(0),
  /** 答案保存（改答案）次数 */
  changeCount: z.number().int().min(0),
  /** 交卷时间：UTC ISO（待批题必属已交卷 attempt，恒非空） */
  submittedAt: z.string().min(1),
});

/** GET /api/teacher/pending-marks 响应 data（submittedAt 升序，先交先批） */
export const pendingMarkListDataSchema = z.object({
  marks: z.array(pendingMarkCardSchema),
});

/**
 * 批注与待批队列错误码：
 * - RESPONSE_NOT_FOUND：response 不存在或非本教师学生的作答（404，不暴露存在性，
 *   与 ATTEMPT_NOT_FOUND 同口径）；
 * - NOT_SUBMITTED：对 draft attempt 批注（409——未交卷的题没有可批改的冻结行）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义（401 / 400）。
 */
export const teacherMarkErrorCodeSchema = z.enum([
  "RESPONSE_NOT_FOUND",
  "NOT_SUBMITTED",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

// ---------- 具体化的成功壳 ----------

/** 携带教师作答列表的成功响应壳 */
export const teacherAttemptListOkSchema = apiOkExtend(
  teacherAttemptListDataSchema,
);
/** 携带教师作答详情的成功响应壳 */
export const teacherAttemptDetailOkSchema = apiOkExtend(
  teacherAttemptDetailDataSchema,
);
/** 携带批注结果的成功响应壳（T3.2b） */
export const teacherMarkOkSchema = apiOkExtend(markResponseDataSchema);
/** 携带待批队列的成功响应壳（T3.2b） */
export const pendingMarkListOkSchema = apiOkExtend(pendingMarkListDataSchema);

// ---------- 推断类型导出 ----------

export type TeacherAttemptListQuery = z.infer<
  typeof teacherAttemptListQuerySchema
>;
export type TeacherAttemptSource = z.infer<typeof teacherAttemptSourceSchema>;
export type TeacherAttemptCard = z.infer<typeof teacherAttemptCardSchema>;
export type TeacherAttemptListData = z.infer<
  typeof teacherAttemptListDataSchema
>;
export type TeacherAttemptInkInfo = z.infer<typeof teacherAttemptInkSchema>;
export type TeacherAttemptDetailQuestion = z.infer<
  typeof teacherAttemptDetailQuestionSchema
>;
export type TeacherAttemptDetailData = z.infer<
  typeof teacherAttemptDetailDataSchema
>;
export type TeacherAttemptErrorCode = z.infer<
  typeof teacherAttemptErrorCodeSchema
>;
export type MarkRequest = z.output<typeof markRequestSchema>;
export type MarkResponseData = z.infer<typeof markResponseDataSchema>;
export type PendingMarkListQuery = z.infer<typeof pendingMarkListQuerySchema>;
export type PendingMarkCard = z.infer<typeof pendingMarkCardSchema>;
export type PendingMarkListData = z.infer<typeof pendingMarkListDataSchema>;
export type TeacherMarkErrorCode = z.infer<typeof teacherMarkErrorCodeSchema>;
