import { z } from "zod";
import { questionRevisionIdSchema } from "./attempt.ts";
import {
  AI_API_KEY_MAX_CHARS,
  AI_BATCH_MAX_QUESTIONS,
  AI_CONNECTION_BASE_URL_MAX_CHARS,
  AI_CONNECTION_MODEL_MAX_CHARS,
  AI_QUESTION_MAX_CHARS,
  AI_SHARE_MAX_VALID_HOURS,
  aiChannelSchema,
  aiConnectionFirstCredentialSchema,
  aiConnectionPublicSchema,
  aiConnectionVerifyStatusSchema,
  aiFactSchema,
  aiHelpQuestionFactsSchema,
  aiImageCapabilitySchema,
  aiMessageSchema,
  aiShareViewSchema,
  aiTaskMaterialSchema,
  aiTaskOriginSummarySchema,
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

/** 学生问题/追问文本字段：trim 后 1–2000 字符（§9；UTF-8 字节数服务端复核） */
function questionField(label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label}不能为空`)
    .max(AI_QUESTION_MAX_CHARS, `${label}最多 ${AI_QUESTION_MAX_CHARS} 个字符`);
}

/** 票据/链接有效期字段：1–72 整数小时（§9） */
function shareValidHoursField() {
  return z
    .number()
    .int()
    .min(1, "有效期至少 1 小时")
    .max(
      AI_SHARE_MAX_VALID_HOURS,
      `有效期最多 ${AI_SHARE_MAX_VALID_HOURS} 小时`,
    );
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
    question: questionField("问题"),
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

// ---------- POST /api/student/ai/tasks/:id/update-pending ----------

/**
 * 待处理任务更新请求（需求 §8「学生显式更新待处理内容」，仅 created 态可用）：
 * question 省略 = 只按当前作答重新装配快照；提供则替换首条问题正文。
 * 材料变化不走本接口（换材料 = 新任务/新 mutationId，SAI-11 attach 语义）。
 */
export const aiTaskUpdatePendingRequestSchema = z
  .object({
    question: questionField("问题").optional(),
  })
  .strict();
export type AiTaskUpdatePendingRequest = z.infer<
  typeof aiTaskUpdatePendingRequestSchema
>;

// ---------- POST /api/student/ai/tasks/:id/followup ----------

/**
 * 同题追问请求：绑定路径上的父任务，不接受 questionId/attemptId——
 * 不能把另一题 ID 合法拼进一个任务（追问只引用本题当前对话）。
 */
export const aiTaskFollowupRequestSchema = z
  .object({
    question: questionField("追问"),
    /** 追问幂等键：与创建同强度必填（网络重试不产生重复追问与重复计费出站） */
    mutationId: z.string().min(1),
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

/**
 * 票据生成请求：有效期上限 72h（§9）。validHours 省略时**不在 schema 固化默认**——
 * 服务端按该学生 link 连接的 defaultValidHours 偏好回退，无偏好才用 §9 默认 24h；
 * 若在解析期落默认，连接偏好将永远无法生效。
 */
export const aiTaskShareRequestSchema = z
  .object({
    validHours: shareValidHoursField().optional(),
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
    /**
     * 归档过滤（SAI-23）：exclude = 默认队列视图（隐藏已归档）、only = 已归档
     * 分组；缺省 = 全部——既有单题历史调用方不受归档影响（对话记录不因整理
     * 队列而从本题历史消失）。
     */
    archived: z.enum(["exclude", "only"]).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: aiTaskListCursorSchema.optional(),
  })
  .strict();
export type AiTaskListQuery = z.infer<typeof aiTaskListQuerySchema>;

export const aiTaskListDataSchema = z
  .object({
    tasks: z.array(aiTaskPublicSchema),
    nextCursor: z.string().nullable(),
    /** 来源摘要按任务 id 索引（SAI-23 全局队列展示/导航用；单题历史可省略） */
    origins: z.record(z.string(), aiTaskOriginSummarySchema).optional(),
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

/** 全局队列摘要：待领取/处理中/未读三计数含义分开（分桶单源 AI_TASK_QUEUE_BUCKETS） */
export const aiQueueSummaryDataSchema = z
  .object({
    /** 待领取（pending 桶：created） */
    pendingCount: z.number().int().min(0),
    /** 处理中（processing 桶：dispatching/claimed/uncertain） */
    processingCount: z.number().int().min(0),
    /** 已回信未读（replied 且 replyDeliveredAt 为空，交付态推导非状态分桶） */
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

/** mcp 成员（创建/更新共用：token 服务端生成，无凭证入参；更新另加 resetToken） */
const aiConnectionMcpMemberSchema = z
  .object({
    channel: z.literal("mcp"),
    /** token 由服务端生成，明文只在创建/重置响应显示一次 */
    isDefault: z.boolean().optional(),
  })
  .strict();

/** link 成员（创建/更新共用同一形态：无凭证入参，仅票据偏好与默认位） */
const aiConnectionLinkMemberSchema = z
  .object({
    channel: z.literal("link"),
    defaultValidHours: shareValidHoursField().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

/** 连接创建请求（inapp：明文 Key 只出现在写请求；mcp/link：无凭证入参） */
export const aiConnectionCreateRequestSchema = z.discriminatedUnion("channel", [
  z
    .object({
      channel: z.literal("inapp"),
      baseUrl: z.url().max(AI_CONNECTION_BASE_URL_MAX_CHARS),
      model: z.string().trim().min(1).max(AI_CONNECTION_MODEL_MAX_CHARS),
      /** 明文 API Key：仅创建/更新请求出现，任何响应只回指纹 */
      apiKey: z.string().min(1).max(AI_API_KEY_MAX_CHARS),
      imageCapability: aiImageCapabilitySchema.optional(),
      isDefault: z.boolean().optional(),
    })
    .strict(),
  aiConnectionMcpMemberSchema,
  aiConnectionLinkMemberSchema,
]);
export type AiConnectionCreateRequest = z.infer<
  typeof aiConnectionCreateRequestSchema
>;

/** 连接更新请求（PATCH：全部可选，缺省 = 不改；inapp 不传 apiKey = 保持原 Key） */
export const aiConnectionPatchRequestSchema = z.discriminatedUnion("channel", [
  z
    .object({
      channel: z.literal("inapp"),
      baseUrl: z.url().max(AI_CONNECTION_BASE_URL_MAX_CHARS).optional(),
      model: z
        .string()
        .trim()
        .min(1)
        .max(AI_CONNECTION_MODEL_MAX_CHARS)
        .optional(),
      apiKey: z.string().min(1).max(AI_API_KEY_MAX_CHARS).optional(),
      imageCapability: aiImageCapabilitySchema.optional(),
      isDefault: z.boolean().optional(),
    })
    .strict(),
  aiConnectionMcpMemberSchema.extend({
    /** 重置 token：旧 token 立即失效，新明文只在 PATCH 响应出现一次 */
    resetToken: z.boolean().optional(),
  }),
  aiConnectionLinkMemberSchema,
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

/**
 * PATCH /ai/connections/:id 响应 data：与创建同形——公开视图 + 可选一次性
 * 凭证（仅 mcp 重置 token 时非 null，明文只在本响应出现一次）。
 */
export const aiConnectionPatchDataSchema = aiConnectionCreateDataSchema;
export type AiConnectionPatchData = AiConnectionCreateData;
export const aiConnectionPatchOkSchema = apiOkExtend(
  aiConnectionPatchDataSchema,
);

/** DELETE /ai/connections/:id 响应 data：只回删除的连接 id（无凭证回显） */
export const aiConnectionDeleteDataSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();
export type AiConnectionDeleteData = z.infer<
  typeof aiConnectionDeleteDataSchema
>;
export const aiConnectionDeleteOkSchema = apiOkExtend(
  aiConnectionDeleteDataSchema,
);

// ---------- 学生 MCP 工具载荷（/mcp/student，JSON-RPC 参数体） ----------

/** list_my_ai_tasks 条目：待领取任务的只读引用 */
export const aiMcpTaskRefSchema = z
  .object({
    taskId: z.uuid(),
    attemptId: z.uuid(),
    questionId: z.string().min(1),
    questionRevisionId: questionRevisionIdSchema,
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
 * 他人已领取时拒绝写正文，仅记 late_reply 事实）。回信超长不在这里硬拒：
 * 服务端按 AI_REPLY_MAX_CHARS 截断并显式声明（§9「写回校验」列的既定语义）。
 */
export const aiMcpSubmitReplyRequestSchema = z
  .object({
    taskId: z.uuid(),
    leaseToken: z.string().min(1),
    replyMarkdown: z.string().min(1, "回信不能为空"),
  })
  .strict();
export type AiMcpSubmitReplyRequest = z.infer<
  typeof aiMcpSubmitReplyRequestSchema
>;

// ---------- GET /api/public/ai/share/:ticket（无会话，票据即授权） ----------

/** 票据读响应 data 即分享视图本体（与领域层 aiShareViewSchema 同源，非复制） */
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
    question: questionField("复盘诉求"),
    /** 批量幂等键：与单题创建同强度必填——误触重复提交只产生一批任务（需求 §8） */
    mutationId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    // 条目去重：同一 (attemptId, questionId) 重复出现即拒绝，不静默合并
    const seen = new Set<string>();
    for (const item of value.items) {
      const key = `${item.attemptId}\n${item.questionId}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: "批量条目重复" });
        return;
      }
      seen.add(key);
    }
  });
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

/** 按卷求助记录的任务行（抽屉时间线的轻量形态：无回信正文、无材料图） */
export const aiTeacherTaskRecordSchema = z
  .object({
    taskId: z.uuid(),
    questionId: z.string().min(1),
    status: aiTaskStatusSchema,
    channel: aiChannelSchema,
    modeAtSend: aiTeachingModeSchema,
    /** 创建时服务端判定的提交前/提交后（事实行另有各自时点判定） */
    beforeSubmit: z.boolean(),
    /** 学生诉求（首条学生消息正文） */
    question: z.string().min(1),
    hasReply: z.boolean(),
    /** 学生打开回信时刻；null = 未查看（含已收信未读与未回信） */
    replyDeliveredAt: z.string().nullable(),
    /** 最近失败摘要（failed 态）；无失败为 null */
    errorText: z.string().nullable(),
    /** 显式重试次数 */
    retryCount: z.number().int().min(0),
    /** 学生归档时刻（SAI-23：归档不抹事实，仅移出学生默认队列视图）；null = 未归档 */
    archivedAt: z.string().nullable(),
    /** 取消请求时刻（claimed 后取消：阻止交付，回信仍入库为事实）；null = 未请求 */
    cancelRequestedAt: z.string().nullable(),
    createdAt: z.string().min(1),
    /** 事实时间线（教师域视图：detail 含通道/当时模式/错误摘要） */
    facts: z.array(aiTeacherFactSchema),
  })
  .strict();
export type AiTeacherTaskRecord = z.infer<typeof aiTeacherTaskRecordSchema>;

/**
 * GET /api/teacher/attempts/:id/ai-records 响应 data：按卷求助记录抽屉。
 * - questions：每题事实摘要（distinct 题数而非请求次数——SAI-14 派生口径，
 *   服务端由 aiHelpFactsSummariesOf 计算；无记录的题不在数组，由调用方按
 *   零态呈现「无平台作答中求助记录」）；
 * - records：本卷全部任务行（轻量：回信正文与材料图不在此——教师按任务
 *   按需经 GET /ai/tasks/:id 与材料 PNG 端点加载，B13 实施步骤 6）。
 */
export const aiTeacherAttemptRecordsDataSchema = z
  .object({
    attemptId: z.uuid(),
    questions: z.array(
      z
        .object({
          questionId: z.string().min(1),
          facts: aiHelpQuestionFactsSchema,
        })
        .strict(),
    ),
    records: z.array(aiTeacherTaskRecordSchema),
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
