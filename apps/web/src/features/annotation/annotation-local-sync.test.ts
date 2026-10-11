import type { AnnotationSurfaceLayout } from "@tutor/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  postAnnotationBaseApi: vi.fn(),
  postAnnotationBaseImageApi: vi.fn(),
  putAnnotationDocApi: vi.fn(),
}));

import {
  ApiError,
  postAnnotationBaseApi,
  postAnnotationBaseImageApi,
  putAnnotationDocApi,
} from "@/lib/api";
import {
  applyBasePreview,
  getAnnotationRecord,
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
  writeAnnotationDoc,
  writeLocalAnnotationBase,
} from "./annotation-store";
import {
  bindAnnotationSession,
  flushAnnotationSync,
  resetAnnotationSession,
} from "./annotation-sync";

const session = { origin: "https://tutor.test", studentId: "student-a" };
const scope = {
  attemptId: "attempt-a",
  questionId: "question-a",
  phase: "scratch" as const,
};
const layout: AnnotationSurfaceLayout = {
  renderVersion: 2,
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
const png = new Blob(["png"], { type: "image/png" });
const base = {
  baseId: "22222222-2222-4222-8222-222222222222",
  state: "pending" as const,
  stale: false,
  pixelWidth: null,
  pixelHeight: null,
  layout,
};
beforeEach(() => {
  resetAnnotationSession();
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  vi.clearAllMocks();
  vi.mocked(postAnnotationBaseApi).mockResolvedValue({
    base,
    baseRenderVersion: 2,
    maxWidthPx: 600,
    questionRevisionId: layout.questionRevisionId,
    questionNo: 1,
    questionMd: "公开题面",
    mediaSrcs: [],
    graphFigures: [],
    interactionNotes: [],
  });
  vi.mocked(postAnnotationBaseImageApi).mockResolvedValue({
    baseId: base.baseId,
    state: "ready",
    imageHash: "a".repeat(64),
    pixelWidth: 600,
    pixelHeight: 400,
    updatedAt: "now",
  });
  vi.mocked(putAnnotationDocApi).mockResolvedValue({
    annotationId: base.baseId,
    revision: 1,
    hash: "b".repeat(64),
    savedAt: "now",
  });
  bindAnnotationSession(session);
});
afterEach(() => resetAnnotationSession());
async function createLocal() {
  await writeLocalAnnotationBase(
    session,
    scope,
    { png, layout },
    { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
  );
}

it("底图身份→PNG ready→矢量的顺序固定，恢复后无假身份", async () => {
  await createLocal();
  await flushAnnotationSync(scope.attemptId);
  expect(postAnnotationBaseApi).toHaveBeenCalledWith(
    scope.attemptId,
    scope.questionId,
    scope.phase,
    layout,
    expect.any(AbortSignal),
  );
  expect(
    vi.mocked(postAnnotationBaseImageApi).mock.invocationCallOrder[0],
  ).toBeLessThan(
    vi.mocked(putAnnotationDocApi).mock.invocationCallOrder[0] ?? 0,
  );
  expect((await getAnnotationRecord(session, scope))?.base?.state).toBe(
    "ready",
  );
  expect((await getAnnotationRecord(session, scope))?.pending).toBeNull();
});
it("服务器另一布局冲突停止上传且保留本机PNG与矢量", async () => {
  vi.mocked(postAnnotationBaseApi).mockRejectedValue(
    new ApiError("ANNOTATION_BASE_LAYOUT_CONFLICT", "已有另一布局", 409),
  );
  await createLocal();
  await flushAnnotationSync(scope.attemptId);
  expect(putAnnotationDocApi).not.toHaveBeenCalled();
  expect(postAnnotationBaseImageApi).not.toHaveBeenCalled();
  const record = await getAnnotationRecord(session, scope);
  expect(record?.conflict).not.toBeNull();
  expect(record?.localBase?.png).toBe(png);
  expect(record?.pending).not.toBeNull();
});

it("缓存ready引用不代表本机PNG已绑定，异字节冲突不能跳过校验", async () => {
  await createLocal();
  const preview = await postAnnotationBaseApi(
    scope.attemptId,
    scope.questionId,
  );
  await applyBasePreview(session, scope, {
    ...preview,
    base: { ...base, state: "ready", pixelWidth: 600, pixelHeight: 400 },
  });
  vi.mocked(postAnnotationBaseImageApi).mockRejectedValue(
    new ApiError("ANNOTATION_BASE_ALREADY_READY", "底图不同", 409),
  );
  await flushAnnotationSync(scope.attemptId);
  expect(putAnnotationDocApi).not.toHaveBeenCalled();
  expect((await getAnnotationRecord(session, scope))?.conflict).not.toBeNull();
});

it("已确认绑定后后续正文同步不重复上传PNG", async () => {
  await createLocal();
  await flushAnnotationSync(scope.attemptId);
  writeAnnotationDoc(session, scope, {
    version: 1,
    baseWidth: 600,
    baseHeight: 400,
    strokes: [
      {
        tool: "pen",
        color: "#dc2626",
        weight: 4,
        points: [{ x: 10, y: 10, p: 0.5, t: 0 }],
      },
    ],
  });
  await flushAnnotationSync(scope.attemptId);
  expect(postAnnotationBaseImageApi).toHaveBeenCalledOnce();
  expect(putAnnotationDocApi).toHaveBeenCalledTimes(2);
});
it("首建迟到响应在账号切换后不写回或上传PNG", async () => {
  let release: (() => void) | undefined;
  const reply = vi.mocked(postAnnotationBaseApi).getMockImplementation();
  vi.mocked(postAnnotationBaseApi).mockImplementation(async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    if (!reply) throw new Error("测试回执缺失");
    return reply(...args);
  });
  await createLocal();
  const flushing = flushAnnotationSync(scope.attemptId);
  await vi.waitFor(() => expect(release).toBeDefined());
  bindAnnotationSession({ ...session, studentId: "student-b" });
  release?.();
  await flushing;
  expect(postAnnotationBaseImageApi).not.toHaveBeenCalled();
  expect(putAnnotationDocApi).not.toHaveBeenCalled();
  expect((await getAnnotationRecord(session, scope))?.base).toBeNull();
});
