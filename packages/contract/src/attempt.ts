import { z } from "zod";
import {
  assignmentDueAtSchema,
  questionAnswersSchema,
  questionPublicSchema,
} from "./content.ts";
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
 * attempt 状态（§5.2 attempts.status；D2/D3 口径 T3.2a 修订）：
 * - draft：进行中（草稿，可保存答案、可交卷）；
 * - submitted：已交卷（存在待批题——手写/无标准答案/判断写法无法归一化，
 *   等待教师批改）；
 * - graded：已批改（= 全部 responses 的 finalCorrect 均非 null；**全客观题卷
 *   交卷即 graded**——交卷时同时写 finalCorrect = autoCorrect（D3），无待批题
 *   则直接置位并写 scoreFinal）。
 * 学生作业列表的四态（AssignmentStatus）由 computeAssignmentStatus 从本状态推导。
 */
export const attemptStatusSchema = z.enum(["draft", "submitted", "graded"]);

/**
 * 作答来源（T2A.6，Phase 2A 清单 D9；2026-10 增 wrong）：
 * - assignment：作业作答（记 assignmentId；courseId 可空，T2A.7 起取作业所属课程）；
 * - course：课程练习作答（记 courseId + unitId，可重做，attemptNo 递增）；
 * - wrong：错题重练作答（2026-10 学生端闭环）：assignmentId / courseId / unitId
 *   恒 null（无课程/作业归属，attempt 永不失权），attemptNo 按该生已有 wrong
 *   来源 attempt 数从 1 递增；题目集合是创建时圈定的错题快照（不落单元，
 *   见服务端 startWrongPractice）。
 * 三种来源共用同一套作答接口与答题页（判分/快照/提示/笔迹/事件全按 attemptId）。
 */
export const attemptSourceSchema = z.enum(["assignment", "course", "wrong"]);

/**
 * 教师批改标记（D3 持久化口径：teacherMark 优先于 autoCorrect）。
 * T3.2b 的 mark 接口写入；T3.5（D9）起学生端结果视图同样下发该标记——
 * 定义从 teacher-attempt-api.ts 上移到本文件（attempt.ts 是 teacher-attempt-api
 * 的下层模块，反向导入会形成循环），teacher-attempt-api.ts 改为导入复用，
 * 全站仍只有这一份定义（AGENTS 第 1 条）。
 */
export const teacherMarkSchema = z.enum(["correct", "wrong"]);

/**
 * attempt 摘要（创建/取回的返回，也内嵌在详情视图里）。
 * - assignment 来源：一个作业一人至多一份进行中（draft）attempt；交卷后再次 POST
 *   /attempt 返回已交的那份（前端据此直接进结果视图，不另开新卷）；
 * - course 来源：同一 (学生, 课程, 单元) 同时最多 1 份 draft；已交卷后「再做一次」
 *   创建新 attempt（attemptNo 递增，从 1 起，新一次从空白开始，D10）。
 *
 * 来源交叉不变式已在 schema 层锁定（下方 superRefine，不再是仅存于注释的约定）：
 * - course 来源：assignmentId 恒 null，courseId / unitId 恒有值；
 * - assignment 来源：assignmentId 恒有值，unitId 恒 null（courseId 随作业可空可非空）；
 * - wrong 来源（2026-10）：assignmentId / courseId / unitId 恒 null（错题重练
 *   无课程与作业归属；题目集合 = 创建 attempt 时冻结进 responses 的错题快照）。
 */
export const attemptSummarySchema = z
  .object({
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
     * （题号全卷连续），不再落在单个单元上。两条口径由下方 superRefine 强制。
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
     * D1（T3.2a）后未作答客观题判 false 进入分母，数值更真实；无可自动判分的题
     * （全部待批）或未交卷时为 null。graded 后以 scoreFinal 为准（全客观题卷
     * 两者分母相同、数值相等）。
     */
    scoreAuto: z.number().int().min(0).max(100).nullable(),
  })
  .superRefine((summary, ctx) => {
    if (summary.sourceType === "course") {
      if (summary.assignmentId !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["assignmentId"],
          message:
            "来源不变式冲突：course 来源的 assignmentId 必须为 null（课程练习不挂在作业上）",
        });
      }
      if (summary.courseId === null) {
        ctx.addIssue({
          code: "custom",
          path: ["courseId"],
          message:
            "来源不变式冲突：course 来源的 courseId 必须非空（课程练习必须记录所属课程）",
        });
      }
      if (summary.unitId === null) {
        ctx.addIssue({
          code: "custom",
          path: ["unitId"],
          message:
            "来源不变式冲突：course 来源的 unitId 必须非空（课程练习必须记录目标单元）",
        });
      }
    } else if (summary.sourceType === "wrong") {
      // wrong（2026-10 错题重练）：三归属键恒 null（无课程/作业归属，
      // 题目集合在 attempt 自己的 responses 行里，不经 assignment_units/单元）
      for (const [path, value] of [
        ["assignmentId", summary.assignmentId],
        ["courseId", summary.courseId],
        ["unitId", summary.unitId],
      ] as const) {
        if (value !== null) {
          ctx.addIssue({
            code: "custom",
            path: [path],
            message: `来源不变式冲突：wrong 来源的 ${path} 必须为 null（错题重练不挂作业/课程/单元）`,
          });
        }
      }
    } else {
      if (summary.assignmentId === null) {
        ctx.addIssue({
          code: "custom",
          path: ["assignmentId"],
          message:
            "来源不变式冲突：assignment 来源的 assignmentId 必须非空（作业作答必须记录所属作业）",
        });
      }
      if (summary.unitId !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["unitId"],
          message:
            "来源不变式冲突：assignment 来源的 unitId 必须为 null（T2A.7 多单元化后题目集合由 assignment_units 决定，不落单单元）",
        });
      }
    }
  });

/** POST /api/student/assignments/:id/attempt 与 POST /api/student/courses/:cid/units/:uid/attempts 响应 data（创建或取回 attempt） */
export const attemptStartDataSchema = attemptSummarySchema;

/**
 * POST /api/student/wrong-practice 请求体（2026-10 错题重练组卷）：
 * - questionIds：前端按错题本当前筛选口径（tab + 分组）圈出的题目 id，顺序即
 *   组卷题序（服务端按此顺序冻结进新 attempt 的 responses 行）；
 * - min(1)：空数组 400 VALIDATION_ERROR；重复 id 由服务端去重（保序），
 *   不在契约层拦截——前端从聚合结果取 id 天然无重复；
 * - 每个 id 服务端校验「∈ 该生错题本聚合（includeResolved 全量口径）且最近
 *   一次判定作答的快照可用」，不满足的静默剔除；剔完为空 → 400
 *   WRONG_PRACTICE_EMPTY（附中文说明）。
 */
export const wrongPracticeRequestSchema = z.object({
  questionIds: z
    .array(z.string().min(1, "题目 id 不能为空"))
    .min(1, "至少选择一道错题"),
});

/** POST /api/student/wrong-practice 响应（新建 wrong 来源 attempt；201） */
export const wrongPracticeOkSchema = apiOkExtend(attemptStartDataSchema);

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
 * 题目版本引用（T6R.3 冻结，方案 §5.1）：定位「本次作答时被冻结的那道题」，
 * 对学生不透明。铸造规则已由 T6R.3 定稿：**该 (attempt, question) 的
 * responses 行 id**（crypto.randomUUID）——每题每次作答天然唯一、快照与版本
 * 引用同源同寿、交卷回传比对即可验证题目版本，契约长度上限自然满足。
 * 该引用只能定位授权记录，不能当访问凭证。
 * （定义原在 note.ts；T6R.3 收敛时移入本文件——铸造规则属作答域，且 attempt
 * 视图/试卷形态与笔记元信息共用同一份，单一出处。）
 */
export const questionRevisionIdSchema = z
  .string()
  .min(1, "questionRevisionId 不能为空")
  .max(512)
  .refine((v) => v === v.trim(), "questionRevisionId 不能含首尾空白或为纯空白");

/**
 * attempt 视图的公开题目（T6R.3 全来源冻结）：QuestionPublic 白名单投影 +
 * 每题不透明 questionRevisionId（该题在本 attempt 的 responses 行 id——建卷
 * 冻结时铸造，交卷时原样回传以验证题目版本；只能定位授权记录，不能当访问
 * 凭证，方案 §5.1）。fail closed 语义与 questionPublicSchema 一致：多给的
 * 教师侧字段在 parse 时被 strip。
 */
export const attemptQuestionPublicSchema = questionPublicSchema.extend({
  questionRevisionId: questionRevisionIdSchema,
});

/**
 * 试卷题目的可选版本形态（T6R.3）：**仅通用取卷（GET /attempts/:id/paper，
 * 题目来自建卷冻结快照）携带** questionRevisionId；作业预览
 * （GET /assignments/:id/paper，开卷前的当前题库）没有 attempt 语境，不带
 * 该字段（可选语义，缺省合法）。由 attemptQuestionPublicSchema 派生
 * （单一出处），供 assignment.ts 的 studentPaperUnitSchema 复用。
 */
export const studentPaperQuestionSchema = attemptQuestionPublicSchema.partial({
  questionRevisionId: true,
});

/**
 * 草稿视图的单元分组（T2A.7）：题目按所属单元分节下发。
 * assignment 来源按 assignment_units.order 排列（题号全卷连续）；course 来源
 * 恒为单组（单元标题）。T6R.3 起题目来自建卷冻结快照（教师改题库不影响）。
 */
export const attemptDraftUnitSchema = z.object({
  /** 练习单元 id（来自 DSL；wrong 来源为 attemptId——卷无单元语义，仅作分组键） */
  id: z.string().min(1),
  /** 单元标题（当前值；答题页分节标题。wrong 来源恒「错题重练」） */
  title: z.string().min(1),
  /** 该单元的公开题目（冻结快照的 QuestionPublic 投影 + questionRevisionId） */
  questions: z.array(attemptQuestionPublicSchema),
});

/** GET /api/student/attempts/:id 的草稿视图（status=draft）响应 data */
export const attemptDraftDataSchema = z.object({
  attempt: attemptSummarySchema,
  /** 标题（答题页顶部展示）：assignment=作业标题；course=单元标题；wrong=「错题重练」 */
  title: z.string().min(1),
  /**
   * 来源课程名：course 来源恒有值（顶部来源行「课程：xx · 第 n 次」）；
   * assignment 来源自 T2A.7 起有所属课程时返回课程名（来源行「作业 · 课程名」），
   * 无课程为 null；wrong 来源恒 null（来源行「错题重练 · 第 n 次」由前端拼）。
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
  /**
   * 冻结来源不可信标记（T6R.3，方案 §5.1「legacy_unverified」）：true = 本卷
   * 快照是升级后首次恢复访问时懒冻结的当前版本，不能宣称是学生更早看到的
   * 内容——前端据此展示「练习内容为恢复后的版本」提示；false = 建卷即冻结。
   */
  legacyUnverified: z.boolean(),
});

/**
 * 结果视图的单题（题目来自交卷时写入的 questionSnapshotJson）：
 * - snapshot：题目快照的公开形态 + 含答案标记的原始题干（stemMd 为作答时原文）；
 * - answers：参考答案（快照的 QuestionAnswers；题目未给标准答案为 null）；
 * - solutionMd：详解（快照；未提供为 null）；
 * - answer：本人答案（未作为 null）；
 * - autoCorrect：服务端判分结果 true/false；null = 不能自动判定——D1（T3.2a）
 *   后仅三种：手写题未能自动判（未作答/只写笔迹未填最终答案）、题目无标准答案、
 *   判断题写法无法归一化；**未作答客观题（含多选空选）= false**（不再 null）；
 * - teacherMark / teacherComment / finalCorrect（D9，T3.5）：教师批改标记与评语、
 *   最终判定（D3 持久化口径，交卷时 = autoCorrect，批注后 teacherMark 优先）。
 *   三者与 autoCorrect 同受公布 gate（T2A.8）：after_due 截止前一律置 null 投影
 *   （库里保留，截止后恢复），与 scoreAuto 同法；
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
  /** 教师批改标记（D9；未批为 null；公布 gate 截止前置 null 投影） */
  teacherMark: teacherMarkSchema.nullable(),
  /** 教师评语（D9；未评为 null；公布 gate 截止前置 null 投影） */
  teacherComment: z.string().nullable(),
  /** 最终判定（D9；待批为 null；公布 gate 截止前置 null 投影——不下发对错） */
  finalCorrect: z.boolean().nullable(),
  /** 做题时已解锁的提示（按序号升序；未解锁过为空数组） */
  hintsOpened: hintOpenedEntrySchema.array(),
});

/**
 * 结果视图的得分汇总（口径见各字段注释；scoreAuto = correct/autoGradable 的百分比）。
 * D9（T3.5）新增 scoreFinal 与 pendingCount：两者与 scoreAuto 同受公布 gate
 * （T2A.8）——after_due 截止前置 null 投影（待批数不 null 会泄露「有几题没判」
 * 之外的整卷批改进度，且与「待公布」口径冲突，故一并不下发）。
 */
export const attemptScoreSummarySchema = z.object({
  /** 总题数（参与本次作答的题目） */
  total: z.number().int().min(0),
  /** 已作答题数（answer 非 null） */
  answered: z.number().int().min(0),
  /** 自动判对数 */
  correct: z.number().int().min(0),
  /** 自动判错数（D1 后含未作答客观题） */
  wrong: z.number().int().min(0),
  /** 不能自动判定数（autoCorrect=null：手写未自动判/无标准答案/判断写法无法归一化——D1 后不含未作答客观题） */
  pending: z.number().int().min(0),
  /** 未作答题数（answer=null） */
  unanswered: z.number().int().min(0),
  /** 可自动判分题数（autoCorrect 非 null）= correct + wrong */
  autoGradable: z.number().int().min(0),
  /**
   * 最终得分（D9，D2/D3 口径：round(finalCorrect=true 题数 ÷ 全部题数 × 100)；
   * 全部判定完成（graded）才写入，仍有待批为 null；公布 gate 截止前置 null 投影）
   */
  scoreFinal: z.number().int().min(0).max(100).nullable(),
  /**
   * 待批题数（D9，D4 共享谓词：已交卷 attempt 中 finalCorrect IS NULL 的题数，
   * 与 pending（autoCorrect 口径）区分——批注后 autoCorrect 仍空而 finalCorrect
   * 已定，本字段才是「还剩几题没批」的权威计数；公布 gate 截止前置 null 投影）
   */
  pendingCount: z.number().int().min(0).nullable(),
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
  /** 标题（结果页顶部展示）：assignment=作业标题；course=单元标题；wrong=「错题重练」 */
  title: z.string().min(1),
  /**
   * 来源课程名：course 来源恒有值；assignment 来源自 T2A.7 起有所属课程时
   * 返回课程名（「作业 · 课程名」），无课程为 null；wrong 来源恒 null。
   */
  courseName: z.string().nullable(),
  /** 截止时间：UTC ISO；未设置为 null（course 来源恒 null） */
  dueAt: assignmentDueAtSchema.nullable(),
  /**
   * 答案是否已公布（T2A.8，D11）。false = 受限形态（assignment 来源且
   * answerRelease='after_due' 且 now < dueAt，交卷瞬间未到截止同样适用）：
   * - 逐题 answers / solutionMd / autoCorrect 一律 null（不下发参考答案、详解、
   *   对错）；answer（本人答案）与 hintsOpened（本人已解锁提示）照常下发；
   * - D9（T3.5）新增字段 teacherMark / teacherComment / finalCorrect 同法置
   *   null 投影（教师已批也不提前泄露）；
   * - snapshot.stemMd 为 studentStemMd 学生端投影版（[[答案]] 标记替换为 [[]]、
   *   选项任务列表剥除——已公布与受限形态同口径，选项经 options 文本数组下发）；
   * - attempt.scoreAuto 置 null 投影（库里保留，截止后恢复真实值）；
   * - summary 不泄露对错：correct/wrong/autoGradable = 0，pending 按 answered
   *   口径（每道已答题都显示为「待批」），total/answered/unanswered 照常，
   *   scoreFinal / pendingCount 置 null 投影。
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
 * POST /api/student/attempts/:id/submit 请求体（T6R.3 全来源题目版本冻结）：
 * 交卷回传建卷时下发的每题 questionRevisionId（responses 行 id，对学生不透明），
 * 服务端与本次冻结集合逐一比对——旧标签页/陈旧页面的提交（缺项、错版、多项）
 * 被 409 QUESTION_REVISION_STALE 可诊断拒绝（前端提示刷新后重交），不静默接受。
 * 空 revisions 合法（空卷交卷；服务端把不带请求体同样按空集合处理，非空卷
 * 由此自然落入 409）；上限 500 为防御性边界（单卷题数远低于此）。
 */
export const attemptSubmitRevisionSchema = z.object({
  questionId: z.string().min(1),
  questionRevisionId: questionRevisionIdSchema,
});

/**
 * 交卷请求的单题笔记证据声明（T6R.10，方案 §6.4）：
 * - state="frozen"：该题草稿矢量已在服务端，交卷事务把 head 版本固定为
 *   原稿——versionId=客户端所知 head 的 note_versions.id、revision=客户端
 *   预期的当前 head revision（CAS 期望值）；服务端与实际 head 精确比对，
 *   其他标签页/设备改出新 head 则 409 NOTE_EVIDENCE_MISMATCH 拒绝这次
 *   冻结（不静默固定不一致旧版本，方案 §6.4 第 4 步）；
 * - state="none"：该题确实空稿（无笔记行）；与实际 head 有稿矛盾时同样
 *   409——用户未确认不能静默 missing（任务清单 T6R.10 一致性条款）；
 * - state="missing"：草稿矢量未保存完整，**用户已明确选择**「提交答案，
 *   草稿未保存完整」后才允许发送（确认动作在客户端交卷流程，服务端无法
 *   也不重复验证）；本地稿保留，之后找回只能作为 supplement（T6R.15），
 *   不冒称原稿。
 * legacy_unverified 不在声明值域：那是升级遗留进行中稿的服务端降级标记
 * （T6R.3 恢复路径写入），不接受客户端声明。
 */
export const submitEvidenceDeclarationSchema = z
  .object({
    questionId: z.string().min(1),
    state: z.enum(["none", "frozen", "missing"]),
    /** 待固定版本（note_versions.id）；仅 state="frozen" 携带 */
    versionId: z.uuid().optional(),
    /** 客户端预期的当前 head revision（CAS 期望值）；仅 state="frozen" 携带（≥1） */
    revision: z.number().int().min(0).optional(),
  })
  .superRefine((decl, ctx) => {
    if (decl.state === "frozen") {
      if (decl.versionId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["versionId"],
          message: "state='frozen' 必须携带待固定版本 versionId",
        });
      }
      if (decl.revision === undefined || decl.revision < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["revision"],
          message: "state='frozen' 必须携带预期 head revision（≥1）",
        });
      }
      return;
    }
    // none / missing：不得携带版本引用与预期 revision（语义上无服务端 head 对账）
    if (decl.versionId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["versionId"],
        message: `state='${decl.state}' 不得携带版本引用`,
      });
    }
    if (decl.revision !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["revision"],
        message: `state='${decl.state}' 不得携带预期 revision`,
      });
    }
  });

/** 交卷请求体（revisions = 取卷/草稿视图下发过的全部题目版本引用） */
export const attemptSubmitRequestSchema = z.object({
  revisions: z.array(attemptSubmitRevisionSchema).max(500),
  /**
   * 每题笔记证据声明（T6R.10，方案 §6.4 第 3 步——交卷事务固定原稿）。
   * **缺省 = 旧客户端**：服务端检测到该 attempt 存在草稿（notes 表有
   * scratch 行且 head revision>0）时 409 NOTE_EVIDENCE_MISMATCH 拒绝并
   * 要求刷新；确无草稿按兼容规则交卷（不落 submission_evidence 行 =
   * 未采集，与 state='none'〔明确空稿〕区分，见 schema 注释）。
   * 字段存在（新客户端）时必须覆盖卷面全部题目：服务端与冻结题目集合
   * 精确比对（缺项/多项/未知题目同样 409），逐项验证归属与并发状态后
   **同一事务**写 submission_evidence 与成绩/状态——原稿引用写入后不能换。
   */
  evidence: z.array(submitEvidenceDeclarationSchema).max(500).optional(),
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
 * 上，Zod 不支持嵌套判别，用普通 union）。union 之上另加状态-形态一致性校验
 * （superRefine）：草稿独有键（drafts / hintsOpened）与结果独有键（summary /
 * answersReleased）经 union 分支 strip 解析后互斥，据此判定实际命中的分支，
 * 并要求它与 attempt.status 一致——状态与视图错配（如已交卷却命中草稿分支）
 * 整体拒绝，不再静默解析进错误分支。混入的异视图多余键按对象 strip 语义
 * 剥离（fail closed：只少给不多给），不影响本校验。
 */
export const attemptDetailDataSchema = z
  .union([attemptDraftDataSchema, attemptResultDataSchema])
  .superRefine((data, ctx) => {
    // union 解析成功后只可能是两种形态之一：含 drafts/hintsOpened（草稿）或
    // 含 summary/answersReleased（结果）——两键联合判定即可区分命中分支。
    const isDraftShape = "drafts" in data && "hintsOpened" in data;
    if (data.attempt.status === "draft" && !isDraftShape) {
      ctx.addIssue({
        code: "custom",
        path: ["attempt", "status"],
        message:
          "状态-形态不一致：attempt.status=draft 但数据是结果视图形态（应为含 drafts/hintsOpened 的草稿视图）",
      });
    } else if (data.attempt.status !== "draft" && isDraftShape) {
      ctx.addIssue({
        code: "custom",
        path: ["attempt", "status"],
        message:
          "状态-形态不一致：attempt.status 为 submitted/graded 但数据是草稿视图形态（应为含 summary/answersReleased 的结果视图）",
      });
    }
  });

/**
 * 作答模块错误码（UPPER_SNAKE_CODE 固定子集）：
 * - ASSIGNMENT_NOT_FOUND：创建 attempt 的作业不存在（含已删除）（404）；
 * - ATTEMPT_NOT_FOUND：attempt 不存在（404）；
 * - ALREADY_SUBMITTED：attempt 已交卷，不能再保存草稿 / 重复交卷（409，验收项）；
 * - QUESTION_REVISION_STALE：交卷回传的题目版本集合与本次冻结集合不一致
 *   （缺项 / questionRevisionId 错版 / 多出未知题目 / 未带请求体的非空卷；
 *   409，T6R.3）——旧标签页或陈旧页面的提交被可诊断拒绝，前端提示刷新后重交；
 * - QUESTION_NOT_FOUND：题目不存在、已软删或不在该次作答的单元集合内（404，
 *   T2A.7 起多单元作业为集合包含判断）；
 * - HINT_INDEX_OUT_OF_RANGE：提示序号越界（<0 或 ≥该题提示总数，含无提示题；
 *   400，T2.11 验收项）；
 * - FORBIDDEN：非本人 attempt / 未被指派的作业（403）；
 * - WRONG_PRACTICE_EMPTY：错题重练组卷的 questionIds 经校验全部被剔除
 *   （不在错题本聚合内或快照不可用；400，2026-10，附中文说明）；
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
  "QUESTION_REVISION_STALE",
  "QUESTION_NOT_FOUND",
  "HINT_INDEX_OUT_OF_RANGE",
  "FORBIDDEN",
  "WRONG_PRACTICE_EMPTY",
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
/** attempt 视图公开题目（QuestionPublic + questionRevisionId，T6R.3） */
export type AttemptQuestionPublic = z.infer<typeof attemptQuestionPublicSchema>;
/** 题目版本引用（T6R.3；随 schema 自 note.ts 移入本文件） */
export type QuestionRevisionId = z.infer<typeof questionRevisionIdSchema>;
/** 试卷题目的可选版本形态（仅通用取卷携带 revisionId） */
export type StudentPaperQuestion = z.infer<typeof studentPaperQuestionSchema>;
export type AttemptResultQuestion = z.infer<typeof attemptResultQuestionSchema>;
export type AttemptResultUnit = z.infer<typeof attemptResultUnitSchema>;
export type AttemptScoreSummary = z.infer<typeof attemptScoreSummarySchema>;
export type AttemptResultData = z.infer<typeof attemptResultDataSchema>;
export type AttemptAnswerSaveRequest = z.infer<
  typeof attemptAnswerSaveRequestSchema
>;
export type AttemptAnswerSaveData = z.infer<typeof attemptAnswerSaveDataSchema>;
/** 交卷回传的单题版本对（T6R.3；questionRevisionId = responses 行 id，不透明） */
export type AttemptSubmitRevision = z.infer<typeof attemptSubmitRevisionSchema>;
/** 交卷请求的单题笔记证据声明（T6R.10） */
export type SubmitEvidenceDeclaration = z.infer<
  typeof submitEvidenceDeclarationSchema
>;
/** 交卷请求体（T6R.3；T6R.10 增可选 evidence——缺省=旧客户端） */
export type AttemptSubmitRequest = z.infer<typeof attemptSubmitRequestSchema>;
export type HintOpenedEntry = z.infer<typeof hintOpenedEntrySchema>;
export type HintOpenRequest = z.infer<typeof hintOpenRequestSchema>;
export type HintOpenData = z.infer<typeof hintOpenDataSchema>;
export type AttemptErrorCode = z.infer<typeof attemptErrorCodeSchema>;
/** 错题重练组卷请求（2026-10） */
export type WrongPracticeRequest = z.infer<typeof wrongPracticeRequestSchema>;
/** 详情响应 data：草稿视图或结果视图（服务端按 attempt.status 返回其一） */
export type AttemptDetailData = z.infer<typeof attemptDetailDataSchema>;

// ---------- 与作业状态的关系 ----------

/**
 * attempt 状态 → 学生作业列表四态的推导在服务端纯函数 computeAssignmentStatus
 * （assignment-service，T2.2 预留）：graded > submitted > draft > not_started。
 * 本文件的 AttemptStatus（库三态）与 assignment.ts 的 AssignmentStatus（学生端
 * 四态）在此声明对应关系，避免两处枚举各自漂移。
 */
