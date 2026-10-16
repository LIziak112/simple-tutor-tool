import { expect, it } from "vitest";
import {
  AI_API_KEY_MAX_CHARS,
  AI_BATCH_MAX_QUESTIONS,
  AI_CONNECTION_TEST_TIMEOUT_MS,
  AI_MATERIAL_MAX_COUNT,
  AI_MATERIAL_PNG_MAX_BYTES,
  AI_MATERIAL_TOTAL_MAX_BYTES,
  AI_MCP_LEASE_MINUTES,
  AI_OUTBOUND_TIMEOUT_MS,
  AI_QUESTION_MAX_CHARS,
  AI_REPLY_MAX_CHARS,
  AI_SHARE_DEFAULT_VALID_HOURS,
  AI_SHARE_MAX_VALID_HOURS,
  AI_TASK_ACTIVE_PER_QUESTION,
  AI_TASK_ALLOWED_ACTIONS,
  AI_TASK_DAILY_PER_STUDENT,
  AI_TASK_PENDING_PER_STUDENT,
  AI_TURNS_MAX,
  aiConnectionFirstCredentialSchema,
  aiConnectionPublicSchema,
  aiContextSnapshotSchema,
  aiDispatchPayloadSchema,
  aiErrorCodeSchema,
  aiFactSchema,
  aiMcpClaimViewSchema,
  aiMessageSchema,
  aiShareViewSchema,
  aiTaskMaterialInternalSchema,
  aiTaskActionSchema,
  aiTaskMaterialSchema,
  aiTaskOriginSummarySchema,
  aiTaskPublicSchema,
  aiTaskStatusSchema,
} from "./student-ai";
import {
  aiConnectionCreateDataSchema,
  aiConnectionCreateRequestSchema,
  aiConnectionDeleteDataSchema,
  aiConnectionListDataSchema,
  aiConnectionPatchDataSchema,
  aiConnectionPatchRequestSchema,
  aiConnectionTestDataSchema,
} from "./student-ai-api";

/**
 * SAI-03 任务、材料与连接领域契约测试（B01 批次断言逐条落地）。
 * 视图边界（B00 §3.6）：学生 Cookie 公开视图、MCP 领取视图、分享视图、
 * 内部执行载荷分开定义——公开 schema 不含 secret/lease/绝对路径/快照原文；
 * 快照含答案解析是受控 AI 出口的合法内容（AGENTS.md 受控例外），
 * 教师私注（teacherComment）不属于任何快照/载荷 schema。
 */

const fullContext = {
  questionRevisionId: "0b7a8f1e-1111-4222-8333-444455556666",
  questionId: "unit-a-q1",
  questionType: "fill",
  stemMd: "计算：$(-3)+7=$ [[4]]",
  knowledgePoints: ["有理数加法"],
  difficulty: 2,
  studentAnswerText: "第1空：4",
  referenceAnswerMd: "4",
  solutionMd: "$(-3)+7=4$；同号相加取相同符号。",
  missingNote: null,
  promptSnapshotMd: "【模式硬约束】仅启发：不直接给最终答案……",
  capturedAt: "2026-10-15T10:00:00.000Z",
};

const validMaterial = {
  id: "1c2d3e4f-0000-4000-8000-aaaaaaaaaaaa",
  taskId: "2d3e4f5a-0000-4000-8000-bbbbbbbbbbbb",
  kind: "draft",
  pageIndex: 0,
  pixelWidth: 1440,
  pixelHeight: 2000,
  byteSize: 1024,
  hash: "a".repeat(64),
  state: "ready",
  missingReason: null,
};

const validConnection = {
  id: "3e4f5a6b-0000-4000-8000-cccccccccccc",
  channel: "inapp",
  baseUrl: "https://api.example.com/v1",
  model: "glm-4.7",
  keyFingerprint: "ab12cd34",
  imageCapability: "unknown",
  isDefault: true,
  verifyStatus: "unverified",
  verifiedAt: null,
  createdAt: "2026-10-15T08:00:00.000Z",
  updatedAt: "2026-10-15T08:00:00.000Z",
};

const validTask = {
  id: "4f5a6b7c-0000-4000-8000-dddddddddddd",
  attemptId: "5a6b7c8d-0000-4000-8000-eeeeeeeeeeee",
  questionId: "unit-a-q1",
  questionRevisionId: fullContext.questionRevisionId,
  channel: "inapp",
  status: "replied",
  modeAtSend: "guided_only",
  question: "我第二步为什么错了？",
  beforeSubmit: true,
  contextVersion: "v1-ab12",
  snapshotAt: "2026-10-15T10:00:00.000Z",
  hasReply: true,
  replyDeliveredAt: null,
  errorText: null,
  retryCount: 0,
  archivedAt: null,
  allowedActions: ["followup", "share"],
  materials: [validMaterial],
  createdAt: "2026-10-15T10:01:00.000Z",
  updatedAt: "2026-10-15T10:03:00.000Z",
};

it("合法单题上下文包含参考答案解析；缺任一者仍合法且有缺失说明", () => {
  const parsed = aiContextSnapshotSchema.parse(fullContext);
  expect(parsed.referenceAnswerMd).toBe("4");
  expect(parsed.solutionMd).toContain("同号相加");
  // 有答案无解析 → 暂无官方解析
  expect(
    aiContextSnapshotSchema.parse({
      ...fullContext,
      solutionMd: null,
      missingNote: "no_solution",
    }).missingNote,
  ).toBe("no_solution");
  // 有解析无固定答案 → 无固定参考答案
  expect(
    aiContextSnapshotSchema.parse({
      ...fullContext,
      referenceAnswerMd: null,
      missingNote: "no_reference_answer",
    }).missingNote,
  ).toBe("no_reference_answer");
  // 两者都无 → 缺少参考答案与解析（仍可求助）
  expect(
    aiContextSnapshotSchema.parse({
      ...fullContext,
      referenceAnswerMd: null,
      solutionMd: null,
      missingNote: "neither",
    }).missingNote,
  ).toBe("neither");
  // 教师私注不属于 AI 内容：混入快照整体拒绝（strict）
  expect(
    aiContextSnapshotSchema.safeParse({
      ...fullContext,
      teacherComment: "这题全班都错",
    }).success,
  ).toBe(false);
  // 缺失说明与答案/解析实际状态强一致：矛盾快照在契约层拒绝
  expect(
    aiContextSnapshotSchema.safeParse({
      ...fullContext,
      referenceAnswerMd: null,
      solutionMd: null,
      missingNote: null,
    }).success,
  ).toBe(false);
  expect(
    aiContextSnapshotSchema.safeParse({
      ...fullContext,
      missingNote: "neither",
    }).success,
  ).toBe(false);
  expect(
    aiContextSnapshotSchema.safeParse({
      ...fullContext,
      solutionMd: null,
      missingNote: "no_reference_answer",
    }).success,
  ).toBe(false);
});

it("任务八态与允许动作表和B00 §3.4 状态机一致", () => {
  expect(aiTaskStatusSchema.options).toEqual([
    "created",
    "dispatching",
    "uncertain",
    "claimed",
    "replied",
    "paused",
    "failed",
    "cancelled",
  ]);
  // 每个状态都有确定的动作集合（完备性）
  for (const status of aiTaskStatusSchema.options) {
    expect(Array.isArray(AI_TASK_ALLOWED_ACTIONS[status])).toBe(true);
  }
  expect(AI_TASK_ALLOWED_ACTIONS.created).toEqual([
    "dispatch",
    "share",
    "cancel",
  ]);
  expect(AI_TASK_ALLOWED_ACTIONS.dispatching).toEqual([]);
  expect(AI_TASK_ALLOWED_ACTIONS.uncertain).toEqual(["retry"]);
  expect(AI_TASK_ALLOWED_ACTIONS.claimed).toEqual(["cancel"]);
  expect(AI_TASK_ALLOWED_ACTIONS.replied).toEqual([
    "followup",
    "share",
    "archive",
  ]);
  expect(AI_TASK_ALLOWED_ACTIONS.paused).toEqual(["resume", "cancel"]);
  expect(AI_TASK_ALLOWED_ACTIONS.failed).toEqual(["retry"]);
  expect(AI_TASK_ALLOWED_ACTIONS.cancelled).toEqual(["archive"]);
});

it("SAI-23 归档是队列管理动作：只加在终态（replied/cancelled），不进在途状态", () => {
  // 归档不是状态机转换（status 不变），只在终态可整理；在途/可重试状态
  // （created/dispatching/uncertain/claimed/paused/failed）不提供归档——
  // 归档会把这些任务藏出队列、丢失重试/继续入口。
  for (const status of [
    "created",
    "dispatching",
    "uncertain",
    "claimed",
    "paused",
    "failed",
  ] as const) {
    expect(AI_TASK_ALLOWED_ACTIONS[status]).not.toContain("archive");
  }
  expect(aiTaskActionSchema.parse("archive")).toBe("archive");
  expect(aiTaskActionSchema.safeParse("unarchive").success).toBe(false);
});

it("SAI-23 任务来源摘要：来源/次数/题号/标题与导航定位键（列表附加视图）", () => {
  const origin = {
    sourceType: "lesson",
    attemptNo: 2,
    questionNo: 3,
    title: "二次函数讲练页",
    assignmentId: null,
    courseId: "6b7c8d9e-0000-4000-8000-ffffffffffff",
    unitId: "unit-b",
    lectureId: "7c8d9e0f-0000-4000-8000-aaaaaaaaaaaa",
    attemptStatus: "submitted",
  };
  expect(aiTaskOriginSummarySchema.parse(origin)).toEqual(origin);
  // 题不在本卷（软删/缺失）如实可表达，不伪造题号
  expect(
    aiTaskOriginSummarySchema.parse({ ...origin, questionNo: null })
      .questionNo,
  ).toBeNull();
  // strict：未知字段与非法来源拒绝
  expect(
    aiTaskOriginSummarySchema.safeParse({ ...origin, extra: 1 }).success,
  ).toBe(false);
  expect(
    aiTaskOriginSummarySchema.safeParse({ ...origin, sourceType: "exam" })
      .success,
  ).toBe(false);
  expect(
    aiTaskOriginSummarySchema.safeParse({ ...origin, attemptNo: 0 }).success,
  ).toBe(false);
});

it("处理状态与查看状态分开：无反馈、未查看均可表达", () => {
  // 无反馈：hasReply=false；无查看：hasReply=true 且 replyDeliveredAt=null
  expect(
    aiTaskPublicSchema.parse({
      ...validTask,
      hasReply: false,
      status: "created",
    }).hasReply,
  ).toBe(false);
  const unread = aiTaskPublicSchema.parse(validTask);
  expect(unread.hasReply).toBe(true);
  expect(unread.replyDeliveredAt).toBeNull();
  // 已查看：replyDeliveredAt 有值
  expect(
    aiTaskPublicSchema.parse({
      ...validTask,
      replyDeliveredAt: "2026-10-15T10:05:00.000Z",
    }).replyDeliveredAt,
  ).toBe("2026-10-15T10:05:00.000Z");
  // 归档时刻可表达（SAI-23）：归档≠已读——archivedAt 有值时查看态仍可为空
  const archived = aiTaskPublicSchema.parse({
    ...validTask,
    archivedAt: "2026-10-16T09:00:00.000Z",
  });
  expect(archived.archivedAt).toBe("2026-10-16T09:00:00.000Z");
  expect(archived.replyDeliveredAt).toBeNull();
});

it("公开任务视图不含快照原文、密钥、租约或文件路径", () => {
  const keys = Object.keys(aiTaskPublicSchema.shape);
  for (const forbidden of [
    "contextSnapshot",
    "promptSnapshotMd",
    "leaseToken",
    "leaseUntil",
    "pngPath",
    "apiKey",
    "teacherComment",
  ]) {
    expect(keys).not.toContain(forbidden);
  }
  expect(
    aiTaskPublicSchema.safeParse({ ...validTask, leaseToken: "lease-1" })
      .success,
  ).toBe(false);
  expect(
    aiTaskPublicSchema.safeParse({
      ...validTask,
      contextSnapshot: fullContext,
    }).success,
  ).toBe(false);
});

it("公开连接器只有指纹；明文凭证只在独立的首次凭证 schema", () => {
  const parsedConnection = aiConnectionPublicSchema.parse(validConnection);
  expect(
    parsedConnection.channel === "inapp" && parsedConnection.keyFingerprint,
  ).toBe("ab12cd34");
  expect(
    aiConnectionPublicSchema.safeParse({ ...validConnection, apiKey: "sk-x" })
      .success,
  ).toBe(false);
  // mcp 通道只读回显 token 指纹，明文 token 混入即拒绝
  expect(
    aiConnectionPublicSchema.safeParse({
      id: validConnection.id,
      channel: "mcp",
      tokenFingerprint: "ff99",
      isDefault: false,
      verifyStatus: "unverified",
      verifiedAt: null,
      createdAt: "2026-10-15T08:00:00.000Z",
      updatedAt: "2026-10-15T08:00:00.000Z",
      token: "plaintext",
    }).success,
  ).toBe(false);
  // link 通道合法
  expect(
    aiConnectionPublicSchema.safeParse({
      id: validConnection.id,
      channel: "link",
      defaultValidHours: 24,
      isDefault: false,
      createdAt: "2026-10-15T08:00:00.000Z",
      updatedAt: "2026-10-15T08:00:00.000Z",
    }).success,
  ).toBe(true);
  // 首次凭证是单独 schema：最小形态合法，携带其他凭证字段拒绝
  expect(
    aiConnectionFirstCredentialSchema.parse({ token: "once-only" }).token,
  ).toBe("once-only");
  expect(
    aiConnectionFirstCredentialSchema.safeParse({ token: "t", apiKey: "k" })
      .success,
  ).toBe(false);
});

it("材料行携带类别/页序/尺寸/字节/缺失原因，越界拒绝", () => {
  expect(aiTaskMaterialSchema.parse(validMaterial).pageIndex).toBe(0);
  expect(
    aiTaskMaterialSchema.safeParse({ ...validMaterial, pageIndex: -1 }).success,
  ).toBe(false);
  expect(
    aiTaskMaterialSchema.safeParse({ ...validMaterial, pixelWidth: 0 }).success,
  ).toBe(false);
  // 缺失态必须给中文缺失原因，不能只报缺失
  expect(
    aiTaskMaterialSchema.safeParse({
      ...validMaterial,
      state: "missing",
      missingReason: null,
    }).success,
  ).toBe(false);
  expect(
    aiTaskMaterialSchema.parse({
      ...validMaterial,
      state: "missing",
      missingReason: "本机材料生成失败",
    }).missingReason,
  ).toBe("本机材料生成失败");
  // 公开材料行无路径；内部行才有（相对 DATA_DIR）
  expect(Object.keys(aiTaskMaterialSchema.shape)).not.toContain("pngPath");
  const internal = aiTaskMaterialInternalSchema.parse({
    ...validMaterial,
    pngPath: "blobs/ai-materials/abc.png",
  });
  expect(internal.pngPath).toBe("blobs/ai-materials/abc.png");
});

it("MCP 领取视图携带租约与全量上下文（领取即授权外发）", () => {
  const claim = {
    taskId: validTask.id,
    attemptId: validTask.attemptId,
    questionId: validTask.questionId,
    questionRevisionId: validTask.questionRevisionId,
    context: fullContext,
    materials: [
      {
        index: 0,
        kind: "draft",
        downloadUrl: "/api/student/ai/tasks/x/materials/0.png",
        byteSize: 1024,
        pixelWidth: 1440,
        pixelHeight: 2000,
      },
    ],
    lease: {
      leaseToken: "lease-token-1",
      leaseUntil: "2026-10-15T10:10:00.000Z",
    },
    turnsUsed: 0,
  };
  const parsed = aiMcpClaimViewSchema.parse(claim);
  expect(parsed.context.referenceAnswerMd).toBe("4");
  expect(parsed.lease.leaseToken).toBe("lease-token-1");
  // 无租约不能领取
  expect(
    aiMcpClaimViewSchema.safeParse({ ...claim, lease: undefined }).success,
  ).toBe(false);
});

it("分享视图仅对应一个快照，不能含个人全量任务列表", () => {
  const share = {
    taskId: validTask.id,
    questionLabel: "第 27 题",
    snapshotAt: fullContext.capturedAt,
    context: fullContext,
    studentQuestion: "帮我看看第二步",
    materials: [
      {
        index: 0,
        kind: "annotation",
        downloadUrl: "/api/public/ai/share/ticket/materials/0.png",
        byteSize: 2048,
      },
    ],
  };
  expect(aiShareViewSchema.parse(share).questionLabel).toBe("第 27 题");
  expect(Object.keys(aiShareViewSchema.shape)).not.toContain("tasks");
  expect(
    aiShareViewSchema.safeParse({ ...share, tasks: [validTask] }).success,
  ).toBe(false);
});

it("内部执行载荷含代际与连接引用，外发内容受控", () => {
  const payload = {
    taskId: validTask.id,
    generation: 2,
    connectionId: validConnection.id,
    systemPromptMd: "【模式硬约束】……（注入防御包裹）",
    contextSnapshot: fullContext,
    historyMessages: [
      {
        id: "6b7c8d9e-0000-4000-8000-ffffffffffff",
        taskId: validTask.id,
        role: "student",
        contentMd: "我第二步为什么错了？",
        createdAt: "2026-10-15T10:01:00.000Z",
      },
    ],
    studentQuestion: "再追问：那第三步呢？",
    materials: [{ ...validMaterial, pngPath: "blobs/ai-materials/abc.png" }],
    channel: "inapp",
    modeAtSend: "guided_only",
  };
  expect(aiDispatchPayloadSchema.parse(payload).generation).toBe(2);
  expect(
    aiDispatchPayloadSchema.safeParse({ ...payload, generation: 0 }).success,
  ).toBe(false);
  // 消息与事实：beforeSubmit 服务端判定、必填
  expect(
    aiFactSchema.safeParse({
      id: "7c8d9e0f-0000-4000-8000-111111111111",
      taskId: validTask.id,
      type: "reply_received",
      serverTs: "2026-10-15T10:03:00.000Z",
    }).success,
  ).toBe(false);
  expect(
    aiMessageSchema.safeParse({
      id: "6b7c8d9e-0000-4000-8000-ffffffffffff",
      role: "student",
      contentMd: "问题",
      createdAt: "2026-10-15T10:01:00.000Z",
    }).success,
  ).toBe(false);
});

it("限额常量与 B00 §9 限额表一致（契约单源）", () => {
  expect(AI_QUESTION_MAX_CHARS).toBe(2000);
  expect(AI_TURNS_MAX).toBe(20);
  expect(AI_MATERIAL_MAX_COUNT).toBe(12);
  expect(AI_MATERIAL_PNG_MAX_BYTES).toBe(2 * 1024 * 1024);
  expect(AI_MATERIAL_TOTAL_MAX_BYTES).toBe(8 * 1024 * 1024);
  expect(AI_TASK_ACTIVE_PER_QUESTION).toBe(3);
  expect(AI_TASK_PENDING_PER_STUDENT).toBe(10);
  expect(AI_TASK_DAILY_PER_STUDENT).toBe(200);
  expect(AI_BATCH_MAX_QUESTIONS).toBe(30);
  expect(AI_OUTBOUND_TIMEOUT_MS).toBe(60_000);
  expect(AI_CONNECTION_TEST_TIMEOUT_MS).toBe(10_000);
  expect(AI_MCP_LEASE_MINUTES).toBe(10);
  expect(AI_SHARE_DEFAULT_VALID_HOURS).toBe(24);
  expect(AI_SHARE_MAX_VALID_HOURS).toBe(72);
  expect(AI_REPLY_MAX_CHARS).toBe(32 * 1024);
});

it("错误码覆盖策略禁用、限额、材料、出站、状态、租约与票据", () => {
  for (const code of [
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
  ]) {
    expect(aiErrorCodeSchema.options).toContain(code);
  }
  expect(aiErrorCodeSchema.safeParse("policy_disabled").success).toBe(false);
});

// ---------- SAI-16 连接管理请求/响应（B08：Key 仅 POST/PATCH 入参只写不读） ----------

it("连接创建请求：三通道各自形状，明文 Key 只在此入参出现", () => {
  // inapp：合法形态（isDefault 可选）
  expect(
    aiConnectionCreateRequestSchema.parse({
      channel: "inapp",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-test-123",
    }),
  ).toEqual({
    channel: "inapp",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4o-mini",
    apiKey: "sk-test-123",
  });
  // baseUrl 非 URL / Key 超长 → 拒绝（出站目标形状在服务端 outbound-target 复核）
  expect(
    aiConnectionCreateRequestSchema.safeParse({
      channel: "inapp",
      baseUrl: "not-a-url",
      model: "m",
      apiKey: "k",
    }).success,
  ).toBe(false);
  expect(
    aiConnectionCreateRequestSchema.safeParse({
      channel: "inapp",
      baseUrl: "https://api.example.com/v1",
      model: "m",
      apiKey: "k".repeat(AI_API_KEY_MAX_CHARS + 1),
    }).success,
  ).toBe(false);
  // mcp：不接受 apiKey/baseUrl（token 由服务端生成）；link：defaultValidHours 1–72
  expect(
    aiConnectionCreateRequestSchema.safeParse({
      channel: "mcp",
      apiKey: "sk-x",
    }).success,
  ).toBe(false);
  expect(aiConnectionCreateRequestSchema.parse({ channel: "mcp" })).toEqual({
    channel: "mcp",
  });
  expect(
    aiConnectionCreateRequestSchema.safeParse({
      channel: "link",
      defaultValidHours: AI_SHARE_MAX_VALID_HOURS + 1,
    }).success,
  ).toBe(false);
  // 未知键（如教师域字段）→ strict 整体拒绝
  expect(
    aiConnectionCreateRequestSchema.safeParse({
      channel: "mcp",
      studentId: "s-a",
    }).success,
  ).toBe(false);
});

it("连接更新请求：按通道判别，strict 拒绝未知键与他通道字段", () => {
  expect(
    aiConnectionPatchRequestSchema.parse({
      channel: "inapp",
      apiKey: "sk-new",
    }),
  ).toEqual({ channel: "inapp", apiKey: "sk-new" });
  // link 行不出现 apiKey/baseUrl/model（通道适用性由判别式拒绝）
  expect(
    aiConnectionPatchRequestSchema.safeParse({
      channel: "link",
      apiKey: "sk-x",
    }).success,
  ).toBe(false);
  // 全字段可选（SAI-03 定案「缺省 = 不改」）：仅带 channel 的空 PATCH 合法
  expect(
    aiConnectionPatchRequestSchema.parse({ channel: "inapp" }).channel,
  ).toBe("inapp");
});

it("连接 mutate 响应：一次性凭证只在 data 出现，视图混入明文即拒绝", () => {
  const mcpView = {
    id: "4f2c6d90-1c2e-4f6a-9b3d-000000000001",
    channel: "mcp",
    tokenFingerprint: "ff99aabb",
    isDefault: true,
    verifyStatus: "unverified",
    verifiedAt: null,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  } as const;
  const created = aiConnectionCreateDataSchema.parse({
    connection: mcpView,
    credential: { token: "once-only" },
  });
  expect(created.credential?.token).toBe("once-only");
  expect(
    aiConnectionCreateDataSchema.safeParse({
      connection: { ...mcpView, token: "leak" },
      credential: null,
    }).success,
  ).toBe(false);
  // PATCH 响应同形（mcp 重置时 credential 一次性返回）
  expect(
    aiConnectionPatchDataSchema.parse({
      connection: mcpView,
      credential: { token: "reset-once" },
    }).credential?.token,
  ).toBe("reset-once");
});

it("连接测试响应：verifyStatus 四态（含 needs_rekey），无能力字段", () => {
  expect(
    aiConnectionTestDataSchema.parse({
      verifyStatus: "verified",
      verifiedAt: "2026-10-16T00:00:00.000Z",
      message: "连接成功",
    }).verifyStatus,
  ).toBe("verified");
  // 解密失败也是可解释状态，不是异常形状；imageCapability 不在本响应（防未验证当支持）
  expect(
    aiConnectionTestDataSchema.safeParse({
      verifyStatus: "needs_rekey",
      verifiedAt: null,
      message: "密钥待重填",
    }).success,
  ).toBe(true);
  expect(
    aiConnectionTestDataSchema.safeParse({
      verifyStatus: "maybe",
      verifiedAt: null,
      message: null,
    }).success,
  ).toBe(false);
  expect(
    "imageCapability" in
      aiConnectionTestDataSchema.parse({
        verifyStatus: "failed",
        verifiedAt: null,
        message: "失败",
      }),
  ).toBe(false);
});

it("连接列表 data：connections 数组只含公开视图；删除响应只回 id", () => {
  const list = aiConnectionListDataSchema.parse({
    connections: [validConnection],
  });
  expect(list.connections).toHaveLength(1);
  expect(
    aiConnectionListDataSchema.safeParse({
      connections: [{ ...validConnection, apiKey: "sk-leak" }],
    }).success,
  ).toBe(false);
  expect(
    aiConnectionDeleteDataSchema.parse({
      id: "4f2c6d90-1c2e-4f6a-9b3d-000000000002",
    }).id,
  ).toBeDefined();
});
