import { z } from "zod";
import { optionSchema } from "./content.ts";
import {
  AI_BATCH_MAX_QUESTIONS,
  AI_MCP_LEASE_MINUTES,
  AI_QUESTION_MAX_CHARS,
  AI_REPLY_MAX_CHARS,
} from "./student-ai.ts";

/**
 * 学生端 AI 伴学：本次练习整体复盘（MCP）契约（任务 1ef854c7；实施依据
 * 《批量复盘整体分析与实施交接.md》§3–§7）。
 *
 * 定位：与旧「逐题错题复盘」（student-ai-api.ts aiBatchReview*）并行的
 * **独立**任务类型——一个 attempt 一份整体上下文，逐题任务只读自己的题，
 * 双方互不混装。整体任务只走 MCP 通道（页内不出站、无链接票据）。
 *
 * 视图边界（与 student-ai.ts 同一套口径）：
 * - aiAttemptReviewSnapshotSchema 是**内部视图**：含参考答案与官方解析
 *   （受控 AI 出口的合法内容），只进入任务行存储与 MCP 领取视图；
 * - aiAttemptReviewTaskPublicSchema / preview / list / detail 是学生 Cookie
 *   会话公开视图：不含题面之外的答案解析正文、租约、内部路径；
 * - 结构化报告 aiAttemptReviewReportSchema 由外部 AI 产回，按不可信输入
 *   校验（strict + 服务端 evidence 归属复核），渲染层再走安全渲染。
 */

// ---------- 限额常量 ----------

/** 整体复盘题数上限（题/次；与批量逐题上限同值但语义独立——超过明确拒绝，不截断） */
export const AI_ATTEMPT_REVIEW_MAX_QUESTIONS = AI_BATCH_MAX_QUESTIONS;
/** 整体上下文序列化上限（UTF-8 字节；超限明确拒绝，不截断题面） */
export const AI_ATTEMPT_REVIEW_CONTEXT_MAX_BYTES = 256 * 1024;
/** 整体报告上限（字符；与单题回信同量级，超限拒绝不截断） */
export const AI_ATTEMPT_REVIEW_RESULT_MAX_CHARS = AI_REPLY_MAX_CHARS;
/** 整体任务初始租约（分钟；过期回 created 可再领取） */
export const AI_ATTEMPT_REVIEW_LEASE_MINUTES = AI_MCP_LEASE_MINUTES;
/** 整体分析提示词版本（参与预览版本 HMAC 输入；提示词变更即换版本锚） */
export const AI_ATTEMPT_REVIEW_PROMPT_VERSION = "attempt-review-prompt-v1";

// ---------- 作答态与判分态（§3.3：两态分离，互斥四桶） ----------

/** 是否有正式作答（answered=有；unanswered=可证明无；unknown=无法核对） */
export const aiAttemptAnswerStateSchema = z.enum([
  "answered",
  "unanswered",
  "unknown",
]);
export type AiAttemptAnswerState = z.infer<typeof aiAttemptAnswerStateSchema>;

/** 判分态：只用最终判定 finalCorrect（教师判定优先；不使用自动判分或 AI 猜测） */
export const aiAttemptGradingStateSchema = z.enum([
  "correct",
  "incorrect",
  "pending",
]);
export type AiAttemptGradingState = z.infer<typeof aiAttemptGradingStateSchema>;

/** 互斥展示桶：正确 / 判错 / 未作答（判分待定且无作答）/ 待批（判分待定且有作答或无法核对） */
export const aiAttemptDisplayStatusSchema = z.enum([
  "correct",
  "incorrect",
  "unanswered",
  "pending",
]);
export type AiAttemptDisplayStatus = z.infer<
  typeof aiAttemptDisplayStatusSchema
>;

// ---------- 每题白名单条目（整体快照的题目元素） ----------

/**
 * 单题条目（内部视图元素）：字段白名单来自该 responses 行冻结快照，
 * 不展开完整 Question、不含教师私注与其他学生数据。notes 说明该题的
 * 缺失/不可判定事实（如「正式笔迹存在但本任务未包含图像」）。
 */
export const aiAttemptReviewQuestionSchema = z
  .object({
    /** 卷内题号（1 起按建卷冻结序） */
    questionNo: z.number().int().min(1),
    questionId: z.string().min(1),
    /** 版本锚定 = responses 行 id（与单题任务同源口径） */
    questionRevisionId: z.string().min(1),
    questionType: z.string().min(1),
    /** 题干 Markdown（选项独立保存，公式保留） */
    stemMd: z.string().min(1),
    /** 全部选项正文；不含正确性。缺省兼容旧任务，旧任务领取仍须核对版本。 */
    options: z.array(optionSchema.pick({ text: true }).strict()).default([]),
    knowledgePoints: z.array(z.string().min(1)),
    difficulty: z.number().int().min(0).nullable(),
    /** 本人正式答案可读文本；null = 未作答 */
    studentAnswerText: z.string().nullable(),
    /** 参考答案；null = 无固定参考答案 */
    referenceAnswerMd: z.string().nullable(),
    /** 官方解析；null = 暂无官方解析 */
    solutionMd: z.string().nullable(),
    /** 缺失说明（与单题快照同源三态；齐全为 null） */
    missingNote: z
      .enum(["no_solution", "no_reference_answer", "neither"])
      .nullable(),
    answerState: aiAttemptAnswerStateSchema,
    gradingState: aiAttemptGradingStateSchema,
    displayStatus: aiAttemptDisplayStatusSchema,
    /** 是否存在正式笔迹（事实存在性；本任务不携带图像，不能分析笔迹过程） */
    hasFormalInk: z.boolean(),
    /** 每题服务端记录的有效用时（秒）；null = 未记录（不当 0） */
    activeSec: z.number().int().min(0).nullable(),
    /** 该题缺失/不可判定说明（中文；无则空数组） */
    notes: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    // 互斥桶与两态的一致性在契约层锁定（服务端构造，防手写矛盾数据）：
    // - correct/incorrect ⇔ gradingState 同值；
    // - unanswered ⇔ 判分待定且作答态为 unanswered；
    // - pending ⇔ 判分待定且作答态为 answered/unknown（unknown 不假报纯待批）。
    const grading = value.gradingState;
    const display = value.displayStatus;
    const consistent =
      (display === "correct" && grading === "correct") ||
      (display === "incorrect" && grading === "incorrect") ||
      (display === "unanswered" &&
        grading === "pending" &&
        value.answerState === "unanswered") ||
      (display === "pending" &&
        grading === "pending" &&
        value.answerState !== "unanswered");
    if (!consistent) {
      ctx.addIssue({
        code: "custom",
        message: "展示桶与作答态/判分态不一致",
      });
    }
  });
export type AiAttemptReviewQuestion = z.infer<
  typeof aiAttemptReviewQuestionSchema
>;

// ---------- 四桶计数（互斥加总恒等于题数） ----------

export const aiAttemptReviewCountsSchema = z
  .object({
    /** 本次练习总题数（= 整体任务覆盖的完整范围） */
    total: z.number().int().min(1),
    correctCount: z.number().int().min(0),
    incorrectCount: z.number().int().min(0),
    unansweredCount: z.number().int().min(0),
    pendingCount: z.number().int().min(0),
    /** 作答态无法核对的题数（含在 pendingCount 内，不重复计桶） */
    unknownAnswerCount: z.number().int().min(0),
    /** 有正式作答的题数（answerState=answered） */
    hasAnswerCount: z.number().int().min(0),
    /** 可证明无作答的题数（= unansweredCount 的作答态维度） */
    missingAnswerCount: z.number().int().min(0),
    /** 已判分数 = correct + incorrect */
    gradedCount: z.number().int().min(0),
    /** 已判分准确率（correct/graded；gradedCount=0 → null，不用 0% 假报） */
    accuracyAmongGraded: z.number().min(0).max(1).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issues: string[] = [];
    if (
      value.correctCount +
        value.incorrectCount +
        value.unansweredCount +
        value.pendingCount !==
      value.total
    ) {
      issues.push("互斥四桶之和不等于总题数");
    }
    if (value.gradedCount !== value.correctCount + value.incorrectCount) {
      issues.push("已判分数与判分两桶之和不一致");
    }
    if (
      value.hasAnswerCount +
        value.missingAnswerCount +
        value.unknownAnswerCount !==
      value.total
    ) {
      issues.push("作答态三桶（已答/未答/无法核对）之和不等于总题数");
    }
    if (value.unknownAnswerCount > value.pendingCount) {
      issues.push("无法核对的题数超过待批桶");
    }
    if (value.gradedCount === 0 && value.accuracyAmongGraded !== null) {
      issues.push("无可判分题时准确率必须为 null");
    }
    if (value.gradedCount > 0 && value.accuracyAmongGraded === null) {
      issues.push("有已判分题时准确率不得为 null");
    }
    if (issues.length > 0) {
      for (const message of issues) {
        ctx.addIssue({ code: "custom", message });
      }
    }
  });
export type AiAttemptReviewCounts = z.infer<typeof aiAttemptReviewCountsSchema>;

// ---------- 整体上下文快照（内部视图：任务行存储与 MCP 领取视图） ----------

export const aiAttemptReviewSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: z.uuid(),
    /** 快照身份不透明戳（服务端 HMAC；与预览版本同源，见服务层） */
    snapshotVersion: z.string().min(1),
    /** 快照时间（UTC ISO） */
    capturedAt: z.string().min(1),
    /** 学生复盘诉求（可编辑；只作分析诉求，不改变范围） */
    purpose: z.string().min(1),
    questionCount: z.number().int().min(1),
    counts: aiAttemptReviewCountsSchema,
    /** 题目按建卷冻结序 */
    questions: z.array(aiAttemptReviewQuestionSchema).min(1),
    /** 全局缺失/边界说明（如「正式笔迹未包含图像，不能分析笔迹过程」） */
    notes: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.questions.length !== value.questionCount) {
      ctx.addIssue({
        code: "custom",
        message: "题目数与 questionCount 不一致",
      });
    }
    if (value.counts.total !== value.questionCount) {
      ctx.addIssue({
        code: "custom",
        message: "计数总数与题目数不一致",
      });
    }
    // 题号连续且按序（建卷冻结序），questionRevisionId 不重复
    for (const [index, question] of value.questions.entries()) {
      if (question.questionNo !== index + 1) {
        ctx.addIssue({ code: "custom", message: "题号必须按 1 起连续排列" });
        return;
      }
    }
    const revisionIds = new Set(
      value.questions.map((question) => question.questionRevisionId),
    );
    if (revisionIds.size !== value.questions.length) {
      ctx.addIssue({
        code: "custom",
        message: "题目版本锚定存在重复",
      });
    }
  });
export type AiAttemptReviewSnapshot = z.infer<
  typeof aiAttemptReviewSnapshotSchema
>;

// ---------- 结构化报告（外部 AI 产回，strict 校验 + 服务端 evidence 复核） ----------

export const aiAttemptReviewFindingSchema = z
  .object({
    statement: z.string().min(1),
    /** 证据题号（卷内题号；服务端复核必须属于快照范围） */
    evidenceQuestionNos: z.array(z.number().int().min(1)).max(100),
    /** platform_fact=服务端统计事实；ai_hypothesis=模型假设（不冒充事实） */
    basis: z.enum(["platform_fact", "ai_hypothesis"]),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();
export type AiAttemptReviewFinding = z.infer<
  typeof aiAttemptReviewFindingSchema
>;

export const aiAttemptReviewPlanItemSchema = z
  .object({
    /** 关联知识点（快照已有标签或模型建议的关联；后者须在 statement 说明） */
    knowledgePoint: z.string().min(1).nullable(),
    relatedQuestionNos: z.array(z.number().int().min(1)).max(100),
    action: z.string().min(1),
    priority: z.enum(["high", "medium", "low"]),
    /** 适用局限/核验办法说明（不保证提分） */
    caveat: z.string().nullable(),
  })
  .strict();
export type AiAttemptReviewPlanItem = z.infer<
  typeof aiAttemptReviewPlanItemSchema
>;

/**
 * 整体复盘报告：五个分析维度 + limitations。模型只解释服务端统计，
 * 不重算分数；报告不回写 responses/判分/错题本。所有 evidenceQuestionNos
 * 必须属于快照范围（服务端 submit 时复核，越界即拒绝）。
 */
export const aiAttemptReviewReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    overview: z.string().min(1),
    knowledgeFindings: z.array(aiAttemptReviewFindingSchema),
    errorPatterns: z.array(aiAttemptReviewFindingSchema),
    performanceNotes: z.array(aiAttemptReviewFindingSchema),
    trainingPlan: z.array(aiAttemptReviewPlanItemSchema),
    /** 不可推断/数据不足说明（缺数据维度必须写，不沉默跳过） */
    limitations: z.array(z.string().min(1)),
  })
  .strict();
export type AiAttemptReviewReport = z.infer<typeof aiAttemptReviewReportSchema>;

// ---------- 任务状态机与公开视图 ----------

/**
 * 任务状态。failed 为预留态：MVP 无页内派发器，领取后的处理失败由租约
 * 过期惰性回 created（可再领取）兜底，当前没有代码路径写 failed——后续
 * 若加页内派发管线，按交接方案 §7.2 启用（失败落 failed + 学生显式重试）。
 */
export const aiAttemptReviewStatusSchema = z.enum([
  "created",
  "claimed",
  "replied",
  "failed",
  "paused",
  "cancelled",
]);
export type AiAttemptReviewStatus = z.infer<typeof aiAttemptReviewStatusSchema>;

export const aiAttemptReviewActionSchema = z.enum([
  "retry",
  "cancel",
  "archive",
  "open",
]);
export type AiAttemptReviewAction = z.infer<typeof aiAttemptReviewActionSchema>;

/** 状态 → 允许动作表（服务端权威；客户端不本地推导） */
export const AI_ATTEMPT_REVIEW_ALLOWED_ACTIONS: Readonly<
  Record<AiAttemptReviewStatus, readonly AiAttemptReviewAction[]>
> = {
  created: ["cancel"],
  claimed: ["cancel"],
  replied: ["open", "archive"],
  failed: ["retry"],
  paused: ["retry", "cancel"],
  cancelled: ["archive"],
};

/** 任务公开视图（学生 Cookie 会话）：无快照原文、无租约、无答案解析正文 */
export const aiAttemptReviewTaskPublicSchema = z
  .object({
    id: z.uuid(),
    attemptId: z.uuid(),
    status: aiAttemptReviewStatusSchema,
    purpose: z.string().min(1),
    questionCount: z.number().int().min(1),
    counts: aiAttemptReviewCountsSchema,
    /** 快照身份戳（与领取视图核对用；不含快照内容） */
    snapshotVersion: z.string().min(1),
    /** 出站代次（每次领取 +1；写回 CAS 凭证之一） */
    generation: z.number().int().min(0),
    retryCount: z.number().int().min(0),
    errorText: z.string().nullable(),
    /** 已收到过结构化报告（不论是否已打开；「未读」由服务端按 replied 且 openedAt 为空计算） */
    hasResult: z.boolean(),
    /** 学生打开报告时刻；null = 未查看 */
    openedAt: z.string().nullable(),
    /** 归档时刻（队列整理；不影响状态与事实） */
    archivedAt: z.string().nullable(),
    allowedActions: z.array(aiAttemptReviewActionSchema),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type AiAttemptReviewTaskPublic = z.infer<
  typeof aiAttemptReviewTaskPublicSchema
>;

// ---------- Web API 契约（student-ai-api.ts 同款约定；学生请求全部 strict） ----------

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/** 复盘诉求字段：trim 后 1–AI_QUESTION_MAX_CHARS 字符（与单题问题文本同限） */
function purposeField() {
  return z
    .string()
    .trim()
    .min(1, "复盘诉求不能为空")
    .max(AI_QUESTION_MAX_CHARS, `复盘诉求最多 ${AI_QUESTION_MAX_CHARS} 个字符`);
}

// ---------- GET /api/student/ai/attempt-reviews/preview ----------

/** 预览查询：attemptId 定位（GET 无 body，查询参数经此 schema） */
export const aiAttemptReviewPreviewQuerySchema = z
  .object({
    attemptId: z.uuid(),
  })
  .strict();
export type AiAttemptReviewPreviewQuery = z.infer<
  typeof aiAttemptReviewPreviewQuerySchema
>;

/**
 * 预览响应 data：范围题数、四类状态计数、发送字段说明与缺失边界说明、
 * 不透明预览版本。创建请求必须携带本版本——题单/判分/公布态变化后
 * 创建返回 409 要求重新预览确认（不静默发送新集合）。
 */
export const aiAttemptReviewPreviewDataSchema = z
  .object({
    attemptId: z.uuid(),
    questionCount: z.number().int().min(1),
    counts: aiAttemptReviewCountsSchema,
    /** 将随任务发送的字段说明（学生知情） */
    fieldNotes: z.array(z.string().min(1)),
    /** 缺失/不可推断边界说明 */
    notes: z.array(z.string().min(1)),
    opaquePreviewVersion: z.string().min(1),
    readyAt: z.string().min(1),
  })
  .strict();
export type AiAttemptReviewPreviewData = z.infer<
  typeof aiAttemptReviewPreviewDataSchema
>;
export const aiAttemptReviewPreviewOkSchema = apiOkExtend(
  aiAttemptReviewPreviewDataSchema,
);

// ---------- POST /api/student/ai/attempt-reviews ----------

/**
 * 整体任务创建请求：范围由服务端按 attempt 重算（客户端不传题单），
 * expectedPreviewVersion 锚定学生确认的范围版本；channel 显式固定 mcp
 * （MVP 仅 MCP 通道，不支持静默切换）。
 */
export const aiAttemptReviewCreateRequestSchema = z
  .object({
    attemptId: z.uuid(),
    /** 客户端幂等键（uuid 或等价不透明串；全局唯一） */
    mutationId: z.string().min(1),
    /** 预览时返回的不透明版本；范围/判分/公布态变化后必须重新预览 */
    expectedPreviewVersion: z.string().min(1),
    purpose: purposeField(),
    channel: z.literal("mcp"),
  })
  .strict();
export type AiAttemptReviewCreateRequest = z.infer<
  typeof aiAttemptReviewCreateRequestSchema
>;

export const aiAttemptReviewCreateDataSchema = z
  .object({
    task: aiAttemptReviewTaskPublicSchema,
    /** false = 幂等重放命中已有任务（同键同内容）或复用同范围活动任务 */
    created: z.boolean(),
  })
  .strict();
export type AiAttemptReviewCreateData = z.infer<
  typeof aiAttemptReviewCreateDataSchema
>;
export const aiAttemptReviewCreateOkSchema = apiOkExtend(
  aiAttemptReviewCreateDataSchema,
);

// ---------- GET /api/student/ai/attempt-reviews（分页列表） ----------

export const aiAttemptReviewListQuerySchema = z
  .object({
    attemptId: z.uuid().optional(),
    status: aiAttemptReviewStatusSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    /** 不透明游标（base64url JSON，与单题任务列表同款） */
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
  })
  .strict();
export type AiAttemptReviewListQuery = z.infer<
  typeof aiAttemptReviewListQuerySchema
>;

export const aiAttemptReviewListDataSchema = z
  .object({
    tasks: z.array(aiAttemptReviewTaskPublicSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type AiAttemptReviewListData = z.infer<
  typeof aiAttemptReviewListDataSchema
>;
export const aiAttemptReviewListOkSchema = apiOkExtend(
  aiAttemptReviewListDataSchema,
);

// ---------- GET /api/student/ai/attempt-reviews/:id（详情） ----------

/**
 * 详情响应 data：任务公开视图 + 已收到的结构化报告（未回复为 null）。
 * 报告按不可信输入对待：渲染层过滤危险 HTML/URL；内部快照与租约不在本视图。
 */
export const aiAttemptReviewDetailDataSchema = z
  .object({
    task: aiAttemptReviewTaskPublicSchema,
    result: aiAttemptReviewReportSchema.nullable(),
  })
  .strict();
export type AiAttemptReviewDetailData = z.infer<
  typeof aiAttemptReviewDetailDataSchema
>;
export const aiAttemptReviewDetailOkSchema = apiOkExtend(
  aiAttemptReviewDetailDataSchema,
);

// ---------- POST /api/student/ai/attempt-reviews/:id/actions ----------

export const aiAttemptReviewActionRequestSchema = z
  .object({
    action: aiAttemptReviewActionSchema,
  })
  .strict();
export type AiAttemptReviewActionRequest = z.infer<
  typeof aiAttemptReviewActionRequestSchema
>;

// ---------- 学生 MCP 工具载荷（/mcp/student 新四工具） ----------
//
// 工具入参 schema 沿学生侧既有约定（submit_ai_reply 同款）：由服务端
// student-server.ts 按工具语义内联声明，本契约只定义**领取视图**这一
// 出站载荷——服务层（student-ai-attempt-review）是报告校验与证据归属
// 复核的唯一权威，避免同一载荷出现两份会漂移的 strict 声明。

/**
 * claim_attempt_review 领取视图：整体快照（含允许的参考答案/解析）+
 * 固定分析提示 + 租约。一次任务一次整体上下文，领取时夹带其他练习结构上
 * 不存在（快照在建任务时冻结）。
 */
export const aiAttemptReviewMcpClaimViewSchema = z
  .object({
    taskId: z.uuid(),
    taskKind: z.literal("attempt_review"),
    attemptId: z.uuid(),
    schemaVersion: z.literal(1),
    snapshotVersion: z.string().min(1),
    generation: z.number().int().min(1),
    lease: z
      .object({
        leaseToken: z.string().min(1),
        leaseUntil: z.string().min(1),
      })
      .strict(),
    snapshot: aiAttemptReviewSnapshotSchema,
    /** 固定整体分析提示词（含注入防御与输出 schema 说明；服务端单源） */
    promptMd: z.string().min(1),
  })
  .strict();
export type AiAttemptReviewMcpClaimView = z.infer<
  typeof aiAttemptReviewMcpClaimViewSchema
>;

// submit_attempt_review_result 的入参（taskId/leaseToken/generation/
// snapshotVersion/report）与回执（submitted/taskId/duplicate）在服务层
// submitAttemptReviewResult 定义并校验（strict 报告 + 证据题号归属复核），
// 此处不再重复一份会漂移的 schema 声明。
