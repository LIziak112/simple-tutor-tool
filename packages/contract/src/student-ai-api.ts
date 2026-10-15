import { z } from "zod";
import {
  AI_BATCH_MAX_QUESTIONS,
  AI_QUESTION_MAX_CHARS,
  AI_REPLY_MAX_CHARS,
  AI_SHARE_DEFAULT_VALID_HOURS,
  AI_SHARE_MAX_VALID_HOURS,
  aiChannelSchema,
  aiConnectionFirstCredentialSchema,
  aiConnectionPublicSchema,
  aiConnectionVerifyStatusSchema,
  aiFactSchema,
  aiImageCapabilitySchema,
  aiMessageSchema,
  aiShareViewSchema,
  aiTaskMaterialSchema,
  aiTaskPublicSchema,
  aiTaskStatusSchema,
  aiTaskTeacherSchema,
  aiTeacherFactSchema,
} from "./student-ai.ts";
import {
  aiMaterialPreferenceSchema,
  aiPolicyResolutionSchema,
  aiTeachingModeSchema,
} from "./student-ai-policy.ts";

/**
 * 学生端 AI 伴学：任务/材料/队列/连接 API 契约（SAI-03 起为权威定义，
 * 对应 B00 §4.2 API 表；教师设置与覆盖接口在 student-ai-policy.ts）。
 *
 * 约定（与 student.ts 一致）：
 * - 本文件只定义请求体/查询参数与 data 部分；响应壳统一由 index.ts 描述，
 *   此处仅用局部 helper 具体化成功壳（避免循环依赖）；
 * - 学生端请求全部 strict——effectiveMode/teacherId/questionId（追问拼他题）
 *   等越权字段出现在请求里即整体拒绝，服务器权威字段只在响应中出现；
 * - 分页游标是不透明字符串 token，不接受任意查询结构；
 * - 材料上传为 multipart（无 JSON 请求 schema），字节/数量防线见限额常量。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ---------- GET /api/student/ai/status ----------

/** 状态查询：作答 + 题目定位（不能只传 questionId） */
export const aiStatusQuerySchema = z
  .object({
    attemptId: z.uuid(),
    questionId: z.string().min(1),
  })
  .strict();
export type AiStatusQuery = z.infer<typeof aiStatusQuerySchema>;

/** 状态响应 data：有效裁决（policy 契约）+ 完成态 + 连接态 + 本题任务摘要 */
export const aiStatusDataSchema = z
  .object({
    /** 有效模式与原因（服务端裁决输出，见 student-ai-policy.ts） */
    resolution: aiPolicyResolutionSchema,
    /** 本题是否完成（服务端唯一口径：questionPhaseOf） */
    completed: z.boolean(),
    /** 当前默认通道；null = 未配置任何连接 */
    channelDefault: aiChannelSchema.nullable(),
    /** 默认通道是否可用（已配置且非 needs_rekey） */
    connectionReady: z.boolean(),
    /** 默认通道是否还需首次知情确认 */
    firstUseRequired: z.boolean(),
    taskSummary: z
      .object({
        total: z.number().int().min(0),
        active: z.number().int().min(0),
        unreadReplies: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
export type AiStatusData = z.infer<typeof aiStatusDataSchema>;
export const aiStatusOkSchema = apiOkExtend(aiStatusDataSchema);

// ---------- POST /api/student/ai/tasks ----------

/**
 * 任务创建请求：attemptId + questionId 定位（服务端解析 questionRevisionId，
 * 客户端不传修订 id）；mutationId 幂等键（同参数重复点击只产生一次）；
 * materials 为本次任务的三类材料选择（§4.2）；quickButtonId 可选回显来源。
 */
export const aiTaskCreateRequestSchema = z
  .object({
    attemptId: z.uuid(),
    questionId: z.string().min(1),
    question: z
      .string()
      .trim()
      .min(1, "问题不能为空")
      .max(AI_QUESTION_MAX_CHARS, `问题最多 ${AI_QUESTION_MAX_CHARS} 个字符`),
    channel: aiChannelSchema,
    materials: aiMaterialPreferenceSchema,
    /** 客户端幂等键（uuid 或等价不透明串；服务端唯一索引） */
    mutationId: z.string().min(1),
    /** 来源快捷按钮（可选，仅回显与统计） */
    quickButtonId: z.string().min(1).optional(),
  })
  .strict();
export type AiTaskCreateRequest = z.infer<typeof aiTaskCreateRequestSchema>;

export const aiTaskOkSchema = apiOkExtend(aiTaskPublicSchema);

// ---------- POST /api/student/ai/tasks/:id/followup ----------

/**
 * 同题追问请求：绑定路径上的父任务，不接受 questionId/attemptId——
 * 不能把另一题 ID 合法拼进一个任务（追问只引用本题当前对话）。
 */
export const aiTaskFollowupRequestSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1, "追问不能为空")
      .max(AI_QUESTION_MAX_CHARS, `追问最多 ${AI_QUESTION_MAX_CHARS} 个字符`),
    /** 追问幂等键（可选；网络重试不产生重复追问） */
    mutationId: z.string().min(1).optional(),
  })
  .strict();
export type AiTaskFollowupRequest = z.infer<typeof aiTaskFollowupRequestSchema>;

/** 追问响应 data：任务 + 本题对话（页内出站，AI_TURNS_LIMIT 前置校验） */
export const aiTaskFollowupDataSchema = z
  .object({
    task: aiTaskPublicSchema,
    messages: z.array(aiMessageSchema),
  })
  .strict();
export type AiTaskFollowupData = z.infer<typeof aiTaskFollowupDataSchema>;
export const aiTaskFollowupOkSchema = apiOkExtend(aiTaskFollowupDataSchema);

// ---------- POST /api/student/ai/tasks/:id/share ----------

/** 票据生成请求：有效期默认 24h、上限 72h（§9） */
export const aiTaskShareRequestSchema = z
  .object({
    validHours: z
      .number()
      .int()
      .min(1, "票据有效期至少 1 小时")
      .max(
        AI_SHARE_MAX_VALID_HOURS,
        `票据有效期最多 ${AI_SHARE_MAX_VALID_HOURS} 小时`,
      )
      .default(AI_SHARE_DEFAULT_VALID_HOURS),
  })
  .strict();
export type AiTaskShareRequest = z.infer<typeof aiTaskShareRequestSchema>;

/** 票据生成响应 data：URL + 快照时间 + 过期时刻 */
export const aiTaskShareDataSchema = z
  .object({
    ticketUrl: z.string().min(1),
    snapshotAt: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .strict();
export type AiTaskShareData = z.infer<typeof aiTaskShareDataSchema>;
export const aiTaskShareOkSchema = apiOkExtend(aiTaskShareDataSchema);

// ---------- GET /api/student/ai/tasks（分页） ----------

/** 分页游标：不透明字符串 token（服务端签发/校验），不接受任意查询结构 */
export const aiTaskListCursorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "分页游标格式非法");

export const aiTaskListQuerySchema = z
  .object({
    attemptId: z.uuid().optional(),
    questionId: z.string().min(1).optional(),
    status: aiTaskStatusSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: aiTaskListCursorSchema.optional(),
  })
  .strict();
export type AiTaskListQuery = z.infer<typeof aiTaskListQuerySchema>;

export const aiTaskListDataSchema = z
  .object({
    tasks: z.array(aiTaskPublicSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type AiTaskListData = z.infer<typeof aiTaskListDataSchema>;
export const aiTaskListOkSchema = apiOkExtend(aiTaskListDataSchema);

/** GET /api/student/ai/tasks/:id 响应 data：任务 + 对话 + facts（学生投影，无 detail） */
export const aiTaskDetailDataSchema = z
  .object({
    task: aiTaskPublicSchema,
    messages: z.array(aiMessageSchema),
    facts: z.array(aiFactSchema),
  })
  .strict();
export type AiTaskDetailData = z.infer<typeof aiTaskDetailDataSchema>;
export const aiTaskDetailOkSchema = apiOkExtend(aiTaskDetailDataSchema);

// ---------- GET /api/student/ai/queue-summary ----------

/** 全局队列摘要：待领取/处理中/未读三计数含义分开（§6.1） */
export const aiQueueSummaryDataSchema = z
  .object({
    /** 待领取（created+mcp）与暂停待继续 */
    pendingCount: z.number().int().min(0),
    /** 处理中（dispatching+claimed+uncertain） */
    processingCount: z.number().int().min(0),
    /** 已回信未读（replied 且 replyDeliveredAt 为空） */
    unreadReplyCount: z.number().int().min(0),
  })
  .strict();
export type AiQueueSummaryData = z.infer<typeof aiQueueSummaryDataSchema>;
export const aiQueueSummaryOkSchema = apiOkExtend(aiQueueSummaryDataSchema);

// ---------- POST /api/student/ai/tasks/:id/materials（multipart） ----------

/** 材料上传回执 data：逐项材料行 + 合计字节（不虚报已附图，缺件指明失败项） */
export const aiMaterialUploadReceiptDataSchema = z
  .object({
    materials: z.array(aiTaskMaterialSchema),
    totalBytes: z.number().int().min(0),
  })
  .strict();
export type AiMaterialUploadReceiptData = z.infer<
  typeof aiMaterialUploadReceiptDataSchema
>;
export const aiMaterialUploadReceiptOkSchema = apiOkExtend(
  aiMaterialUploadReceiptDataSchema,
);

// ---------- /api/student/ai/connections ----------

/** 连接创建请求（inapp：明文 Key 只出现在写请求；mcp/link：无凭证入参） */
export const aiConnectionCreateRequestSchema = z.discriminatedUnion("channel", [
  z
    .object({
      channel: z.literal("inapp"),
      baseUrl: z.url(),
      model: z.string().trim().min(1).max(200),
      /** 明文 API Key：仅创建/更新请求出现，任何响应只回指纹 */
      apiKey: z.string().min(1),
      imageCapability: aiImageCapabilitySchema.optional(),
      isDefault: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      channel: z.literal("mcp"),
      /** token 由服务端生成，明文只在创建响应显示一次 */
      isDefault: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      channel: z.literal("link"),
      defaultValidHours: z
        .number()
        .int()
        .min(1)
        .max(AI_SHARE_MAX_VALID_HOURS)
        .optional(),
      isDefault: z.boolean().optional(),
    })
    .strict(),
]);
export type AiConnectionCreateRequest = z.infer<
  typeof aiConnectionCreateRequestSchema
>;

/** 连接更新请求（PATCH：全部可选，缺省 = 不改；inapp 不传 apiKey = 保持原 Key） */
export const aiConnectionPatchRequestSchema = z.discriminatedUnion("channel", [
  z
    .object({
      channel: z.literal("inapp"),
      baseUrl: z.url().optional(),
      model: z.string().trim().min(1).max(200).optional(),
      apiKey: z.string().min(1).optional(),
      imageCapability: aiImageCapabilitySchema.optional(),
      isDefault: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      channel: z.literal("mcp"),
      isDefault: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      channel: z.literal("link"),
      defaultValidHours: z
        .number()
        .int()
        .min(1)
        .max(AI_SHARE_MAX_VALID_HOURS)
        .optional(),
      isDefault: z.boolean().optional(),
    })
    .strict(),
]);
export type AiConnectionPatchRequest = z.infer<
  typeof aiConnectionPatchRequestSchema
>;

export const aiConnectionListDataSchema = z
  .object({
    connections: z.array(aiConnectionPublicSchema),
  })
  .strict();
export type AiConnectionListData = z.infer<typeof aiConnectionListDataSchema>;
export const aiConnectionListOkSchema = apiOkExtend(aiConnectionListDataSchema);

/**
 * 连接创建响应 data：credential 仅 mcp 创建/重置时非 null（明文 token 一次性）；
 * inapp/link 恒 null。明文凭证使用独立的 aiConnectionFirstCredentialSchema。
 */
export const aiConnectionCreateDataSchema = z
  .object({
    connection: aiConnectionPublicSchema,
    credential: aiConnectionFirstCredentialSchema.nullable(),
  })
  .strict();
export type AiConnectionCreateData = z.infer<
  typeof aiConnectionCreateDataSchema
>;
export const aiConnectionCreateOkSchema = apiOkExtend(
  aiConnectionCreateDataSchema,
);

/** POST /ai/connections/:id/test 响应 data：验证结果 + 时刻 + 说明 */
export const aiConnectionTestDataSchema = z
  .object({
    verifyStatus: aiConnectionVerifyStatusSchema,
    verifiedAt: z.string().nullable(),
    message: z.string().nullable(),
  })
  .strict();
export type AiConnectionTestData = z.infer<typeof aiConnectionTestDataSchema>;
export const aiConnectionTestOkSchema = apiOkExtend(aiConnectionTestDataSchema);

// ---------- 学生 MCP 工具载荷（/mcp/student，JSON-RPC 参数体） ----------

/** list_my_ai_tasks 条目：待领取任务的只读引用 */
export const aiMcpTaskRefSchema = z
  .object({
    taskId: z.uuid(),
    attemptId: z.uuid(),
    questionId: z.string().min(1),
    questionRevisionId: z.uuid(),
    status: aiTaskStatusSchema,
    createdAt: z.string().min(1),
  })
  .strict();
export type AiMcpTaskRef = z.infer<typeof aiMcpTaskRefSchema>;

export const aiMcpListMyTasksDataSchema = z
  .object({
    tasks: z.array(aiMcpTaskRefSchema),
  })
  .strict();
export type AiMcpListMyTasksData = z.infer<typeof aiMcpListMyTasksDataSchema>;

/**
 * submit_ai_reply 写回请求：taskId + leaseToken 必带（租约 CAS——过期或
 * 他人已领取时拒绝写正文，仅记 late_reply 事实）；回信限长 32KiB。
 */
export const aiMcpSubmitReplyRequestSchema = z
  .object({
    taskId: z.uuid(),
    leaseToken: z.string().min(1),
    replyMarkdown: z
      .string()
      .min(1, "回信不能为空")
      .max(AI_REPLY_MAX_CHARS, "回信超过单条上限，请分条写回"),
  })
  .strict();
export type AiMcpSubmitReplyRequest = z.infer<
  typeof aiMcpSubmitReplyRequestSchema
>;

// ---------- GET /api/public/ai/share/:ticket（无会话，票据即授权） ----------

/** 票据读响应 data 即分享视图（单快照；错误码 AI_SHARE_EXPIRED/REVOKED/POLICY_DISABLED） */
export const aiShareViewDataSchema = aiShareViewSchema;
export type AiShareViewData = z.infer<typeof aiShareViewDataSchema>;
export const aiShareOkSchema = apiOkExtend(aiShareViewDataSchema);

// ---------- 批量复盘（B16 预留契约，错误码 AI_BATCH_LIMIT） ----------

/** 批量条目：只收作答与题目定位，逐项可定位结果 */
export const aiBatchReviewItemSchema = z
  .object({
    attemptId: z.uuid(),
    questionId: z.string().min(1),
  })
  .strict();
export type AiBatchReviewItem = z.infer<typeof aiBatchReviewItemSchema>;

export const aiBatchReviewCreateRequestSchema = z
  .object({
    items: z
      .array(aiBatchReviewItemSchema)
      .min(1, "至少选择一道题")
      .max(
        AI_BATCH_MAX_QUESTIONS,
        `单次批量最多 ${AI_BATCH_MAX_QUESTIONS} 道题`,
      ),
    channel: aiChannelSchema,
    question: z
      .string()
      .trim()
      .min(1, "复盘诉求不能为空")
      .max(AI_QUESTION_MAX_CHARS),
  })
  .strict();
export type AiBatchReviewCreateRequest = z.infer<
  typeof aiBatchReviewCreateRequestSchema
>;

/** 批量结果：成功/失败/部分成功/暂停逐项定位，只重试失败项不重发已成功题 */
export const aiBatchCreateItemResultSchema = z
  .object({
    attemptId: z.uuid(),
    questionId: z.string().min(1),
    outcome: z.enum(["created", "already_exists", "paused", "failed"]),
    taskId: z.uuid().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type AiBatchCreateItemResult = z.infer<
  typeof aiBatchCreateItemResultSchema
>;

export const aiBatchCreateDataSchema = z
  .object({
    items: z.array(aiBatchCreateItemResultSchema),
    summary: z
      .object({
        created: z.number().int().min(0),
        alreadyExists: z.number().int().min(0),
        paused: z.number().int().min(0),
        failed: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
export type AiBatchCreateData = z.infer<typeof aiBatchCreateDataSchema>;
export const aiBatchCreateOkSchema = apiOkExtend(aiBatchCreateDataSchema);

// ---------- 教师端督学记录（B00 §4.2 教师表；B13 实现接口） ----------

/** GET /api/teacher/attempts/:id/ai-records 响应 data：按卷求助记录抽屉 */
export const aiTeacherAttemptRecordsDataSchema = z
  .object({
    attemptId: z.uuid(),
    records: z.array(
      z
        .object({
          taskId: z.uuid(),
          questionId: z.string().min(1),
          status: aiTaskStatusSchema,
          channel: aiChannelSchema,
          modeAtSend: aiTeachingModeSchema,
          beforeSubmit: z.boolean(),
          question: z.string().min(1),
          hasReply: z.boolean(),
          createdAt: z.string().min(1),
          facts: z.array(aiTeacherFactSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type AiTeacherAttemptRecordsData = z.infer<
  typeof aiTeacherAttemptRecordsDataSchema
>;
export const aiTeacherAttemptRecordsOkSchema = apiOkExtend(
  aiTeacherAttemptRecordsDataSchema,
);

/** GET /api/teacher/ai/tasks/:id 响应 data：教师域任务详情（快照+对话+事实） */
export const aiTeacherTaskDetailDataSchema = z
  .object({
    task: aiTaskTeacherSchema,
    messages: z.array(aiMessageSchema),
    facts: z.array(aiTeacherFactSchema),
  })
  .strict();
export type AiTeacherTaskDetailData = z.infer<
  typeof aiTeacherTaskDetailDataSchema
>;
export const aiTeacherTaskDetailOkSchema = apiOkExtend(
  aiTeacherTaskDetailDataSchema,
);
