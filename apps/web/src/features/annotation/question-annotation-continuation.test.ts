import type {
  AnnotationSurfaceLayout,
  AttemptQuestionPublic,
} from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  postAnnotationBaseApi: vi.fn(),
}));
vi.mock("./question-base-image", () => ({
  verifiedLegacySurfaceCompatibility: vi.fn(),
}));

import { postAnnotationBaseApi } from "@/lib/api";
import {
  applyAnnotationView,
  getAnnotationRecord,
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
  writeAnnotationDoc,
  writeLocalAnnotationBase,
} from "./annotation-store";
import {
  bindAnnotationSession,
  resetAnnotationSession,
} from "./annotation-sync";
import { prepareQuestionAnnotationContinuation } from "./question-annotation-continuation";
import { verifiedLegacySurfaceCompatibility } from "./question-base-image";

const session = { origin: "https://test", studentId: "student" };
const scope = {
  attemptId: "attempt",
  questionId: "question",
  phase: "scratch" as const,
};
const layout: AnnotationSurfaceLayout = {
  renderVersion: 2,
  questionRevisionId: "revision",
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
const question: AttemptQuestionPublic = {
  id: scope.questionId,
  questionRevisionId: "revision",
  type: "judge",
  stemMd: "公开题面",
  hintCount: 0,
  difficulty: 1,
  knowledge: [],
};
const proof: NonNullable<AnnotationSurfaceLayout["compatibility"]> = {
  version: 1,
  contentSignature: "d".repeat(64),
  blocks: [{ tag: "DIV", x: 0, y: 0, width: 300, height: 200 }],
  fonts: [["sans-serif", "16px", "400", "28px", "normal"]],
  textRects: [],
};
const base = {
  baseId: "base",
  state: "ready" as const,
  stale: false,
  pixelWidth: 600,
  pixelHeight: 400,
  layout,
};
beforeEach(async () => {
  resetAnnotationSession();
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  bindAnnotationSession(session);
  vi.clearAllMocks();
  vi.mocked(verifiedLegacySurfaceCompatibility).mockResolvedValue(proof);
  const doc = {
    version: 1 as const,
    baseWidth: 600,
    baseHeight: 400,
    strokes: [],
  };
  await applyAnnotationView(session, scope, {
    base,
    maxWidthPx: 600,
    annotation: null,
    doc: null,
  });
  await writeLocalAnnotationBase(
    session,
    scope,
    { png: new Blob(["原PNG"], { type: "image/png" }), layout },
    doc,
    { boundBaseId: "base" },
  );
  writeAnnotationDoc(session, scope, doc);
});
it("显式续写只补经验证的布局证据，保留 PNG、待传标识、正文版本和活动时间", async () => {
  const before = await getAnnotationRecord(session, scope);
  if (!before?.localBase) throw new Error("缺少夹具");
  vi.mocked(postAnnotationBaseApi).mockResolvedValue({
    base: { ...base, layout: { ...layout, compatibility: proof } },
    baseRenderVersion: 2,
    maxWidthPx: 600,
    questionRevisionId: "revision",
    questionNo: 1,
    questionMd: "公开",
    mediaSrcs: [],
    graphFigures: [],
    interactionNotes: [],
  });
  const saved = await prepareQuestionAnnotationContinuation(
    session,
    scope,
    question,
    document.createElement("div"),
    before.localBase,
  );
  expect(saved.layout.compatibility).toEqual(proof);
  const after = await getAnnotationRecord(session, scope);
  expect(after?.localBase?.png).toBe(before.localBase.png);
  expect(after?.pending).toEqual(before.pending);
  expect(after?.docVersion).toBe(before.docVersion);
  expect(after?.editedAt).toBe(before.editedAt);
});
it("不能证明旧布局时不发请求；迟到证据不得写入新会话", async () => {
  const before = await getAnnotationRecord(session, scope);
  if (!before?.localBase) throw new Error("缺少夹具");
  vi.mocked(verifiedLegacySurfaceCompatibility).mockResolvedValue(null);
  expect(
    await prepareQuestionAnnotationContinuation(
      session,
      scope,
      question,
      document.createElement("div"),
      before.localBase,
    ),
  ).toBe(before.localBase);
  expect(postAnnotationBaseApi).not.toHaveBeenCalled();
  vi.mocked(verifiedLegacySurfaceCompatibility).mockImplementation(async () => {
    resetAnnotationSession();
    return proof;
  });
  await expect(
    prepareQuestionAnnotationContinuation(
      session,
      scope,
      question,
      document.createElement("div"),
      before.localBase,
    ),
  ).rejects.toThrow("会话");
  expect(postAnnotationBaseApi).not.toHaveBeenCalled();
});
