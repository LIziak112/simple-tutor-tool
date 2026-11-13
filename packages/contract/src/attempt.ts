import { z } from "zod";
import { attemptActivitySchema } from "./attempt-activity.ts";
import { questionRevisionIdSchema } from "./attempt-submission.ts";
import { attemptSummarySchema } from "./attempt-summary.ts";
import {
  attemptTimeLimitMinutesSchema,
  attemptTimingSchema,
} from "./attempt-timing.ts";
import { enabledCapabilitiesFieldSchema } from "./capability.ts";
import {
  assignmentAnswerReleaseSchema,
  assignmentDueAtSchema,
  matchingOptionsStudentSchema,
  matchingSlotSchema,
  orderingItemStudentSchema,
  questionAnswersSchema,
  questionPublicSchema,
} from "./content.ts";
import { studentAnswerSchema } from "./grading.ts";
import {
  practiceQuestionProgressSchema,
  practiceWorkflowSchema,
  practiceWorkflowStartOptionsFields,
  rejectFeedbackModeWithoutVersion,
} from "./practice-workflow.ts";
import { rubricReviewSchema } from "./rubric.ts";
import {
  effectiveVerdictSchema,
  gradingPolicySchema,
  selfReviewRecordSchema,
} from "./self-review.ts";
import {
  studentUnitAttemptRecordSchema,
  studentUnitAttemptSummarySchema,
} from "./student-course-api.ts";

export * from "./attempt-context.ts";
export {
  ATTEMPT_QUESTION_LIMIT_EXCEEDED,
  attemptErrorCodeSchema,
} from "./attempt-errors.ts";
export {
  ATTEMPT_SUBMIT_MAX_QUESTIONS,
  type AttemptAnswerConflictCurrent,
  type AttemptSubmitRequest,
  type AttemptSubmitRevision,
  attemptAnswerConflictCurrentSchema,
  attemptSubmissionConflictSchema,
  attemptSubmitRequestSchema,
  attemptSubmitRevisionSchema,
  type LessonQuestionSubmitRequest,
  lessonQuestionSubmitRequestSchema,
  questionRevisionIdSchema,
  type SubmitEvidenceDeclaration,
  submitEvidenceDeclarationSchema,
} from "./attempt-submission.ts";
export * from "./attempt-summary.ts";

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
 * 教师批改标记（D3 持久化口径：teacherMark 优先于 autoCorrect）。
 * T3.2b 的 mark 接口写入；T3.5（D9）起学生端结果视图同样下发该标记——
 * 定义从 teacher-attempt-api.ts 上移到本文件（attempt.ts 是 teacher-attempt-api
 * 的下层模块，反向导入会形成循环），teacher-attempt-api.ts 改为导入复用，
 * 全站仍只有这一份定义（AGENTS 第 1 条）。
 */
export const teacherMarkSchema = z.enum(["correct", "wrong"]);
export type TeacherMark = z.infer<typeof teacherMarkSchema>;

/** 做题时学生自标「不会」（#6980-4）：值域当前只有 unsure（可扩展）。 */
export const studentFlagSchema = z.literal("unsure");

/** 学生做题时标注「不会」的取值类型（#6980-4；端上 setStudentFlagApi 复用）。 */
export type StudentFlag = z.infer<typeof studentFlagSchema>;

/** POST /api/student/assignments/:id/attempt 与 POST /api/student/courses/:cid/units/:uid/attempts 响应 data（创建或取回 attempt） */
export const attemptStartDataSchema = attemptSummarySchema;

/**
 * POST /api/student/wrong-practice 请求体（2026-10 错题重练组卷）：questionIds
 * 顺序即组卷题序；空数组 400，重复 id 服务端去重保序；每个 id 须 ∈ 该生错题本
 * 聚合且最近判定作答快照可用，不满足静默剔除，剔完为空 400 WRONG_PRACTICE_EMPTY。
 *
 * 建卷范围（#6980-2）：随请求下发、原样落 attempts.practice_scope_json（快照
 * 语义）。五种口径：all 页头重练全部；group 组头重练本组；result 结果页
 * 「练习本卷错题」（来源卷标题，模块 7 起可带「· 模块名」后缀）；selection
 * 手选 N 题；ai AI 组卷（只由学生 MCP create_wrong_practice 构造）。
 */
export const wrongPracticeScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("group"),
    /** 分组维度（错题本三种分组同词表） */
    dimension: z.enum(["unit", "time", "knowledge"]),
    /** 组标题（单元标题 /「本周」「较早」等时间桶 / 考点名） */
    groupTitle: z.string().min(1).max(120),
    /** 课程名（课程筛选激活时可携带） */
    courseName: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal("result"),
    /** 来源卷标题（结果页视角，如「周末加练 · 第 1 次」） */
    sourceTitle: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal("all"),
    /** 课程名（课程筛选激活时可携带） */
    courseName: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal("selection"),
    /** 手选题数（展示「手选 N 题」） */
    questionCount: z.number().int().min(1),
    /** 课程名（课程筛选激活时可携带） */
    courseName: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal("ai"),
    /**
     * AI 给出的组卷说明（如「最近一周 · 错 2 次以上 · 10 题」），随卷快照展示。
     * 只由学生 MCP create_wrong_practice 在服务端构造；页面建卷请求契约
     * （wrongPracticeRequestSchema）拒绝 kind=ai，防伪造「AI 组卷」出处。
     */
    label: z.string().min(1).max(120),
  }),
]);
export type WrongPracticeScope = z.infer<typeof wrongPracticeScopeSchema>;

/**
 * 展示用范围标签：all=「全部错题」；group=组标题；result=来源卷标题；
 * selection=「手选 N 题」；ai=AI 组卷说明原文。课程名后缀单源 withCourse
 * （all/selection 两口径共用；group 的 courseName 仅存快照不进标签——历史行为）
 */
function withCourse(base: string, courseName: string | undefined): string {
  return courseName !== undefined ? `${base}（${courseName}）` : base;
}

export function wrongScopeLabelOf(scope: WrongPracticeScope): string {
  if (scope.kind === "all") return withCourse("全部错题", scope.courseName);
  if (scope.kind === "group") return scope.groupTitle;
  if (scope.kind === "selection")
    return withCourse(`手选 ${scope.questionCount} 题`, scope.courseName);
  if (scope.kind === "ai") return scope.label;
  return scope.sourceTitle;
}

/**
 * wrongScope 展示形态（teacherAttemptSourceSchema.wrongScope 同源）：
 * label=建卷时存的范围标签（历史卷无存档为 null）；questionCount=卷内题目数
 * （冻结 responses 行数）；originUnits=题目归属单元分布（responses→
 * questions→units 反查；题/单元已删除时自然缺项）。服务端 sourceOf 计算。
 */
export const wrongScopeSchema = z.object({
  label: z.string().min(1).nullable(),
  questionCount: z.number().int().min(0),
  originUnits: z.array(
    z.object({
      title: z.string().min(1),
      count: z.number().int().min(1),
    }),
  ),
});
export type WrongScope = z.infer<typeof wrongScopeSchema>;

/**
 * 错题重练标题（师生两端单源格式化；记录卡、答题页来源行、结果页、错题本
 * 轮次史、教师端作答列表同取此处）：有范围标签 →「错题重练 · 第 n 次 ·
 * {label}」；历史卷无存档 →「错题重练 · 第 n 次（来自 {u1} ×a、{u2} ×b，
 * 共 N 题）」；都不可得 → 原样「错题重练 · 第 n 次」。
 */
/**
 * 错题重练标题（label-only 便捷形态，答题页/结果页来源行用：摘要只携带
 * label）：label 缺省 = 原样「错题重练 · 第 n 次」（历史卷）。
 */
export function wrongAttemptTitleWithLabel(
  attemptNo: number,
  label: string | null | undefined,
): string {
  const base = `错题重练 · 第 ${attemptNo} 次`;
  return label !== null && label !== undefined ? `${base} · ${label}` : base;
}

export function wrongAttemptTitleOf(scope: {
  attemptNo: number;
  wrongScope: WrongScope | null | undefined;
}): string {
  const base = `错题重练 · 第 ${scope.attemptNo} 次`;
  const s = scope.wrongScope;
  if (!s) return base;
  if (s.label !== null) return `${base} · ${s.label}`;
  const units = s.originUnits.map((u) => `${u.title} ×${u.count}`).join("、");
  return units ? `${base}（来自 ${units}，共 ${s.questionCount} 题）` : base;
}

/**
 * 页面建卷请求的范围一致性（2026-10 评审修复）：
 * - selection：questionCount 必须等于去重后的实际题数——scope 是随卷冻结的
 *   展示快照，放行不一致值会把「手选 999 题」永久写进卷标题；
 * - ai：范围只由学生 MCP create_wrong_practice 在服务端构造，页面接口
 *   拒绝——防止把手动建的卷伪装成 AI 组卷（教师端看到的出处标签可信）。
 */
const rejectInconsistentWrongScope = (
  body: { questionIds: string[]; scope?: WrongPracticeScope | undefined },
  ctx: z.RefinementCtx,
): void => {
  const scope = body.scope;
  if (scope === undefined) return;
  if (scope.kind === "ai") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope", "kind"],
      message: "kind=ai 范围仅由学生 MCP 组卷通道产生，页面接口不接受",
    });
    return;
  }
  if (scope.kind === "selection") {
    const uniqueCount = new Set(body.questionIds).size;
    if (scope.questionCount !== uniqueCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope", "questionCount"],
        message: `questionCount 必须等于去重后的题目数（实际 ${uniqueCount}）`,
      });
    }
  }
};

export const wrongPracticeRequestSchema = z
  .object({
    questionIds: z
      .array(z.string().min(1, "题目 id 不能为空"))
      .min(1, "至少选择一道错题"),
    /** 建卷范围（随卷快照，展示「练的是什么」；缺省=历史行为不变） */
    scope: wrongPracticeScopeSchema.optional(),
    /** 建卷可选工作流选项（M1b）：不带字段维持旧协议 */
    ...practiceWorkflowStartOptionsFields,
  })
  .superRefine(rejectFeedbackModeWithoutVersion)
  .superRefine(rejectInconsistentWrongScope);

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
 * attempt 视图的公开题目（T6R.3 全来源冻结）：QuestionPublic 白名单投影 +
 * 每题不透明 questionRevisionId（该题在本 attempt 的 responses 行 id——建卷
 * 冻结时铸造，交卷时原样回传以验证题目版本；只能定位授权记录，不能当访问
 * 凭证，方案 §5.1）。fail closed 语义与 questionPublicSchema 一致：多给的
 * 教师侧字段在 parse 时被 strip。
 */
export const attemptQuestionPublicSchema = questionPublicSchema.extend({
  questionRevisionId: questionRevisionIdSchema,
  /**
   * 组内序号（TT-05a 域④ §5.2.3/§5.8.1）：开卷冻结时按组的子题引用顺序写入
   * attempt 上下文快照的公开投影；**不在组内的题不携带**（旧快照缺省 = 独立
   * 题，§5.8.3 缺省兼容）。显示编号是展示派生，不进主键。组实体与材料正文
   * 的草稿视图投影随 QM-03/QM-08 接线定稿（材料公开投影见 material.ts）。
   */
  groupOrdinal: z.number().int().min(1).optional(),
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
  /**
   * 公布时机（2026-10-21 交卷前置预期）：assignment 来源 = 作业的 answerRelease
   * 原值；course/wrong 恒 'on_submit'（D11 交卷即公布）；lesson 的 attempt 级
   * 公布不适用（当题释放恒题级粒度），同样投影 'on_submit'。作答页据此在交卷
   * 确认弹窗告知「截止后统一公布」的前置预期——只描述策略，不携带任何答案；
   * 结果视图的权威 gate 仍是 answersReleased（读时判定，两者独立）。
   */
  answerRelease: assignmentAnswerReleaseSchema,
  /** 公开题目分组（与试卷同形态：按单元分节，题号全卷连续） */
  units: z.array(attemptDraftUnitSchema),
  /**
   * 本人草稿答案：questionId → StudentAnswer。未作答的题不在 Map 内；
   * 键名用 drafts（学生自己的答案），与结果视图的 answers（参考答案）区分。
   */
  drafts: z.record(z.string(), studentAnswerSchema),
  /** 本人答案的逐题服务器版本；旧响应缺省由客户端按未建立基线处理。 */
  draftRevisions: z
    .record(z.string(), z.number().int().nonnegative())
    .optional(),
  /**
   * 已解锁提示（T2.11）：questionId → 已解锁条目（含内容，刷新页面后回显）。
   * 未解锁提示的内容不在此（也不在任何学生端响应）。
   */
  hintsOpened: z.record(z.string(), hintOpenedEntrySchema.array()),
  /**
   * 做题时学生自标「不会」（#6980-4）：questionId → "unsure"。草稿视图实时
   * 下发，交卷后进结果视图单题与错题本轮次史；不是作答内容，无泄露面。
   * 旧响应缺省按无标记处理。
   */
  studentFlags: z.record(z.string(), studentFlagSchema).optional(),
  /** 冻结来源不可信标记（T6R.3 §5.1「legacy_unverified」）：true = 升级后首次访问时
   *  懒冻结的当前版本（前端提示「内容为恢复后的版本」）；false = 建卷即冻结 */
  legacyUnverified: z.boolean(),
  /** 限时信息（模块 2）：限时卷下发截止 / 服务端时刻 / 阶段；非限时卷 null，旧响应缺省 */
  timing: attemptTimingSchema.nullable().optional(),
  /**
   * 教师辅助能力有效启用集（T7.7 / 方案 §4.5）：steps/ink 子集，读时按
   * attempt → student → teacher 的配置列计算（NULL=全启用）。steps 关闭时
   * 前端完整展开逐步揭晓；ink 关闭时隐藏手写/草稿入口——均不影响正式作答
   * 与提交规则，也不是安全边界（投影与泄露守卫独立保证）。
   */
  enabledCapabilities: enabledCapabilitiesFieldSchema,
  /**
   * 做题工作流裁决投影（M1a §6.1，可选）：仅新协议卷携带，旧响应缺失按整卷旧
   * 协议处理，不能默认授权。结论由服务端 resolver 产出，不混入题目秘密。
   */
  practiceWorkflow: practiceWorkflowSchema.optional(),
  /**
   * 题级公开进度（M1a，可选，白名单）：questionId / submittedAt / 反馈可读
   * 标记——不含得分、对错、参考答案或教师批注；反馈本体经专用端点读取。
   */
  questionProgress: z.array(practiceQuestionProgressSchema).optional(),
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
  /**
   * 题目版本引用（与作答视图 AttemptQuestionPublic 同源——该题 responses 行
   * id，对学生不透明）：订正工作台用答题页同款 QuestionAnnotationOverlay
   * 在原题上直接圈画，客户端建底图布局需携带此身份（服务端 POST base 严格
   * 校验）。旧响应缺失按「无原位圈画」优雅降级，只渲染题面。
   */
  questionRevisionId: questionRevisionIdSchema.optional(),
  /** 原生整题回看复用作答时的公开冻结投影；旧响应可缺省。 */
  publicQuestion: attemptQuestionPublicSchema.optional(),
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
    /** 组内序号（TT-05a 域④：开卷冻结写入；不在组内的题不携带，旧快照缺省=独立题） */
    groupOrdinal: z.number().int().min(1).optional(),
    /**
     * QM-13：matching/ordering 作答面公开结构（与 questionPublicSchema 同
     * 字段——结果视图/题级反馈的对照呈现需要槽位/选项/项；旧载荷缺省合法）。
     * 2026-10-25 审查 P1 收紧起为学生面变体：逐项剥离 distractor 键（干扰项
     * 身份属答案侧信息），ordering 以 sortableCount 计数替代；fixedPosition
     * 属公开结构（§6.1 调整 3）保留。
     */
    matchingOptions: matchingOptionsStudentSchema.optional(),
    matchingSlots: z.array(matchingSlotSchema).min(1).optional(),
    orderingItems: z.array(orderingItemStudentSchema).optional(),
    sortableCount: z.number().int().min(0).optional(),
    /**
     * 题级材料引用（P1-2，2026-10-25）：材料 id 与选择串属题面公开内容、
     * 无泄露面（正文投影经 materialPublicSchema 白名单）——结果回看的题级
     * 材料锚据此解析（questionMaterialsOf，与作答视图同口径）；可选——
     * 无题级引用/旧载荷不携带（缺省合法，零变化）。
     */
    materialRefs: questionPublicSchema.shape.materialRefs.optional(),
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
  /**
   * 是否有实际作答内容（#6980-3）：整卷交卷按「非空答案或正式手写笔迹」判定；
   * 单题主动提交恒 true（显式交锋，含「不会，提交并看解析」的空提交，2026-10-25
   * 主人口径）。与判分正交——未做仍按 D1 判错进分母。finalCorrect=false 且
   * answered=false 时端上按灰色「未做」展示而非红色「判错」；「练习本卷错题」
   * 默认不含未做题。
   */
  answered: z.boolean(),
  /** 做题时自标「不会」（#6980-4）：unsure / null。入错题本条件之一，不受公布 gate 影响 */
  studentFlag: studentFlagSchema.nullable(),
  /**
   * QM-11（TT-09b）行级自评状态（公布前投影 null；旧载荷缺省按 null）：record=null
   * 表示未自评或已撤回（undecided 清除），revision 是 CAS 基线（清除亦递增，故单独
   * 下发）；与 gradingPolicy 组合经 resolveSelfReviewState 单一出处推导展示态。
   */
  selfReview: z
    .object({
      record: selfReviewRecordSchema.nullable(),
      revision: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
  /**
   * QM-11（TT-09b）行级判分策略（开卷冻结；null=旧行或公布前投影——旧行不开放
   * 自评）。reference_self 行公布后开放自评入口；其余沿用既有判定徽章路径。
   */
  gradingPolicy: gradingPolicySchema.nullable().optional(),
  /** 模块 3 量表视图（题有 :::rubric 且已公布才下发；量表分不进对错与总分） */
  rubricReview: rubricReviewSchema.nullable().optional(),
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
  /** 已作答题数（responses.answered 口径：非空答案/正式笔迹/单题提交）。
   * lesson 讲练页的现算汇总（开卷投影/单题提交响应）只统计已单题提交的行——
   * 见 lessonLiveSummaryOf 口径与 lessonQuestionSubmitDataSchema 注释；
   * 结果视图（整卷）计全部卷行 */
  answered: z.number().int().min(0),
  /** 判对数（QM-12 有效判定口径：教师判 > 自评 > 自动——reference_self 行
   *  按学生自评计入；来源在逐题徽章可见，不以计数冒充客观独立完成） */
  correct: z.number().int().min(0),
  /** 判错数（QM-12 有效判定口径同上；D1 后含未作答客观题。v2 #6980-3 起
   *  端上「未做」以 answered 维度另行展示，不以此计数区分） */
  wrong: z.number().int().min(0),
  /** 未判断数（有效判定=null：待教师批改 + 待自评——与 pendingCount 的
   *  D4 教师待批口径区分；公布 gate 未公布形态按 answered 口径投影） */
  pending: z.number().int().min(0),
  /** 未作答题数（responses.answered=false：被动跳过/空结构答案——与判分
   *  维度正交，#6980-3：未做仍进判分分母，仅不计入 answered） */
  unanswered: z.number().int().min(0),
  /** 已判定题数 = correct + wrong（QM-12 起为有效判定计数；字段名沿用） */
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

/**
 * 自评响应 data（QM-10 路由回执；TT-09b 自 self-review.ts 移驻本文件以消除
 * 循环导入——attempt.ts 反向值引用 self-review.ts 的记录 schema）：本题有效
 * 判定投影 + 卷汇总刷新（汇总口径沿 attemptScoreSummary；公布 gate 已过，
 * 无受限形态投影需求）。
 */
export const selfReviewDataSchema = z.object({
  selfReview: selfReviewRecordSchema.nullable(),
  effective: effectiveVerdictSchema.nullable(),
  summary: attemptScoreSummarySchema,
});
export type SelfReviewData = z.infer<typeof selfReviewDataSchema>;

/** 结果视图的单元分组（T2A.7）：逐题结果按交卷时的单元归属分节（单元序+题序） */
export const attemptResultUnitSchema = z.object({
  /** 练习单元 id（来自 DSL） */
  id: z.string().min(1),
  /** 单元标题（当前值；结果页分节标题） */
  title: z.string().min(1),
  /** 该单元的逐题结果（按单元内题序） */
  questions: z.array(attemptResultQuestionSchema),
  /**
   * 模块参考时间配额（分钟，2026-11-09 模块 7「按模块看结果」）：单元
   * frontmatter `practice.timeLimitMinutes` 的当前值，结果页与该模块的
   * 题内活动用时并列展示；无推荐 / 非单元组缺省。只是参考，不构成时钟。
   */
  timeQuotaMinutes: attemptTimeLimitMinutesSchema.optional(),
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
  /** 教师辅助能力有效启用集（T7.7，与草稿视图同口径；结果视图详解/揭晓同样遵循） */
  enabledCapabilities: enabledCapabilitiesFieldSchema,
  /**
   * 练习工作流裁决投影（M4-D3 §13.8，与草稿视图同一 schema 单源）：v1 新协议
   * 卷携带（feedbackMode 驱动结果页「反馈节奏」摘要行）；lesson / 旧协议卷缺省。
   * 结论只能来自服务端 resolver 读时裁决，本字段不作为任何授权依据。
   */
  practiceWorkflow: practiceWorkflowSchema.optional(),
  /** 题内活动用时（attempt-activity.ts v1 口径，服务端按事件现算；无事件卷缺省） */
  activity: attemptActivitySchema.optional(),
});

/** PUT /api/student/attempts/:id/answers/:questionId 请求体 */
export const attemptAnswerSaveRequestSchema = z
  .object({
    answer: studentAnswerSchema,
    /** 逐题比较版本，不影响其他题的合并。 */
    baseRevision: z.number().int().nonnegative().optional(),
    /** 同一次保存重试保持不变，避免回执丢失产生重复写入。 */
    mutationId: z.string().uuid().optional(),
  })
  .refine(
    (value) =>
      (value.baseRevision === undefined) === (value.mutationId === undefined),
    {
      message: "答案版本与保存标识必须同时提供",
    },
  );

/** 本人作答材料盘点，仅提供题号键和版本，正文沿用已有授权接口读取。 */
export const attemptMaterialRevisionsSchema = z.object({
  notes: z.record(z.string(), z.number().int().nonnegative()),
  annotations: z.record(z.string(), z.number().int().nonnegative()),
  ink: z.record(z.string(), z.number().int().nonnegative()),
});
export type AttemptMaterialRevisions = z.infer<
  typeof attemptMaterialRevisionsSchema
>;

/** PUT /api/student/attempts/:id/answers/:questionId 响应 data */
export const attemptAnswerSaveDataSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  /** 已保存的题目 id（回显，方便前端对账） */
  questionId: z.string().min(1),
  /** 学生改答次数；确认教师补答的相同内容时仍可为零。 */
  changeCount: z.number().int().nonnegative(),
});

// ---------- 讲练页（kind: lesson，2026-10：单题提交即时反馈） ----------

/**
 * 讲练页切段（学生侧安全投影的最小单元）：讲义 markdown 原文是教师域数据
 * （题块内含 [[答案]] 标记 / :::solution / :::hint），学生端只拿服务端
 * splitLessonBlocks 切出的段落序列——md 段是原文的非题区间（可渲染），
 * question 段只携带题目 id（内容由冻结题公开投影下发，防泄露根基，方案决策 1）。
 * md 段非空：切段时相邻题块间的空区间直接跳过（空段是切段 bug 的信号）。
 */
export const lessonBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("md"),
    /** 讲义段落 Markdown（可含 H1/H2 标题与指令语法，前端 RichMarkdown 渲染） */
    md: z.string().min(1),
  }),
  z.object({
    type: z.literal("question"),
    /** 题目 id（DSL id，来自题目容器开围栏注入的 id 属性） */
    questionId: z.string().min(1),
  }),
]);

/**
 * POST /api/student/lectures/:id/lesson/start（幂等 create-or-return）与
 * restart 响应 data：讲练页开卷投影。**草稿与完成态共用一形态**，由
 * attempt.status 区分（draft → 作答态渲染题卡；submitted/graded → 结果态，
 * released 全量 + summary 非空）。
 * - blocks：讲义切段（安全投影，原文绝不下发）；
 * - questions：冻结快照平铺（attemptQuestionPublic，含 questionRevisionId；
 *   题号顺序 = blocks 中出现顺序；教师重导后不在当前 markdown 的孤儿冻结题
 *   由前端渲染于页尾「本次练习其余题目」区，不丢失，方案决策 2）；
 * - drafts / hintsOpened：与草稿视图同口径（本人答案与已解锁提示回显）；
 * - released：已单题提交的题 → 当题结果形态（attemptResultQuestion：
 *   提交即释放该题的参考答案/详解/判定——恒题级粒度，见 attemptSourceSchema
 *   的 lesson 注释）；
 * - summary：进行中为 null（服务端读侧现算，不落库）；完成后非空（superRefine
 *   锁定状态-形态一致性）。
 */
export const lessonStartDataSchema = z
  .object({
    /** 讲练页上下文（顶部标题与来源行） */
    lecture: z.object({
      id: z.uuid(),
      /** 讲练页标题（H1 标题文本） */
      title: z.string().min(1),
      /** 讲练页主题（frontmatter topic）；未标注为 null（与学生讲义摘要同口径） */
      topic: z.string().nullable(),
      /** 打开时来自哪门课（可空口径同 attempt.courseId）；课程名随行 */
      courseId: z.uuid().nullable(),
      courseName: z.string().min(1).nullable(),
    }),
    /** 讲义切段（渲染顺序即页面顺序） */
    blocks: z.array(lessonBlockSchema),
    attempt: attemptSummarySchema,
    /** 冻结快照平铺（公开投影 + questionRevisionId） */
    questions: z.array(attemptQuestionPublicSchema),
    /** 本人草稿答案：questionId → StudentAnswer（与草稿视图同口径） */
    drafts: z.record(z.string(), studentAnswerSchema),
    draftRevisions: z
      .record(z.string(), z.number().int().nonnegative())
      .optional(),
    /** 已解锁提示：questionId → 已解锁条目（与草稿视图同口径） */
    hintsOpened: z.record(z.string(), hintOpenedEntrySchema.array()),
    /** 已单题提交的题：questionId → 当题结果（当题已释放） */
    released: z.record(z.string(), attemptResultQuestionSchema),
    /** 得分汇总（进行中为 null；完成后非空——现算口径与结果视图一致） */
    summary: attemptScoreSummarySchema.nullable(),
    /** 教师辅助能力有效启用集（与草稿/结果视图同口径） */
    enabledCapabilities: enabledCapabilitiesFieldSchema,
  })
  .superRefine((data, ctx) => {
    if (data.attempt.sourceType !== "lesson") {
      ctx.addIssue({
        code: "custom",
        path: ["attempt", "sourceType"],
        message:
          "状态-形态不一致：讲练开卷数据只承载 lesson 来源的 attempt（其余来源走通用草稿/结果视图）",
      });
    }
    if (data.attempt.status !== "draft" && data.summary === null) {
      ctx.addIssue({
        code: "custom",
        path: ["summary"],
        message:
          "状态-形态不一致：attempt 已完成（submitted/graded）但 summary 为 null（完成后汇总必须非空）",
      });
    }
  });

/**
 * 单题提交响应 data（当题释放）：**只含该题**的判分结果 + 现算汇总 + attempt
 * 摘要三键。question 为 attemptResultQuestion 形态（学生已锁定答案，提交即
 * 释放参考答案/详解/判定；不可自动判 → finalCorrect 留 null 进待批，前端显示
 * 「待老师批改」）；summary 恒非 null（进行中卷也现算部分汇总：已提交题计入
 * correct/wrong/pending，未提交题计入 unanswered）。全部行提交完成后服务端
 * 自动收尾（最后一题的事务内置 attempt 为 submitted/graded 并写得分）。
 */
export const lessonQuestionSubmitDataSchema = z.object({
  /** 该题的当题结果（提交即时释放） */
  question: attemptResultQuestionSchema,
  /** 现算得分汇总（口径与结果视图一致） */
  summary: attemptScoreSummarySchema,
  attempt: attemptSummarySchema,
});

// ---------- 讲练落地页（2026-10 教师演示口径：开始练习/继续作答/重开 + 历次） ----------

/**
 * GET /api/student/lectures/:id/lesson/landing 响应 data：讲练落地信息。
 * 讲练是老师讲解材料（非练习考核），落地页承载「开始练习（从未做）/ 继续作答
 * （有进行中卷）/ 再做一次或重新开始（重开新卷）」三态入口与历次记录列表。
 * - attempts：该生该讲练的全部**未作废**作答（attemptNo 降序；作废卷见
 *   abandonedAt 语义，不入历次）；draft 行点击进讲练页续作，已交行进结果页；
 * - summary：与单元落地（studentUnitAttemptSummarySchema）同构；从未做为 null；
 * - questionCount/typeDistribution：嵌入单元当前 live 题统计（零题讲练为 0/空）；
 * - 安全：只含计数与作答元信息，不含任何题目内容与答案/详解/提示
 *   （assertNoLeak 泄露测试覆盖，AGENTS.md 第 3 条）。
 */
export const lessonLandingDataSchema = z.object({
  /** 讲练页讲义 id */
  lectureId: z.uuid(),
  /** 讲练页标题（H1） */
  title: z.string().min(1),
  /** 主题；未标注为 null（与 lessonStartData.lecture 同口径） */
  topic: z.string().nullable(),
  /** 打开时来自哪门课（可空口径同 attempt.courseId）；课程名随行 */
  courseId: z.uuid().nullable(),
  courseName: z.string().min(1).nullable(),
  /** 嵌入单元未删除题目数（零题讲练为 0） */
  questionCount: z.number().int().min(0),
  /** 题型分布：题型 → 题数（仅含有题数的题型） */
  typeDistribution: z.record(z.string(), z.number().int().min(1)),
  /** 历次作答（attemptNo 降序；作废卷不计入） */
  attempts: z.array(studentUnitAttemptRecordSchema),
  /** 作答汇总；从未做为 null */
  summary: studentUnitAttemptSummarySchema.nullable(),
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

// ---------- 具体化的成功壳 ----------

/** 标注「不会」的请求体（#6980-4）：flag=null 表示取消标记 */
export const attemptFlagRequestSchema = z.object({
  flag: studentFlagSchema.nullable(),
});

/** 标注「不会」的回执（#6980-4）：只回标志位，不含任何作答内容 */
export const attemptFlagDataSchema = z.object({
  questionId: z.string().min(1),
  studentFlag: studentFlagSchema.nullable(),
});

/** 携带创建/取回 attempt 结果的成功响应壳 */
export const attemptStartOkSchema = apiOkExtend(attemptStartDataSchema);
/** 携带草稿视图的成功响应壳 */
export const attemptDraftOkSchema = apiOkExtend(attemptDraftDataSchema);
/** 携带结果视图的成功响应壳 */
export const attemptResultOkSchema = apiOkExtend(attemptResultDataSchema);
/** 携带草稿保存回执的成功响应壳 */
/** 携带提示解锁结果的成功响应壳（hint 是唯一放行的提示内容键） */
export const hintOpenOkSchema = apiOkExtend(hintOpenDataSchema);
/** 携带讲练开卷投影的成功响应壳（start/restart 共用；2026-10） */
export const lessonStartOkSchema = apiOkExtend(lessonStartDataSchema);
/** 携带讲练落地信息的成功响应壳（三态入口 + 历次；2026-10） */
export const lessonLandingOkSchema = apiOkExtend(lessonLandingDataSchema);
/** 携带单题提交结果的成功响应壳（当题释放；2026-10） */
export const lessonQuestionSubmitOkSchema = apiOkExtend(
  lessonQuestionSubmitDataSchema,
);

// ---------- 推断类型导出 ----------

export type AttemptStartData = z.infer<typeof attemptStartDataSchema>;
export type AttemptDraftData = z.infer<typeof attemptDraftDataSchema>;
export type AttemptDraftUnit = z.infer<typeof attemptDraftUnitSchema>;
/** attempt 视图公开题目（QuestionPublic + questionRevisionId，T6R.3） */
export type AttemptQuestionPublic = z.infer<typeof attemptQuestionPublicSchema>;
/** 题目版本引用（T6R.3；随 schema 自 note.ts 移入本文件） */
/** 试卷题目的可选版本形态（仅通用取卷携带 revisionId） */
export type AttemptResultQuestion = z.infer<typeof attemptResultQuestionSchema>;
export type AttemptFlagData = z.infer<typeof attemptFlagDataSchema>;
export type AttemptResultUnit = z.infer<typeof attemptResultUnitSchema>;
export type AttemptScoreSummary = z.infer<typeof attemptScoreSummarySchema>;
export type AttemptResultData = z.infer<typeof attemptResultDataSchema>;
export type AttemptAnswerSaveRequest = z.infer<
  typeof attemptAnswerSaveRequestSchema
>;
export type AttemptAnswerSaveData = z.infer<typeof attemptAnswerSaveDataSchema>;
export type HintOpenedEntry = z.infer<typeof hintOpenedEntrySchema>;
export type HintOpenData = z.infer<typeof hintOpenDataSchema>;
/** 错题重练组卷请求（2026-10） */
/** 详情响应 data：草稿视图或结果视图（服务端按 attempt.status 返回其一） */
export type AttemptDetailData = z.infer<typeof attemptDetailDataSchema>;
/** 讲练页切段（2026-10：md 段 / 题目槽） */
export type LessonBlock = z.infer<typeof lessonBlockSchema>;
/** 讲练开卷投影（草稿与完成态共用一形态，由 attempt.status 区分；2026-10） */
export type LessonStartData = z.infer<typeof lessonStartDataSchema>;
/** 讲练落地信息（三态入口 + 历次记录的数据源；2026-10） */
export type LessonLandingData = z.infer<typeof lessonLandingDataSchema>;
/** 单题提交请求体（questionRevisionId + 可选证据声明；2026-10） */
/** 单题提交响应 data（question/summary/attempt 三键；2026-10） */
export type LessonQuestionSubmitData = z.infer<
  typeof lessonQuestionSubmitDataSchema
>;

// ---------- 与作业状态的关系 ----------

/**
 * attempt 状态 → 学生作业列表四态的推导在服务端纯函数 computeAssignmentStatus
 * （assignment-service，T2.2 预留）：graded > submitted > draft > not_started。
 * 本文件的 AttemptStatus（库三态）与 assignment.ts 的 AssignmentStatus（学生端
 * 四态）在此声明对应关系，避免两处枚举各自漂移。
 */
