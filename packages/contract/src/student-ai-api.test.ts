import { expect, it } from "vitest";
import {
  AI_BATCH_MAX_QUESTIONS,
  AI_QUESTION_MAX_CHARS,
  AI_REPLY_MAX_CHARS,
} from "./student-ai";
import {
  aiBatchReviewCreateRequestSchema,
  aiConnectionCreateDataSchema,
  aiConnectionCreateRequestSchema,
  aiConnectionPatchRequestSchema,
  aiMaterialUploadReceiptDataSchema,
  aiMcpSubmitReplyRequestSchema,
  aiStatusQuerySchema,
  aiTaskCreateRequestSchema,
  aiTaskFollowupRequestSchema,
  aiTaskListQuerySchema,
  aiTaskShareRequestSchema,
} from "./student-ai-api";

/**
 * SAI-03 API 契约测试（B00 §4.2 API 表）：
 * 学生端请求全部 strict——伪造 effectiveMode/teacherId/questionId（追问拼他题）
 * 一律整体拒绝；分页游标是不透明字符串，不接受任意查询结构。
 */

const inappConnection = {
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

it("状态查询 strict：缺参拒绝、越权字段拒绝", () => {
  expect(
    aiStatusQuerySchema.safeParse({
      attemptId: "5a6b7c8d-0000-4000-8000-eeeeeeeeeeee",
      questionId: "unit-a-q1",
    }).success,
  ).toBe(true);
  expect(
    aiStatusQuerySchema.safeParse({ questionId: "unit-a-q1" }).success,
  ).toBe(false);
  expect(
    aiStatusQuerySchema.safeParse({
      attemptId: "5a6b7c8d-0000-4000-8000-eeeeeeeeeeee",
      questionId: "unit-a-q1",
      effectiveMode: "open_study",
    }).success,
  ).toBe(false);
});

it("任务创建：问题必填限长、材料偏好三类、幂等键必填、越权字段拒绝", () => {
  const base = {
    attemptId: "5a6b7c8d-0000-4000-8000-eeeeeeeeeeee",
    questionId: "unit-a-q1",
    question: "这一步为什么错了？",
    channel: "inapp",
    materials: { annotation: true, draft: true, formalInk: false },
    mutationId: "mut-0001",
  };
  expect(aiTaskCreateRequestSchema.parse(base).mutationId).toBe("mut-0001");
  // 快捷按钮来源可选回显
  expect(
    aiTaskCreateRequestSchema.parse({ ...base, quickButtonId: "check-steps" })
      .quickButtonId,
  ).toBe("check-steps");
  expect(
    aiTaskCreateRequestSchema.safeParse({ ...base, question: "   " }).success,
  ).toBe(false);
  expect(
    aiTaskCreateRequestSchema.safeParse({
      ...base,
      question: "问".repeat(AI_QUESTION_MAX_CHARS + 1),
    }).success,
  ).toBe(false);
  expect(
    aiTaskCreateRequestSchema.safeParse({ ...base, teacherId: "t-1" }).success,
  ).toBe(false);
  expect(
    aiTaskCreateRequestSchema.safeParse({ ...base, mutationId: undefined })
      .success,
  ).toBe(false);
});

it("同题追问绑定父任务，不能把另一题 ID 合法拼入", () => {
  expect(
    aiTaskFollowupRequestSchema.parse({
      question: "那第三步呢？",
      mutationId: "followup-mut-1",
    }).question,
  ).toBe("那第三步呢？");
  // 追问幂等键与创建同强度必填（网络重试不产生重复追问）
  expect(
    aiTaskFollowupRequestSchema.safeParse({ question: "那第三步呢？" }).success,
  ).toBe(false);
  expect(
    aiTaskFollowupRequestSchema.safeParse({
      question: "那第三步呢？",
      mutationId: "followup-mut-1",
      questionId: "unit-a-q2",
    }).success,
  ).toBe(false);
  expect(
    aiTaskFollowupRequestSchema.safeParse({
      question: "那第三步呢？",
      mutationId: "followup-mut-1",
      attemptId: "00000000-0000-4000-8000-000000000000",
    }).success,
  ).toBe(false);
  expect(
    aiTaskFollowupRequestSchema.safeParse({
      question: "",
      mutationId: "followup-mut-1",
    }).success,
  ).toBe(false);
});

it("票据有效期不在 schema 固化默认（连接偏好回退），上限 72h 越界拒绝", () => {
  // 省略 = undefined：服务端按 link 连接 defaultValidHours 回退、无偏好才用 24h
  expect(aiTaskShareRequestSchema.parse({}).validHours).toBeUndefined();
  expect(aiTaskShareRequestSchema.parse({ validHours: 24 }).validHours).toBe(
    24,
  );
  expect(aiTaskShareRequestSchema.parse({ validHours: 72 }).validHours).toBe(
    72,
  );
  expect(aiTaskShareRequestSchema.safeParse({ validHours: 73 }).success).toBe(
    false,
  );
  expect(aiTaskShareRequestSchema.safeParse({ validHours: 0 }).success).toBe(
    false,
  );
});

it("任务列表游标为不透明字符串，不接受任意查询结构", () => {
  expect(
    aiTaskListQuerySchema.safeParse({
      attemptId: "5a6b7c8d-0000-4000-8000-eeeeeeeeeeee",
      status: "replied",
      limit: 20,
      cursor: "Y3JlYXRlZDoyMDI2LTAxLTAx",
    }).success,
  ).toBe(true);
  // 游标传对象/非法字符/超长均拒绝
  expect(
    aiTaskListQuerySchema.safeParse({ cursor: { offset: 5 } }).success,
  ).toBe(false);
  expect(
    aiTaskListQuerySchema.safeParse({ cursor: "not a cursor!!" }).success,
  ).toBe(false);
  expect(
    aiTaskListQuerySchema.safeParse({
      cursor: "x".repeat(200),
    }).success,
  ).toBe(false);
  // 查询结构 strict：未知字段与非法状态拒绝
  expect(
    aiTaskListQuerySchema.safeParse({ orderBy: "createdAt" }).success,
  ).toBe(false);
  expect(aiTaskListQuerySchema.safeParse({ status: "pending" }).success).toBe(
    false,
  );
  expect(aiTaskListQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
});

it("MCP 写回必须带租约令牌；超长回信放行由服务端截断声明（§9）", () => {
  const reply = {
    taskId: "4f5a6b7c-0000-4000-8000-dddddddddddd",
    leaseToken: "lease-token-1",
    replyMarkdown: "第二步符号处理错了……",
  };
  expect(aiMcpSubmitReplyRequestSchema.parse(reply).leaseToken).toBe(
    "lease-token-1",
  );
  expect(
    aiMcpSubmitReplyRequestSchema.safeParse({ ...reply, leaseToken: undefined })
      .success,
  ).toBe(false);
  expect(
    aiMcpSubmitReplyRequestSchema.safeParse({ ...reply, replyMarkdown: "" })
      .success,
  ).toBe(false);
  // 超 32KiB 不在契约硬拒：服务端按 AI_REPLY_MAX_CHARS 截断并显式声明
  expect(
    aiMcpSubmitReplyRequestSchema.safeParse({
      ...reply,
      replyMarkdown: "字".repeat(AI_REPLY_MAX_CHARS + 1),
    }).success,
  ).toBe(true);
});

it("批量复盘逐题定位：1–30 题、幂等键必填、条目去重", () => {
  const item = {
    attemptId: "5a6b7c8d-0000-4000-8000-eeeeeeeeeeee",
    questionId: "unit-a-q1",
  };
  const base = {
    items: Array.from({ length: AI_BATCH_MAX_QUESTIONS }, (_, i) => ({
      ...item,
      questionId: `unit-a-q${i + 1}`,
    })),
    channel: "mcp",
    question: "请复盘这些错题",
    mutationId: "batch-mut-1",
  };
  expect(aiBatchReviewCreateRequestSchema.parse(base).items.length).toBe(
    AI_BATCH_MAX_QUESTIONS,
  );
  // 幂等键必填：误触重复提交只产生一批任务（需求 §8）
  expect(
    aiBatchReviewCreateRequestSchema.safeParse({
      ...base,
      mutationId: undefined,
    }).success,
  ).toBe(false);
  expect(
    aiBatchReviewCreateRequestSchema.safeParse({ ...base, items: [] }).success,
  ).toBe(false);
  expect(
    aiBatchReviewCreateRequestSchema.safeParse({
      ...base,
      items: [
        ...base.items,
        { attemptId: item.attemptId, questionId: "unit-a-q31" },
      ],
    }).success,
  ).toBe(false);
  // 同一 (attemptId, questionId) 重复出现拒绝，不静默合并
  expect(
    aiBatchReviewCreateRequestSchema.safeParse({
      ...base,
      items: [item, item],
    }).success,
  ).toBe(false);
  expect(
    aiBatchReviewCreateRequestSchema.safeParse({
      ...base,
      items: [{ ...item, effectiveMode: "open_study" }],
    }).success,
  ).toBe(false);
});

it("材料上传回执逐项可定位并回报总字节", () => {
  const receipt = {
    materials: [
      {
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
      },
    ],
    totalBytes: 1024,
  };
  expect(aiMaterialUploadReceiptDataSchema.parse(receipt).totalBytes).toBe(
    1024,
  );
  expect(
    aiMaterialUploadReceiptDataSchema.safeParse({ ...receipt, totalBytes: -1 })
      .success,
  ).toBe(false);
});

it("连接创建响应：凭证只按首次明文形态出现且可空", () => {
  expect(
    aiConnectionCreateDataSchema.parse({
      connection: inappConnection,
      credential: null,
    }).credential,
  ).toBeNull();
  expect(
    aiConnectionCreateDataSchema.parse({
      connection: inappConnection,
      credential: { token: "once-only" },
    }).credential?.token,
  ).toBe("once-only");
  // 凭证 schema 不接受其他明文字段混入
  expect(
    aiConnectionCreateDataSchema.safeParse({
      connection: inappConnection,
      credential: { token: "t", apiKey: "k" },
    }).success,
  ).toBe(false);
});

it("连接写请求：inapp 明文 Key 只进写请求，mcp/link 无凭证入参，strict 拒绝越权", () => {
  // inapp 创建：明文 Key 是写请求唯一合法出现位置（响应只回指纹）
  const created = aiConnectionCreateRequestSchema.parse({
    channel: "inapp",
    baseUrl: "https://api.example.com/v1",
    model: "glm-4.7",
    apiKey: "sk-test",
  });
  expect(created.channel === "inapp" && created.apiKey).toBe("sk-test");
  // mcp/link 创建：token 服务端生成，无凭证入参
  expect(
    aiConnectionCreateRequestSchema.safeParse({ channel: "mcp" }).success,
  ).toBe(true);
  expect(
    aiConnectionCreateRequestSchema.safeParse({
      channel: "link",
      defaultValidHours: 48,
    }).success,
  ).toBe(true);
  // 创建请求不接受指纹/密文等响应侧字段
  expect(
    aiConnectionCreateRequestSchema.safeParse({
      channel: "inapp",
      baseUrl: "https://api.example.com/v1",
      model: "glm-4.7",
      apiKey: "sk-test",
      keyFingerprint: "ab12cd34",
    }).success,
  ).toBe(false);
  // patch：全部可选（缺省 = 不改）；不传 apiKey = 保持原 Key；越界有效期拒绝
  expect(
    aiConnectionPatchRequestSchema.safeParse({
      channel: "inapp",
      model: "glm-5",
    }).success,
  ).toBe(true);
  expect(
    aiConnectionPatchRequestSchema.safeParse({
      channel: "link",
      defaultValidHours: 73,
    }).success,
  ).toBe(false);
  expect(
    aiConnectionPatchRequestSchema.safeParse({
      channel: "mcp",
      token: "plaintext",
    }).success,
  ).toBe(false);
});
