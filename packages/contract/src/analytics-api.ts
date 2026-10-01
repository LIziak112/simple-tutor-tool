import { z } from "zod";
import { questionTypeSchema } from "./content.ts";

/**
 * 学情分析 API 契约（T4.1 起为权威定义，依据 Phase4 清单 §2 D1–D7 与架构
 * 文档 §5.8）：GET /api/teacher/analytics/overview（总览）、
 * GET /api/teacher/analytics/student/:id（学生画像）、
 * GET /api/teacher/analytics/questions（题目视角）。
 *
 * 判分与统计口径链（Phase 3 定稿，本契约只读不重算）：
 * autoCorrect（未作答客观题=false）→ teacherMark（教师批改优先）→
 * **finalCorrect（统计唯一口径）** → scoreFinal（分母=全部题）。
 *
 * D1–D7 落点（逐条，服务端实现必须与本注释一致）：
 * - **D1 统计口径总则**：全部指标以 finalCorrect 为准；**作业取全部作答、
 *   课程练习默认取首次作答（attemptNo=1）**；重做次数作为独立指标单独展示
 *   （矩阵单元格 attemptCount/redoCount、画像 redo 列表；重做不重复计入
 *   趋势/考点/题目统计的分母）；
 * - **D2 完成矩阵范围**：学生 × **布置的作业 + 可见课程单元**；列状态 =
 *   未指派(not-assigned) / 未开始(not-started) / 进行中(in-progress=存在
 *   draft) / 已交(submitted) / 已批(graded)；课程单元列含做过次数
 *   （attemptCount，含未交草稿与全部重做）与**首次得分**（firstScore=
 *   首个已交卷的 scoreFinal ?? scoreAuto，展示口径与 T2A.6 一致）；
 * - **D3 课程维度**：courseId 查询参数筛选（缺省=全部）；作业列按
 *   assignments.courseId 命中，课程练习/讲义按 attempts/events 归属课程命中；
 *   不做独立「课程学情页」；
 * - **D4 待批题口径**：finalCorrect=null 的题**不计入正确率分母**，单独计
 *   待批数（正确率 = 判对 ÷ 已判定题数；与 scoreFinal 分母=全部题是两个并列
 *   口径——scoreFinal 是「这份卷子的得分」，correctRate 是「已判定题的对率」）；
 * - **D5 时间口径**：days 查询参数（默认 30 天，快捷 7/30/90/全部）按
 *   **submittedAt**（自然周趋势同一时间轴）过滤参与统计的作答；周趋势按
 *   **自然周（Asia/Shanghai、周一起算、取 submittedAt）**分桶；「下节课重点」
 *   周期 focusDays 默认 14 天、页面可调；完成矩阵是当下状态一览（谁没做），
 *   不按 days 过滤——格子的进行中/已交/已批由该生该列的全部作答决定；
 * - **D6 用时异常题**：activeSec > 该题用时中位数 2 倍 **或** hintsUsed ≥ 2；
 *   中位数按**本教师域内该题全部已交作答**（不受 days/D1 限制）计算；
 * - **D7 教师域**：全部查询按会话教师隔离（attempt → student → teacherId）；
 *   学生不属于本教师 → 404 STUDENT_NOT_FOUND（不暴露存在性，T2B 口径）。
 *
 * 红线（Phase4 清单 §0.3 / D13）：学情响应**不包含任何 events 原始行**——
 * 离线作答占比、讲义阅读地图均为服务端聚合后的派生指标（T4.0b 纯函数输出）。
 *
 * 约定（与 teacher-attempt-api.ts 一致）：本文件只定义查询参数与 data 部分，
 * 成功壳由局部 helper 具体化（避免循环依赖）；时间一律 UTC ISO 字符串；
 * 教师端不受 AGENTS.md 第 3 条泄露约束（题目统计的题干取已交卷快照原文）。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/** 学情页时间范围默认值（D5：最近 30 天） */
export const ANALYTICS_DAYS_DEFAULT = 30;
/** 「下节课重点」周期默认值（D5：14 天，页面可调） */
export const ANALYTICS_FOCUS_DAYS_DEFAULT = 14;
/** 高频错误答案分布的条目上限（填空/选择/多选错误答案值 top N） */
export const ANALYTICS_WRONG_ANSWER_TOP_N = 5;

/**
 * 三接口共用的查询参数（全部可选）：
 * - courseId（D3）：按课程筛选，缺省=全部。作业按 assignments.courseId 命中
 *   （未挂课程的作业在筛选时排除）；课程练习/讲义按归属课程命中；
 * - days（D5）：时间范围，取值 = 正整数天数或 "all"（全部）。字符串查询参数
 *   经 coerce 解析（"30" → 30）；口径 = [now - days, now] 内 **submittedAt**
 *   的作答参与统计（趋势/考点/题目/异常/重点/重做/离线/阅读地图）；完成矩阵
 *   不受其影响（见文件头 D5 注释）。缺省 30；
 * - focusDays（D5）：「下节课重点」周期（天），缺省 14；与 days 独立
 *   （重点卡片看的是「最近一个教学周期」的错误，与页面时间范围解耦）。
 */
export const analyticsQuerySchema = z.object({
  courseId: z.uuid("courseId 必须是 UUID 格式").optional(),
  days: z
    .union([
      z.coerce
        .number()
        .int("days 必须是整数天数")
        .min(1, "days 最小为 1")
        .max(3650, "days 最大为 3650"),
      z.literal("all"),
    ])
    .default(ANALYTICS_DAYS_DEFAULT),
  focusDays: z.coerce
    .number()
    .int("focusDays 必须是整数")
    .min(1, "focusDays 最小为 1")
    .max(365, "focusDays 最大为 365")
    .default(ANALYTICS_FOCUS_DAYS_DEFAULT),
});

/**
 * 实际生效的时间窗口（响应回显，前端展示与调试用）：
 * from = now - days（days="all" 时为 null=不设下限）；to = 请求时刻。
 * 完成矩阵虽不受 days 过滤，但窗口含义对全部指标统一声明在此。
 */
export const analyticsRangeSchema = z.object({
  /** 请求的 days 原样回显（数字或 "all"） */
  days: z.union([z.number().int().min(1), z.literal("all")]),
  /** 窗口下界：UTC ISO；days="all" 时为 null（全部） */
  from: z.string().nullable(),
  /** 窗口上界：UTC ISO（请求时刻） */
  to: z.string().min(1),
});

// ---------- 完成矩阵（D2） ----------

/** 矩阵/画像的学生行（含已归档——教师侧保留统计视角，与 T2A.6 一致） */
export const analyticsStudentRowSchema = z.object({
  studentId: z.uuid(),
  displayName: z.string().min(1),
  /** 是否已归档 */
  archived: z.boolean(),
});

/** 作业列（教师布置的作业；courseId 筛选时只保留挂该课程的作业，D3） */
export const analyticsAssignmentColumnSchema = z.object({
  assignmentId: z.uuid(),
  /** 作业标题（布置时快照） */
  title: z.string().min(1),
  /** 截止时间：UTC ISO；未设置为 null */
  dueAt: z.string().nullable(),
  /** 所属课程 id；未挂课程为 null */
  courseId: z.uuid().nullable(),
  /** 课程名（当前值）；未挂课程为 null */
  courseName: z.string().nullable(),
});

/** 课程单元列（对学生可见的单元条目，可见性口径与 T2A.6 进度矩阵一致） */
export const analyticsUnitColumnSchema = z.object({
  courseId: z.uuid(),
  courseName: z.string().min(1),
  unitId: z.string().min(1),
  unitTitle: z.string().min(1),
  /** 目录条目顺序（列顺序） */
  order: z.number().int().min(0),
});

/**
 * 矩阵单元格状态（作业列与课程单元列共用一枚举）：
 * - not-assigned：该学生不在作业名单 / 不是课程成员（前端渲染「—」，
 *   与「未开始」区分——未指派不是没完成）；
 * - not-started：已指派但从无 attempt；
 * - in-progress：存在未交卷 draft；
 * - submitted：已交卷且仍有待批题（status=submitted）；
 * - graded：全部判定完成（status=graded）。
 * 课程单元列取该生该单元全部 course 来源作答的最优状态
 * （draft 存在即 in-progress；否则按最近一次已交卷状态）。
 */
export const analyticsCellStatusSchema = z.enum([
  "not-assigned",
  "not-started",
  "in-progress",
  "submitted",
  "graded",
]);

/** 作业列单元格（该生 × 该作业） */
export const analyticsAssignmentCellSchema = z.object({
  kind: z.literal("assignment"),
  studentId: z.uuid(),
  assignmentId: z.uuid(),
  status: analyticsCellStatusSchema,
  /** 该生此作业的 attempt id（点击跳作答详情用）；从未开卷为 null */
  attemptId: z.uuid().nullable(),
  /** 最近一次交卷时间：UTC ISO；未交卷为 null */
  submittedAt: z.string().nullable(),
});

/**
 * 课程单元列单元格（该生 × 该（课程,单元））：
 * attemptCount=做过次数（全部 course 作答，含未交草稿与重做，D2）；
 * redoCount=重做次数（attemptCount-1，独立指标 D1）；
 * firstScore=首次得分（首个已交卷的 scoreFinal ?? scoreAuto；从未交卷为 null，D1）；
 * pendingCount=待批数（D4 共享谓词，聚合该单元全部已交卷作答）。
 */
export const analyticsUnitCellSchema = z.object({
  kind: z.literal("course-unit"),
  studentId: z.uuid(),
  courseId: z.uuid(),
  unitId: z.string().min(1),
  status: analyticsCellStatusSchema,
  /** 做过次数（含草稿与重做） */
  attemptCount: z.number().int().min(0),
  /** 重做次数（独立指标，D1） */
  redoCount: z.number().int().min(0),
  /** 首次得分（D1：首个已交卷的 scoreFinal ?? scoreAuto，0–100） */
  firstScore: z.number().int().min(0).max(100).nullable(),
  /** 待批数（D4 共享谓词；含全部历次已交卷） */
  pendingCount: z.number().int().min(0),
  /** 最近一次交卷时间：UTC ISO；从未交卷为 null */
  latestSubmittedAt: z.string().nullable(),
});

/** 完成矩阵（D2）：行=学生、列=作业 + 可见课程单元，单元格稠密给出 */
export const analyticsMatrixSchema = z.object({
  students: z.array(analyticsStudentRowSchema),
  assignmentColumns: z.array(analyticsAssignmentColumnSchema),
  unitColumns: z.array(analyticsUnitColumnSchema),
  /** 全部 学生×列 的稠密单元格（按 kind 判别） */
  cells: z.array(
    z.discriminatedUnion("kind", [
      analyticsAssignmentCellSchema,
      analyticsUnitCellSchema,
    ]),
  ),
});

// ---------- 周趋势（D5） ----------

/**
 * 总正确率周趋势的一个自然周桶（Asia/Shanghai、周一起算、按 submittedAt）：
 * - weekStart：该周周一的北京日期（YYYY-MM-DD，日历日本地时区语义）；
 * - attemptCount：该周提交的作答份数（D1：作业全部 + 课程练习仅首次）；
 * - judgedCount/correctCount：该周全部作答中已判定/判对的**题数**（D4：待批
 *   不进分母）；correctRate = correct ÷ judged，无已判定题为 null；
 * - 桶按周连续生成（无数据的周也出现，attemptCount=0），便于折线图绘制。
 */
export const analyticsTrendPointSchema = z.object({
  /** 该周周一的北京日期（YYYY-MM-DD） */
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  attemptCount: z.number().int().min(0),
  judgedCount: z.number().int().min(0),
  correctCount: z.number().int().min(0),
  /** 正确率（D4 口径：判对 ÷ 已判定）；无已判定题为 null */
  correctRate: z.number().min(0).max(1).nullable(),
});

// ---------- 下节课重点卡片（D5 focusDays） ----------

/**
 * 重点考点的代表错题（周期内该考点错误次数最多的题；同次数取最近提交）：
 * 题干取该次作答的 questionSnapshotJson 快照原文（教师端不受泄露约束）。
 */
export const analyticsFocusQuestionSchema = z.object({
  questionId: z.string().min(1),
  /** 题干 Markdown（快照原文，含 [[答案]] 标记） */
  stemMd: z.string(),
  type: questionTypeSchema,
  difficulty: z.number().int().min(1).max(5),
  knowledge: z.array(z.string().min(1)),
  /** 代表性作答所属 attempt（点击跳作答详情） */
  attemptId: z.uuid(),
  studentId: z.uuid(),
  studentName: z.string().min(1),
  /** 该生的错误答案（人类可读序列化；未作为 null） */
  answerText: z.string().nullable(),
  /** 该次提交时间：UTC ISO */
  submittedAt: z.string().min(1),
});

/** 重点考点行（周期内错误最多的考点，最多 3 行） */
export const analyticsFocusPointSchema = z.object({
  knowledge: z.string().min(1),
  /** 周期内该考点的判错题次（D1 口径作答） */
  wrongCount: z.number().int().min(0),
  /** 周期内该考点的已判定题次 */
  judgedCount: z.number().int().min(0),
  /** 正确率（D4 口径）；judgedCount=0 为 null */
  correctRate: z.number().min(0).max(1).nullable(),
  /** 代表错题（wrongCount=0 的考点不会出现，故恒非空） */
  representative: analyticsFocusQuestionSchema,
});

/** 「下节课重点」卡片：错误最多 3 考点 + 代表错题（D5：周期默认 14 天可调） */
export const analyticsFocusCardSchema = z.object({
  /** 周期天数（请求值回显） */
  focusDays: z.number().int().min(1),
  /** 周期下界：UTC ISO（now - focusDays） */
  from: z.string().min(1),
  /** 按错误次数降序（同次数按考点名升序兜底稳定），最多 3 行 */
  points: z.array(analyticsFocusPointSchema),
});

// ---------- 离线作答占比（T4.0 聚合消费） ----------

/**
 * 离线作答占比（D10/D13：服务端按 net_offline/net_online 标记与 focus 区间
 * 交集聚合，原始 events 不出库）：统计范围内全部已交卷 attempt 的
 * Σ(离线焦点时长) ÷ Σ(activeSec)（按题累计，activeSec 权重聚合；
 * 无任何可用 activeSec 时 share=0）。offlineSecTotal 由每题 share×activeSec
 * 反推的合计（展示「离线作答 X 分钟 / 有效作答 Y 分钟」用）。
 */
export const analyticsOfflineSchema = z.object({
  /** 离线作答时长占比 ∈ [0,1]；无数据为 0 */
  offlineShare: z.number().min(0).max(1),
  /** 有效作答总时长（秒；统计范围内有事件证据的题） */
  activeSecTotal: z.number().int().min(0),
  /** 其中离线状态下的作答时长（秒，share×activeSec 的合计） */
  offlineSecTotal: z.number().min(0),
});

// ---------- 总览响应 ----------

/**
 * GET /api/teacher/analytics/overview 响应 data（总览页）：
 * 完成矩阵 + 周趋势（全域）+ 下节课重点 + 关键计数 + 离线占比 + 重做计数。
 * pendingMarkCount 不受 days 限制（待批是当下批改工作队列——旧作业的待批
 * 同样要批），受 courseId 筛选；redoCount = 周期内发生的课程练习重做次数
 * （attemptNo>1 且 submittedAt 落窗，D1）。
 */
export const analyticsOverviewDataSchema = z.object({
  range: analyticsRangeSchema,
  focusDays: z.number().int().min(1),
  matrix: analyticsMatrixSchema,
  trend: z.array(analyticsTrendPointSchema),
  focus: analyticsFocusCardSchema,
  /** 域内待批题总数（D4 共享谓词；不受 days 影响，受 courseId 筛选） */
  pendingMarkCount: z.number().int().min(0),
  /** 域内学生数（含已归档；受 courseId 筛选=该课程成员数） */
  studentCount: z.number().int().min(0),
  /** 周期内发生的课程练习重做次数（D1） */
  redoCount: z.number().int().min(0),
  offline: analyticsOfflineSchema,
  /** 周期内全域汇总（D4 口径） */
  overall: z.object({
    judgedCount: z.number().int().min(0),
    correctCount: z.number().int().min(0),
    correctRate: z.number().min(0).max(1).nullable(),
  }),
});

// ---------- 学生画像 ----------

/** 学生 × 考点正确率行（D1 口径作答；D4：待批单独计数不进分母） */
export const analyticsKnowledgeRowSchema = z.object({
  knowledge: z.string().min(1),
  correctCount: z.number().int().min(0),
  wrongCount: z.number().int().min(0),
  /** 待批数（finalCorrect=null 的题次；不计入正确率分母，D4） */
  pendingCount: z.number().int().min(0),
  /** 已判定题次（correct + wrong） */
  judgedCount: z.number().int().min(0),
  /** 正确率 = correct ÷ judged；无已判定题为 null */
  correctRate: z.number().min(0).max(1).nullable(),
});

/**
 * 用时异常题（D6）：activeSec > 该题用时中位数 2 倍（reasons 含 "slow"）
 * 或 hintsUsed ≥ 2（reasons 含 "hints"）；中位数按本教师域内该题全部已交
 * 作答计算（不受 days/D1 限制）。multipleOfMedian = activeSec ÷ medianSec
 * （无中位数为 null）。
 */
export const analyticsAnomalyQuestionSchema = z.object({
  /** 异常作答所属 attempt（点击跳作答详情） */
  attemptId: z.uuid(),
  questionId: z.string().min(1),
  /** 题干 Markdown（快照原文） */
  stemMd: z.string(),
  type: questionTypeSchema,
  difficulty: z.number().int().min(1).max(5),
  knowledge: z.array(z.string().min(1)),
  /** 本题有效用时（秒；未计算为 null） */
  activeSec: z.number().int().min(0).nullable(),
  /** 该题用时中位数（秒；域内已交作答，无样本为 null） */
  medianSec: z.number().min(0).nullable(),
  /** activeSec ÷ medianSec（四舍五入 2 位；缺中位数为 null） */
  multipleOfMedian: z.number().min(0).nullable(),
  /** 已解锁提示数 */
  hintsUsed: z.number().int().min(0),
  /** 命中的异常原因（slow=超中位数 2 倍；hints=提示数≥2） */
  reasons: z.array(z.enum(["slow", "hints"])),
  /** 该次提交时间：UTC ISO */
  submittedAt: z.string().min(1),
});

/** 画像页重做概览行（独立指标 D1；不受 days 限制——重做是该生的结构性事实） */
export const analyticsRedoRowSchema = z.object({
  courseId: z.uuid().nullable(),
  courseName: z.string().nullable(),
  unitId: z.string().min(1),
  unitTitle: z.string().min(1),
  /** 做过次数（全部 course 作答，含未交草稿） */
  attemptCount: z.number().int().min(1),
  /** 重做次数（attemptCount - 1） */
  redoCount: z.number().int().min(0),
  /** 首次得分（D1；从未交卷为 null） */
  firstScore: z.number().int().min(0).max(100).nullable(),
  /** 最近一次交卷时间：UTC ISO；从未交卷为 null */
  latestSubmittedAt: z.string().nullable(),
});

/**
 * 学生画像页的错题行（T4.2 起随学生画像下发，编排在 T4.1 契约内）：
 * - 口径（D1/D4/D5）：该生在 qualifying 作答（D1：作业全部 + 课程练习首次，
 *   且 submittedAt 落 days 窗口）中 finalCorrect=**false** 的逐题行——待批
 *   （null）**不在列表**（待批经 totals.pendingCount 与矩阵展示）；
 * - 同一题多次判错（如多次作业引用同一单元）取**最新一次** qualifying 作答为
 *   代表：attemptId 即该次作答（点击跳 T3.1 作答详情），answerText 为该次
 *   错误答案（未作为 null——Phase3 D1 未作答判错）；
 * - 题干/题型/难度/考点取该次作答的 questionSnapshotJson 快照原文（与题目
 *   视角同源；快照缺失按当前库 questionMeta 兜底）；
 * - 排序按提交时间倒序（同刻按 attemptId、questionId 降序兜底稳定），
 *   上限 200 条（一对一规模防御，超出只保留最近的）。
 */
export const analyticsWrongQuestionRowSchema = z.object({
  questionId: z.string().min(1),
  /** 所属单元 id（当前库值；题已软删/移出时为 null） */
  unitId: z.string().min(1).nullable(),
  /** 单元标题（当前库值；题已软删/移出时为 null） */
  unitTitle: z.string().min(1).nullable(),
  type: questionTypeSchema,
  difficulty: z.number().int().min(1).max(5),
  knowledge: z.array(z.string().min(1)),
  /** 题干 Markdown（快照原文，含 [[答案]] 标记） */
  stemMd: z.string(),
  /** 代表作答所属 attempt（点击跳作答详情） */
  attemptId: z.uuid(),
  /** 该次的错误答案（人类可读序列化；未作为 null） */
  answerText: z.string().nullable(),
  /** 该次提交时间：UTC ISO */
  submittedAt: z.string().min(1),
});

// ---------- 讲义阅读地图（T4.0b 聚合输出镜像，画像页直接渲染） ----------

/** 节状态（阈值口径见服务端 TRACE_THRESHOLDS；全部为时间代理的行为推断） */
export const analyticsSectionStatusSchema = z.enum([
  "not-reached",
  "skimmed",
  "partial",
  "read",
  "deep",
]);

/** 阅读地图的节行（H2/H3 逐节） */
export const analyticsLectureSectionRowSchema = z.object({
  headingIndex: z.number().int().min(0),
  level: z.union([z.literal(2), z.literal(3)]),
  text: z.string().min(1),
  reached: z.boolean(),
  /** 可见 ∩ 聚焦的原始停留（秒；未扣 idle，教师端可见「含挂机」） */
  rawDwellSec: z.number().int().min(0),
  /** 再扣 idle 后的有效停留（秒） */
  dwellSec: z.number().int().min(0),
  /** 按内容量估计的预期阅读秒数 */
  expectedSec: z.number().int().min(1),
  status: analyticsSectionStatusSchema,
});

/** 折叠指令状态 */
export const analyticsFoldStatusSchema = z.enum([
  "not-opened",
  "opened-unread",
  "read",
]);

/** 阅读地图的折叠指令行（hint/solution/fold/example 内嵌 solution） */
export const analyticsLectureFoldRowSchema = z.object({
  /** 文档全局指令序号（directive_interact 的 index 口径） */
  docIndex: z.number().int().min(0),
  name: z.string().min(1),
  hostHeadingIndex: z.number().int().min(0),
  opened: z.boolean(),
  openCount: z.number().int().min(0),
  /** 首次展开距该节聚焦开始的秒数；该节未聚焦过为 null */
  firstOpenOffsetSec: z.number().int().min(0).nullable(),
  rawDwellSec: z.number().int().min(0),
  dwellSec: z.number().int().min(0),
  expectedSec: z.number().int().min(1),
  status: analyticsFoldStatusSchema,
});

/** steps 容器状态 */
export const analyticsStepsStatusSchema = z.enum([
  "not-started",
  "rush-skipped",
  "step-by-step",
  "incomplete",
]);

/** 阅读地图的 steps 容器行 */
export const analyticsLectureStepsRowSchema = z.object({
  docIndex: z.number().int().min(0),
  hostHeadingIndex: z.number().int().min(0),
  revealedCount: z.number().int().min(0),
  total: z.number().int().min(0),
  /** 相邻 reveal 的间隔（秒，升序） */
  paceSec: z.array(z.number().int().min(0)),
  status: analyticsStepsStatusSchema,
});

/** 阅读地图汇总（从地图求和；口径见服务端 lecture-insights） */
export const analyticsLectureMapSummarySchema = z.object({
  readSec: z.number().int().min(0),
  totalVisibleSec: z.number().int().min(0),
  sectionCoverage: z.number().min(0).max(1),
  foldOpenRate: z.number().min(0).max(1),
  hintOpenCount: z.number().int().min(0),
  solutionOpenCount: z.number().int().min(0),
  stepsRushContainerCount: z.number().int().min(0),
  stepsTotalContainers: z.number().int().min(0),
  stepsOverallMedianPaceSec: z.number().nullable(),
  /** 版本错位（只计总时长、不定位）的定位类事件数 */
  degradedEventCount: z.number().int().min(0),
});

/** 一篇讲义的阅读地图（T4.0b computeLectureReadingMap 输出的契约镜像） */
export const analyticsLectureReadingMapSchema = z.object({
  sections: z.array(analyticsLectureSectionRowSchema),
  folds: z.array(analyticsLectureFoldRowSchema),
  steps: z.array(analyticsLectureStepsRowSchema),
  summary: analyticsLectureMapSummarySchema,
});

/** 画像页的讲义阅读条目（学生读过/存在事件的讲义才出现） */
export const analyticsLectureMapEntrySchema = z.object({
  lectureId: z.uuid(),
  title: z.string().min(1),
  /** 讲义当前版本时间（地图判定的版本基准）：UTC ISO */
  updatedAt: z.string().min(1),
  map: analyticsLectureReadingMapSchema,
});

/**
 * GET /api/teacher/analytics/student/:id 响应 data（学生画像页）：
 * 该生的周趋势、考点正确率、异常题、重做概览、离线占比、讲义阅读地图与
 * 错题列表（T4.2 起）。
 * 学生不属于本教师 → 404 STUDENT_NOT_FOUND（D7，不暴露存在性）。
 * redo 不受 days 限制（结构性事实）；其余指标按 days 窗口。
 */
export const analyticsStudentDataSchema = z.object({
  studentId: z.uuid(),
  studentName: z.string().min(1),
  archived: z.boolean(),
  range: analyticsRangeSchema,
  trend: z.array(analyticsTrendPointSchema),
  /** 考点行按错误数降序（薄弱在前；同数按考点名升序兜底稳定） */
  knowledge: z.array(analyticsKnowledgeRowSchema),
  /** 周期内该生汇总（D4 口径） */
  totals: z.object({
    judgedCount: z.number().int().min(0),
    correctCount: z.number().int().min(0),
    pendingCount: z.number().int().min(0),
    correctRate: z.number().min(0).max(1).nullable(),
  }),
  /** 用时异常题（D6；按提交时间倒序） */
  anomalies: z.array(analyticsAnomalyQuestionSchema),
  /** 重做概览（D1 独立指标；该生全部课程练习单元） */
  redo: z.array(analyticsRedoRowSchema),
  /**
   * 错题列表（T4.2：qualifying 中 finalCorrect=false 的逐题行；待批 null 不在
   * 列表；同题多次判错取最新一次代表作答；提交时间倒序，上限 200 条——口径
   * 详见 analyticsWrongQuestionRowSchema 注释）
   */
  wrongQuestions: z.array(analyticsWrongQuestionRowSchema),
  /** 离线作答占比（窗口内该生已交卷 attempt 聚合） */
  offline: analyticsOfflineSchema,
  /** 讲义阅读地图（该生有阅读事件的讲义；courseId 筛选时只含该课程讲义） */
  lectures: z.array(analyticsLectureMapEntrySchema),
});

// ---------- 题目视角 ----------

/** 高频错误答案分布条目（answerText=null 表示「未作答」） */
export const analyticsWrongAnswerSchema = z.object({
  /** 错误答案（人类可读序列化；null=未作答——Phase3 D1 判错口径） */
  answerText: z.string().nullable(),
  count: z.number().int().min(0),
});

/**
 * 题目统计行（题目视角）：
 * - 口径（D1/D4）：作业全部 + 课程练习首次；正确率=判对÷已判定，待批单独计；
 * - avgSec/medianSec：该题统计范围内已交作答 activeSec 的均值/中位数（秒；
 *   无任何可用样本为 null）；
 * - medianSec 口径与 D6 异常判定**不同**：此处受 days/D1 限制（页面统计），
 *   D6 中位数不受限（域内全部已交作答）——两个口径并存，各自注释；
 * - wrongAnswers：finalCorrect=false 的答案值分布 top N（填空/选择/多选；
 *   judge 恒为「错误」无分布意义、手写题为文本不聚合，均不含）；
 * - anomalyCount：命中 D6 的作答数（slow 或 hints）；
 * - 题干取最近一次提交的 questionSnapshotJson 快照原文。
 */
export const analyticsQuestionRowSchema = z.object({
  questionId: z.string().min(1),
  /** 所属单元 id（当前库值；题目已软删/移出时按快照兜底） */
  unitId: z.string().min(1).nullable(),
  unitTitle: z.string().min(1).nullable(),
  type: questionTypeSchema,
  difficulty: z.number().int().min(1).max(5),
  knowledge: z.array(z.string().min(1)),
  /** 题干 Markdown（最近一次提交的快照原文，含 [[答案]] 标记） */
  stemMd: z.string(),
  /** 统计范围内的提交题次（含待批） */
  submittedCount: z.number().int().min(0),
  judgedCount: z.number().int().min(0),
  correctCount: z.number().int().min(0),
  /** 待批数（D4） */
  pendingCount: z.number().int().min(0),
  correctRate: z.number().min(0).max(1).nullable(),
  avgSec: z.number().min(0).nullable(),
  /** 页面统计口径的中位数（受 days/D1 限制；D6 异常判定另用全域口径） */
  medianSec: z.number().min(0).nullable(),
  /** 命中 D6（全域中位数口径）的作答数 */
  anomalyCount: z.number().int().min(0),
  /** 高频错误答案（top N；仅 fill/choice/multi） */
  wrongAnswers: z.array(analyticsWrongAnswerSchema),
  /** 最近一次提交时间：UTC ISO */
  lastSubmittedAt: z.string().nullable(),
});

/** GET /api/teacher/analytics/questions 响应 data（题目视角页） */
export const analyticsQuestionsDataSchema = z.object({
  range: analyticsRangeSchema,
  /** 按单元内题序（当前库 order，快照兜底行追加在末尾）、questionId 升序稳定 */
  questions: z.array(analyticsQuestionRowSchema),
});

// ---------- 错误码 ----------

/**
 * 学情分析错误码（UPPER_SNAKE_CODE 固定子集）：
 * - STUDENT_NOT_FOUND：画像页学生不存在或非本教师学生（404，不暴露存在性，
 *   T2B 域隔离口径）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义（401 / 400）。
 */
export const analyticsErrorCodeSchema = z.enum([
  "STUDENT_NOT_FOUND",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

// ---------- 具体化的成功壳 ----------

/** 携带学情总览的成功响应壳 */
export const analyticsOverviewOkSchema = apiOkExtend(
  analyticsOverviewDataSchema,
);
/** 携带学生画像的成功响应壳 */
export const analyticsStudentOkSchema = apiOkExtend(analyticsStudentDataSchema);
/** 携带题目统计的成功响应壳 */
export const analyticsQuestionsOkSchema = apiOkExtend(
  analyticsQuestionsDataSchema,
);

// ---------- 推断类型导出 ----------

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;
export type AnalyticsStudentRow = z.infer<typeof analyticsStudentRowSchema>;
export type AnalyticsAssignmentColumn = z.infer<
  typeof analyticsAssignmentColumnSchema
>;
export type AnalyticsUnitColumn = z.infer<typeof analyticsUnitColumnSchema>;
export type AnalyticsCellStatus = z.infer<typeof analyticsCellStatusSchema>;
export type AnalyticsAssignmentCell = z.infer<
  typeof analyticsAssignmentCellSchema
>;
export type AnalyticsUnitCell = z.infer<typeof analyticsUnitCellSchema>;
export type AnalyticsMatrix = z.infer<typeof analyticsMatrixSchema>;
export type AnalyticsTrendPoint = z.infer<typeof analyticsTrendPointSchema>;
export type AnalyticsFocusQuestion = z.infer<
  typeof analyticsFocusQuestionSchema
>;
export type AnalyticsFocusPoint = z.infer<typeof analyticsFocusPointSchema>;
export type AnalyticsFocusCard = z.infer<typeof analyticsFocusCardSchema>;
export type AnalyticsOffline = z.infer<typeof analyticsOfflineSchema>;
export type AnalyticsOverviewData = z.infer<typeof analyticsOverviewDataSchema>;
export type AnalyticsKnowledgeRow = z.infer<typeof analyticsKnowledgeRowSchema>;
export type AnalyticsAnomalyQuestion = z.infer<
  typeof analyticsAnomalyQuestionSchema
>;
export type AnalyticsRedoRow = z.infer<typeof analyticsRedoRowSchema>;
export type AnalyticsWrongQuestionRow = z.infer<
  typeof analyticsWrongQuestionRowSchema
>;
export type AnalyticsSectionStatus = z.infer<
  typeof analyticsSectionStatusSchema
>;
export type AnalyticsLectureSectionRow = z.infer<
  typeof analyticsLectureSectionRowSchema
>;
export type AnalyticsFoldStatus = z.infer<typeof analyticsFoldStatusSchema>;
export type AnalyticsLectureFoldRow = z.infer<
  typeof analyticsLectureFoldRowSchema
>;
export type AnalyticsStepsStatus = z.infer<typeof analyticsStepsStatusSchema>;
export type AnalyticsLectureStepsRow = z.infer<
  typeof analyticsLectureStepsRowSchema
>;
export type AnalyticsLectureMapSummary = z.infer<
  typeof analyticsLectureMapSummarySchema
>;
export type AnalyticsLectureReadingMap = z.infer<
  typeof analyticsLectureReadingMapSchema
>;
export type AnalyticsLectureMapEntry = z.infer<
  typeof analyticsLectureMapEntrySchema
>;
export type AnalyticsStudentData = z.infer<typeof analyticsStudentDataSchema>;
export type AnalyticsWrongAnswer = z.infer<typeof analyticsWrongAnswerSchema>;
export type AnalyticsQuestionRow = z.infer<typeof analyticsQuestionRowSchema>;
export type AnalyticsQuestionsData = z.infer<
  typeof analyticsQuestionsDataSchema
>;
export type AnalyticsErrorCode = z.infer<typeof analyticsErrorCodeSchema>;
