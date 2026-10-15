import { expect, it } from "vitest";
import {
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
  aiTaskMaterialSchema,
  aiTaskPublicSchema,
  aiTaskStatusSchema,
} from "./student-ai";

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
  expect(AI_TASK_ALLOWED_ACTIONS.replied).toEqual(["followup", "share"]);
  expect(AI_TASK_ALLOWED_ACTIONS.paused).toEqual(["resume", "cancel"]);
  expect(AI_TASK_ALLOWED_ACTIONS.failed).toEqual(["retry"]);
  expect(AI_TASK_ALLOWED_ACTIONS.cancelled).toEqual([]);
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
