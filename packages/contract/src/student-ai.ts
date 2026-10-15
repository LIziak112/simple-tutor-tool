import { z } from "zod";
import { questionRevisionIdSchema } from "./attempt.ts";
import { aiTeachingModeSchema } from "./student-ai-policy.ts";

/**
 * 学生端 AI 伴学：任务、材料与连接领域契约（SAI-03 起为权威定义）。
 * 依据：docs/学生端AI伴学/技术实施方案.md §3（上下文/材料/对话/状态机/事实/视图边界）、
 * §4.1（契约模块）、§5（表结构）、§9（限额表）、需求规格.md §4/§6/§10。
 *
 * 视图边界（AGENTS.md「学生端 AI 伴学与受控 AI 出口」，泄露测试双断言口径）：
 * - aiContextSnapshotSchema 是**内部视图**：含参考答案与官方解析（受控 AI 出口的
 *   合法内容），只进入出站载荷 / MCP 领取视图 / 分享视图 / 教师域视图；
 *   教师私注（teacherComment）不属于任何快照或载荷 schema（strict 拒绝）。
 * - aiTaskPublicSchema / aiConnectionPublicSchema 是学生 Cookie 会话公开视图：
 *   不含快照原文、教师模板正文、密钥、租约秘密、内部文件路径。
 * - 明文凭证只出现在 aiConnectionFirstCredentialSchema（创建/重置响应一次）。
 */

// ---------- 限额常量（B00 §9 限额表契约单源，D7 已定案） ----------

/** 学生问题/追问我本上限（字符；UTF-8 ≤6000B 由服务端按字节复核） */
export const AI_QUESTION_MAX_CHARS = 2000;
/** 同题对话轮数上限（轮/任务） */
export const AI_TURNS_MAX = 20;
/** 材料 PNG 数量上限（张/任务） */
export const AI_MATERIAL_MAX_COUNT = 12;
/** 单张材料上限（字节；对齐 NOTE_IMAGE_PNG_MAX_BYTES 的 2MiB） */
export const AI_MATERIAL_PNG_MAX_BYTES = 2 * 1024 * 1024;
/** 材料合计上限（字节/任务；对齐版本聚合限额 8MiB） */
export const AI_MATERIAL_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
/** 进行中任务上限（个/(学生,attempt,题目)） */
export const AI_TASK_ACTIVE_PER_QUESTION = 3;
/** 待处理任务上限（个/学生：pending+dispatching+claimed+uncertain） */
export const AI_TASK_PENDING_PER_STUDENT = 10;
/** 任务日上限（个/学生/日，含批量） */
export const AI_TASK_DAILY_PER_STUDENT = 200;
/** 批量复盘上限（题/次） */
export const AI_BATCH_MAX_QUESTIONS = 30;
/** 出站超时（ms） */
export const AI_OUTBOUND_TIMEOUT_MS = 60_000;
/** 连接测试超时（ms） */
export const AI_CONNECTION_TEST_TIMEOUT_MS = 10_000;
/** MCP 租约时长（分钟；过期回队，迟到写回仅记 late_reply 事实） */
export const AI_MCP_LEASE_MINUTES = 10;
/** 票据默认有效期（小时） */
export const AI_SHARE_DEFAULT_VALID_HOURS = 24;
/** 票据有效期上限（小时） */
export const AI_SHARE_MAX_VALID_HOURS = 72;
/** 单条回信上限（字符 ≈ 32KiB 文本；超出服务端截断并显式声明） */
export const AI_REPLY_MAX_CHARS = 32 * 1024;

// ---------- 作答定位与任务状态机 ----------

/** 任务状态（B00 §3.4 状态机；处理状态，与查看状态〔replyDeliveredAt〕分开） */
export const aiTaskStatusSchema = z.enum([
  "created",
  "dispatching",
  "uncertain",
  "claimed",
  "replied",
  "paused",
  "failed",
  "cancelled",
]);
export type AiTaskStatus = z.infer<typeof aiTaskStatusSchema>;

/** 任务允许动作（状态机级；教学策略门禁是另一层，出站前服务端重校验） */
export const aiTaskActionSchema = z.enum([
  "dispatch",
  "share",
  "cancel",
  "resume",
  "followup",
  "retry",
]);
export type AiTaskAction = z.infer<typeof aiTaskActionSchema>;

/**
 * 状态 → 允许动作表（B00 §3.4/§6）：
 * - created：页内发送 / 生成链接 / 取消；dispatching：等待，无动作；
 * - uncertain：只提供显式重试（绝不自动重发）；claimed：只能取消（阻止交付）；
 * - replied：追问 / 生成链接；paused：学生显式继续（回 created）/ 取消；
 * - failed：显式重试（重试前提示可能重复计费）；cancelled：终态。
 */
export const AI_TASK_ALLOWED_ACTIONS: Readonly<
  Record<AiTaskStatus, readonly AiTaskAction[]>
> = {
  created: ["dispatch", "share", "cancel"],
  dispatching: [],
  uncertain: ["retry"],
  claimed: ["cancel"],
  replied: ["followup", "share"],
  paused: ["resume", "cancel"],
  failed: ["retry"],
  cancelled: [],
};

/**
 * 队列摘要分桶（GET /ai/queue-summary 三计数的语义单源，需求 §6.1/§7.1）：
 * - pending：待领取（created，含 MCP 待领取与页内待发送）；
 * - processing：处理中（dispatching/claimed/uncertain）；
 * - 未读不是状态分桶：replied 且 replyDeliveredAt 为空（交付态推导）。
 * paused/failed/cancelled 不进顶栏待处理计数（队列页单独分组查看）。
 */
export const AI_TASK_QUEUE_BUCKETS: Readonly<{
  pending: readonly AiTaskStatus[];
  processing: readonly AiTaskStatus[];
}> = {
  pending: ["created"],
  processing: ["dispatching", "claimed", "uncertain"],
};

// ---------- 上下文快照（内部视图：受控 AI 出口合法携带答案解析） ----------

/** 参考内容缺失说明（需求 §4.1 三缺失态；两者齐全为 null） */
export const aiContextMissingNoteSchema = z.enum([
  "no_solution",
  "no_reference_answer",
  "neither",
]);
export type AiContextMissingNote = z.infer<typeof aiContextMissingNoteSchema>;

/**
 * 单题文字快照（服务端装配，读 questionSnapshotJson 与 responses 行，不读当前题库）。
 * 教师私注不是 AI 合法内容：strict 拒绝 teacherComment 等任何教师内部字段。
 * missingNote 与答案/解析的实际有无做强一致交叉校验——矛盾快照（如两者齐全却
 * 声明缺失）在契约层拒绝，不进任何出站/领取/分享视图。
 */
export const aiContextSnapshotSchema = z
  .object({
    /** 版本锚定 = responses 行 id（复用 attempt.ts 的不透明单源口径） */
    questionRevisionId: questionRevisionIdSchema,
    questionId: z.string().min(1),
    questionType: z.string().min(1),
    /** 题干 Markdown（含选项列表，公式保留） */
    stemMd: z.string().min(1),
    knowledgePoints: z.array(z.string().min(1)),
    difficulty: z.number().int().min(0).nullable(),
    /** 本人当前答案可读文本；null = 尚无答案/笔迹（仍可求助） */
    studentAnswerText: z.string().nullable(),
    /** 已有标准答案；null = 无固定参考答案 */
    referenceAnswerMd: z.string().nullable(),
    /** 官方解析；null = 暂无官方解析 */
    solutionMd: z.string().nullable(),
    /** 缺失说明：三态，参考答案与解析齐全时为 null（superRefine 强一致） */
    missingNote: aiContextMissingNoteSchema.nullable(),
    /** 当时有效提示词快照：教师模板正文 + 模式硬约束句（模板删空仅剩硬约束句） */
    promptSnapshotMd: z.string().min(1),
    /** 快照时间（UTC ISO） */
    capturedAt: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasAnswer = value.referenceAnswerMd !== null;
    const hasSolution = value.solutionMd !== null;
    const expected: AiContextMissingNote | null =
      hasAnswer && hasSolution
        ? null
        : hasAnswer
          ? "no_solution"
          : hasSolution
            ? "no_reference_answer"
            : "neither";
    if (value.missingNote !== expected) {
      ctx.addIssue({
        code: "custom",
        message: "缺失说明与参考答案/解析的实际状态不一致",
      });
    }
  });
export type AiContextSnapshot = z.infer<typeof aiContextSnapshotSchema>;

// ---------- 材料行 ----------

/** 附件类别：题面圈画 / 草稿 / 正式手写 */
export const aiMaterialKindSchema = z.enum([
  "annotation",
  "draft",
  "formal_ink",
]);
export type AiMaterialKind = z.infer<typeof aiMaterialKindSchema>;

/**
 * 材料行（学生可见视图）：类别/页序/尺寸/字节/内容哈希/状态/缺失原因。
 * pngPath（内部文件路径，相对 DATA_DIR）不进本 schema——只在内部行。
 */
export const aiTaskMaterialSchema = z
  .object({
    id: z.uuid(),
    taskId: z.uuid(),
    kind: aiMaterialKindSchema,
    pageIndex: z.number().int().min(0),
    pixelWidth: z.number().int().positive(),
    pixelHeight: z.number().int().positive(),
    byteSize: z.number().int().positive(),
    /** sha256 hex（内容寻址，64 位十六进制） */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    state: z.enum(["pending", "ready", "failed", "missing"]),
    /** 缺失原因（中文）；state=missing 时必填，不能只报缺失不给原因 */
    missingReason: z.string().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.state === "missing" &&
      (value.missingReason ?? "").trim() === ""
    ) {
      ctx.addIssue({
        code: "custom",
        message: "材料缺失时必须给出缺失原因",
      });
    }
  });
export type AiTaskMaterial = z.infer<typeof aiTaskMaterialSchema>;

/** 材料内部行（服务端/出站执行专用）：附带文件路径（相对 DATA_DIR，不可变） */
export const aiTaskMaterialInternalSchema = aiTaskMaterialSchema
  .extend({
    pngPath: z.string().min(1),
  })
  .strict();
export type AiTaskMaterialInternal = z.infer<
  typeof aiTaskMaterialInternalSchema
>;

// ---------- 对话消息与事实 ----------

export const aiMessageRoleSchema = z.enum(["student", "assistant"]);
export type AiMessageRole = z.infer<typeof aiMessageRoleSchema>;

/** 同题对话消息：绑定单一 taskId（追问只引用本题当前对话，不混入其他题） */
export const aiMessageSchema = z
  .object({
    id: z.uuid(),
    taskId: z.uuid(),
    role: aiMessageRoleSchema,
    contentMd: z.string().min(1).max(AI_REPLY_MAX_CHARS),
    createdAt: z.string().min(1),
  })
  .strict();
export type AiMessage = z.infer<typeof aiMessageSchema>;

/** 审计事实类型（B00 §3.5；append-only，永不 UPDATE/DELETE） */
export const aiFactTypeSchema = z.enum([
  "task_created",
  "link_generated",
  "dispatched",
  "link_viewed",
  "reply_received",
  "reply_delivered",
  "paused",
  "resumed",
  "cancelled",
  "failed",
  "late_reply",
]);
export type AiFactType = z.infer<typeof aiFactTypeSchema>;

/** 事实行（学生投影）：beforeSubmit 由服务端按当时完成态判定，客户端上报不改写 */
export const aiFactSchema = z
  .object({
    id: z.uuid(),
    taskId: z.uuid(),
    type: aiFactTypeSchema,
    beforeSubmit: z.boolean(),
    serverTs: z.string().min(1),
  })
  .strict();
export type AiFact = z.infer<typeof aiFactSchema>;

/** 事实行（教师域视图）：附带 detail（连接方式、当时模式、错误摘要） */
export const aiTeacherFactSchema = aiFactSchema
  .extend({
    detail: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type AiTeacherFact = z.infer<typeof aiTeacherFactSchema>;

// ---------- 通道与连接器 ----------

/** 三通道（页内 / 远程 MCP / 上下文链接） */
export const aiChannelSchema = z.enum(["inapp", "mcp", "link"]);
export type AiChannel = z.infer<typeof aiChannelSchema>;

export const aiConnectionVerifyStatusSchema = z.enum([
  "unverified",
  "verified",
  "failed",
  /** secret.key 丢失导致解密失败：连接置待重填，不静默失效 */
  "needs_rekey",
]);
export type AiConnectionVerifyStatus = z.infer<
  typeof aiConnectionVerifyStatusSchema
>;

/** 图像能力（模型是否支持识图；unknown = 未验证，发送前说明并允许仅文字） */
export const aiImageCapabilitySchema = z.enum([
  "unknown",
  "supported",
  "unsupported",
]);
export type AiImageCapability = z.infer<typeof aiImageCapabilitySchema>;

/**
 * 连接器公开视图（学生 Cookie 会话）：只含指纹，绝无明文 Key/Token、
 * 密文列、租约或内部路径。inapp 的明文 Key 只写不读；mcp 的明文 token
 * 仅创建/重置响应返回一次（aiConnectionFirstCredentialSchema）。
 */
export const aiConnectionPublicSchema = z.discriminatedUnion("channel", [
  z
    .object({
      id: z.uuid(),
      channel: z.literal("inapp"),
      baseUrl: z.url(),
      model: z.string().min(1),
      /** API Key 指纹（keyHash 前 8 hex） */
      keyFingerprint: z.string().min(1),
      imageCapability: aiImageCapabilitySchema,
      isDefault: z.boolean(),
      verifyStatus: aiConnectionVerifyStatusSchema,
      verifiedAt: z.string().nullable(),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      channel: z.literal("mcp"),
      /** 学生受限 token 指纹（只读回显） */
      tokenFingerprint: z.string().min(1),
      isDefault: z.boolean(),
      verifyStatus: aiConnectionVerifyStatusSchema,
      verifiedAt: z.string().nullable(),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      channel: z.literal("link"),
      /** 链接票据默认有效期（小时，1–72；B00 §5.1「link: 偏好」的最小具体化） */
      defaultValidHours: z.number().int().min(1).max(AI_SHARE_MAX_VALID_HOURS),
      isDefault: z.boolean(),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
    })
    .strict(),
]);
export type AiConnectionPublic = z.infer<typeof aiConnectionPublicSchema>;

/**
 * 首次创建/重置凭证响应（单独 schema）：明文凭证只在必要的创建响应出现一次，
 * 之后任何读接口、日志、链接不再出现。
 */
export const aiConnectionFirstCredentialSchema = z
  .object({
    /** 学生受限 MCP token 明文（一次性展示） */
    token: z.string().min(1),
  })
  .strict();
export type AiConnectionFirstCredential = z.infer<
  typeof aiConnectionFirstCredentialSchema
>;

// ---------- 连接管理常量（SAI-16；请求/响应 schema 在 student-ai-api.ts） ----------

/** baseUrl 长度上限（字符；出站目标形状校验在服务端 outbound-target） */
export const AI_CONNECTION_BASE_URL_MAX_CHARS = 512;
/** 模型名长度上限（字符） */
export const AI_CONNECTION_MODEL_MAX_CHARS = 128;
/** API Key 长度上限（字符；写入即密封，任何读接口只回指纹） */
export const AI_API_KEY_MAX_CHARS = 512;
/** MCP/分享凭证熵（字节；base64url 后 43 字符，独立于学生登录链接 Token） */
export const AI_MCP_TOKEN_BYTES = 32;

// ---------- 学生公开任务视图 ----------

/**
 * 任务公开视图（学生 Cookie 会话，GET /api/student/ai/tasks* 响应载荷元素）。
 * 处理状态（status）与查看状态（hasReply/replyDeliveredAt）分开：
 * replied 未打开 = 已收到回信未读；仅入队未外发不会被表述为已获帮助。
 * 不含：上下文快照原文、教师模板正文、租约、内部路径、代际、密钥。
 */
export const aiTaskPublicSchema = z
  .object({
    id: z.uuid(),
    attemptId: z.uuid(),
    questionId: z.string().min(1),
    /** 版本锚定（= responses 行 id，复用 attempt.ts 单源；历史回信永指原材料） */
    questionRevisionId: questionRevisionIdSchema,
    channel: aiChannelSchema,
    status: aiTaskStatusSchema,
    /** 发送时有效模式（历史任务保留当时模式） */
    modeAtSend: aiTeachingModeSchema,
    /** 学生问题（首条消息正文） */
    question: z.string().min(1),
    /** 创建时服务端判定的提交前/提交后（客户端迟到上报不改写） */
    beforeSubmit: z.boolean(),
    /** 上下文版本（快照身份的服务端不透明戳；换快照即换任务/新材料显式提示） */
    contextVersion: z.string().min(1),
    snapshotAt: z.string().min(1),
    hasReply: z.boolean(),
    /** 学生打开回信时刻；null = 未查看（含已收信未读与未回信） */
    replyDeliveredAt: z.string().nullable(),
    errorText: z.string().nullable(),
    retryCount: z.number().int().min(0),
    /**
     * 当前允许动作：服务端权威输出（AI_TASK_ALLOWED_ACTIONS 状态表叠加当前
     * 教学策略门禁），客户端不得本地查表推导——策略层变化以本字段为准。
     */
    allowedActions: z.array(aiTaskActionSchema),
    materials: z.array(aiTaskMaterialSchema),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type AiTaskPublic = z.infer<typeof aiTaskPublicSchema>;

/** 教师域任务视图：在公开视图上追加提示词哈希与完整快照（本域可见全部） */
export const aiTaskTeacherSchema = aiTaskPublicSchema
  .extend({
    promptHash: z.string().min(1),
    contextSnapshot: aiContextSnapshotSchema,
  })
  .strict();
export type AiTaskTeacher = z.infer<typeof aiTaskTeacherSchema>;

// ---------- MCP 领取视图（领取即授权外发，携带全量上下文与租约） ----------

/** 领取视图的材料条目：服务端签发的下载 URL（不暴露内部路径） */
export const aiMcpClaimMaterialSchema = z
  .object({
    index: z.number().int().min(0),
    kind: aiMaterialKindSchema,
    downloadUrl: z.string().min(1),
    byteSize: z.number().int().positive(),
    pixelWidth: z.number().int().positive(),
    pixelHeight: z.number().int().positive(),
  })
  .strict();
export type AiMcpClaimMaterial = z.infer<typeof aiMcpClaimMaterialSchema>;

/** MCP 领取视图（claim_ai_task 的 context 载荷）：含答案解析 + 租约（写回必需） */
export const aiMcpClaimViewSchema = z
  .object({
    taskId: z.uuid(),
    attemptId: z.uuid(),
    questionId: z.string().min(1),
    questionRevisionId: questionRevisionIdSchema,
    context: aiContextSnapshotSchema,
    materials: z.array(aiMcpClaimMaterialSchema),
    lease: z
      .object({
        leaseToken: z.string().min(1),
        leaseUntil: z.string().min(1),
      })
      .strict(),
    /** 已用对话轮次（写回前校验 §9 同题 20 轮上限） */
    turnsUsed: z.number().int().min(0),
  })
  .strict();
export type AiMcpClaimView = z.infer<typeof aiMcpClaimViewSchema>;

// ---------- 分享视图（票据读端点，单快照只读） ----------

/** 分享视图附件条目：仅本题已选材料，URL 绑定票据 */
export const aiShareMaterialSchema = z
  .object({
    index: z.number().int().min(0),
    kind: aiMaterialKindSchema,
    downloadUrl: z.string().min(1),
    byteSize: z.number().int().positive(),
  })
  .strict();
export type AiShareMaterial = z.infer<typeof aiShareMaterialSchema>;

/**
 * 分享视图（GET /api/public/ai/share/:ticket 响应 data）：
 * 仅对应一个任务快照（题号+快照时间+上下文+材料引用），绝不携带
 * 个人全量任务列表；撤销/过期/禁用时端点拒绝（AI_SHARE_*）。
 */
export const aiShareViewSchema = z
  .object({
    taskId: z.uuid(),
    /** 展示题号（如「第 27 题」，帮助识别缓存旧内容） */
    questionLabel: z.string().min(1),
    snapshotAt: z.string().min(1),
    context: aiContextSnapshotSchema,
    studentQuestion: z.string().min(1),
    materials: z.array(aiShareMaterialSchema),
  })
  .strict();
export type AiShareView = z.infer<typeof aiShareViewSchema>;

// ---------- 内部执行载荷（页内出站，服务端专用） ----------

/**
 * 页内出站执行载荷（内部视图）：代际先行落库、凭证按连接引用在服务端取用，
 * 载荷本身不携带明文密钥。学生备注/题面/笔迹文本在 systemPromptMd 中以
 * 待分析数据包裹（注入防御），不拼进 system 指令段。
 */
export const aiDispatchPayloadSchema = z
  .object({
    taskId: z.uuid(),
    /** 运行代际：每次出站尝试自增并先落库；回写按 (taskId, generation) CAS */
    generation: z.number().int().positive(),
    connectionId: z.uuid(),
    systemPromptMd: z.string().min(1),
    contextSnapshot: aiContextSnapshotSchema,
    historyMessages: z.array(aiMessageSchema),
    studentQuestion: z.string().min(1).max(AI_QUESTION_MAX_CHARS),
    materials: z.array(aiTaskMaterialInternalSchema),
    channel: aiChannelSchema,
    modeAtSend: aiTeachingModeSchema,
  })
  .strict();
export type AiDispatchPayload = z.infer<typeof aiDispatchPayloadSchema>;

// ---------- 错误码 ----------

/**
 * 学生端 AI 任务/连接模块错误码（UPPER_SNAKE_CODE 固定子集，B00 §4.2/§9）：
 * - AI_POLICY_DISABLED：当前教学模式禁用（新建/领取/票据/附件读取一致拒绝）；
 * - AI_TASK_LIMIT_REACHED：进行中/待处理/日任务任一超限；
 * - AI_CONNECTION_NOT_CONFIGURED / AI_FIRST_USE_REQUIRED：未配置连接 / 首次知情未确认；
 * - AI_ATTEMPT_ABANDONED：作答已作废（一切 AI 读写拒绝）；
 * - AI_MATERIAL_TOO_LARGE / AI_MATERIAL_COUNT：材料字节/数量超限；
 * - AI_OUTBOUND_FAILED / AI_OUTBOUND_TIMEOUT / AI_BUSY：出站失败/超时/并发上限；
 * - AI_TURNS_LIMIT：同题对话轮数超限；
 * - AI_STATE_CONFLICT：状态 CAS 不符（取消/恢复/重试）；
 * - AI_TEXT_TOO_LONG：问题/追问文本超限；
 * - AI_BATCH_LIMIT：批量复盘题数超限；
 * - AI_LEASE_EXPIRED：MCP 租约过期（迟到写回仅记 late_reply 事实）；
 * - AI_SHARE_EXPIRED / AI_SHARE_REVOKED：票据过期/撤销；
 * - AI_CONNECTION_INVALID：连接配置校验失败；
 * - UNAUTHORIZED / FORBIDDEN / NOT_FOUND / VALIDATION_ERROR：通用口径同义。
 */
export const aiErrorCodeSchema = z.enum([
  "AI_POLICY_DISABLED",
  "AI_TASK_LIMIT_REACHED",
  "AI_CONNECTION_NOT_CONFIGURED",
  "AI_FIRST_USE_REQUIRED",
  "AI_ATTEMPT_ABANDONED",
  "AI_MATERIAL_TOO_LARGE",
  "AI_MATERIAL_COUNT",
  "AI_OUTBOUND_FAILED",
  "AI_OUTBOUND_TIMEOUT",
  "AI_TURNS_LIMIT",
  "AI_STATE_CONFLICT",
  "AI_TEXT_TOO_LONG",
  "AI_BATCH_LIMIT",
  "AI_BUSY",
  "AI_LEASE_EXPIRED",
  "AI_SHARE_EXPIRED",
  "AI_SHARE_REVOKED",
  "AI_CONNECTION_INVALID",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
]);
export type AiErrorCode = z.infer<typeof aiErrorCodeSchema>;
