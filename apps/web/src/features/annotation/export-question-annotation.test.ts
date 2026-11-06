import type {
  AnnotationSurfaceLayout,
  AttemptQuestionPublic,
} from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";
import { exportQuestionAnnotationImage } from "./export-question-annotation";

const state = vi.hoisted(() => ({
  session: { origin: "test", studentId: "s" },
  epoch: 1,
  persistence: "saved",
}));
const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  view: vi.fn(),
  render: vi.fn(),
  draft: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("./annotation-store", () => ({ getAnnotationRecord: mocks.record }));
vi.mock("./annotation-sync", () => ({
  currentAnnotationSession: () => state.session,
}));
vi.mock("@/lib/api", () => ({ fetchAnnotationViewApi: mocks.view }));
vi.mock("./render-current-question", () => ({
  renderCurrentQuestionImage: mocks.render,
}));
vi.mock("./question-annotation-base", () => ({
  prepareQuestionAnnotationBase: mocks.prepare,
}));
vi.mock("@/features/attempt/draft-store", () => ({
  draftStore: { loadDraft: mocks.draft },
  getDraftSessionEpoch: () => state.epoch,
  getDraftPersistenceState: () => state.persistence,
}));
const question: AttemptQuestionPublic = {
  id: "q",
  questionRevisionId: "revision",
  type: "fill",
  stemMd: "公开 [[]]",
  difficulty: 1,
  knowledge: [],
  hintCount: 0,
};
const scope = { attemptId: "a", questionId: "q", phase: "scratch" as const };
const layout: AnnotationSurfaceLayout = {
  renderVersion: 4,
  renderProfile: "whole-question-v1",
  questionRevisionId: "revision",
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
  compatibility: {
    version: 1,
    contentSignature: "d".repeat(64),
    blocks: [{ tag: "DIV", node: "root", x: 0, y: 0, width: 300, height: 200 }],
    fonts: [["sans-serif", "16px", "400", "28px", "normal"]],
    textRects: [],
  },
};
const doc = {
  version: 1,
  baseWidth: 600,
  baseHeight: 400,
  strokes: [
    {
      tool: "pen",
      color: "red",
      weight: 3,
      points: [{ x: 20, y: 30, p: 0.5, t: 0 }],
    },
  ],
};
const base = {
  baseId: "11111111-1111-4111-8111-111111111111",
  state: "ready",
  stale: false,
  pixelWidth: 600,
  pixelHeight: 400,
  layout,
  downloadUrl: "/evidence.png",
};
const record = () => ({
  localBase: {
    png: new Blob(["evidence"], { type: "image/png" }),
    layout,
    boundBaseId: base.baseId,
  },
  base,
  doc,
  local: "saved",
  sealedAt: null,
  conflict: null,
  retained: null,
  pending: null,
  denied: null,
});
beforeEach(() => {
  vi.resetAllMocks();
  state.session = { origin: "test", studentId: "s" };
  state.epoch = 1;
  state.persistence = "saved";
  mocks.record.mockResolvedValue(null);
  mocks.view.mockResolvedValue({ annotation: null, base: null, doc: null });
  mocks.draft.mockResolvedValue({
    answers: { q: { kind: "fill", values: ["本人中文"] } },
    answerConflicts: {},
  });
  mocks.render.mockResolvedValue(new Blob(["current"]));
});
it("没有活DOM也可从模型导出，带本人答案，不创建底图绑定", async () => {
  await exportQuestionAnnotationImage(state.session, scope, question, null);
  expect(mocks.record).toHaveBeenCalledWith(state.session, scope, {
    strictRead: true,
  });
  expect(mocks.render).toHaveBeenCalledWith(
    question,
    expect.objectContaining({
      answer: { kind: "fill", values: ["本人中文"] },
      layout: null,
      doc: null,
      reference: null,
    }),
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("读取失败不当无稿，不建立或导出新题面", async () => {
  mocks.record.mockRejectedValue(new Error("读取失败"));
  await expect(
    exportQuestionAnnotationImage(state.session, scope, question, null),
  ).rejects.toThrow("读取失败");
  expect(mocks.render).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("本机稿以同一原布局和固定矢量导出，原PNG只读保留", async () => {
  const saved = record();
  mocks.record.mockResolvedValue(saved);
  const before = JSON.stringify(saved);
  await exportQuestionAnnotationImage(state.session, scope, question, null);
  expect(mocks.render).toHaveBeenCalledWith(
    question,
    expect.objectContaining({ layout, doc }),
  );
  expect(JSON.stringify(saved)).toBe(before);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.view).not.toHaveBeenCalled();
});
it("云端来源无需下载原PNG便可生成当前题面", async () => {
  mocks.view.mockResolvedValue({ base, doc, annotation: { sealedAt: null } });
  await exportQuestionAnnotationImage(state.session, scope, question, null);
  expect(mocks.render).toHaveBeenCalledWith(
    question,
    expect.objectContaining({ layout, doc }),
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it.each(["conflict", "denied"])("未裁决的 %s 不导出混合稿", async (key) => {
  mocks.record.mockResolvedValue({ ...record(), [key]: {} });
  await expect(
    exportQuestionAnnotationImage(state.session, scope, question, null),
  ).rejects.toThrow(/冲突|被拒/);
  expect(mocks.render).not.toHaveBeenCalled();
});
it("未成功本机落盘不能导出", async () => {
  mocks.record.mockResolvedValue({ ...record(), local: "failed" });
  await expect(
    exportQuestionAnnotationImage(state.session, scope, question, null),
  ).rejects.toThrow(/保存/);
});
it("错版本和错坐标不能用当前渲染绕过原稿身份", async () => {
  mocks.record.mockResolvedValue({
    ...record(),
    doc: { ...doc, baseWidth: 602 },
  });
  await expect(
    exportQuestionAnnotationImage(state.session, scope, question, null),
  ).rejects.toThrow(/坐标/);
  mocks.record.mockResolvedValue(record());
  await expect(
    exportQuestionAnnotationImage(
      state.session,
      scope,
      { ...question, questionRevisionId: "another" },
      null,
    ),
  ).rejects.toThrow(/版本/);
});
it("封存稿仍交由结果页导出", async () => {
  mocks.record.mockResolvedValue({
    ...record(),
    sealedAt: "2026-11-05T00:00:00Z",
  });
  await expect(
    exportQuestionAnnotationImage(state.session, scope, question, null),
  ).rejects.toThrow(/结果页/);
});
it("v1缺定位证据明确保稿，不改为原PNG主视图", async () => {
  mocks.view.mockResolvedValue({
    base: { ...base, layout: undefined },
    doc,
    annotation: null,
  });
  await expect(
    exportQuestionAnnotationImage(state.session, scope, question, null),
  ).rejects.toThrow(/v1|位置证据/);
  expect(mocks.render).not.toHaveBeenCalled();
});
it.each(["saving", "failed"])(
  "答案本机状态%s时不能采集未保存值",
  async (persistence) => {
    state.persistence = persistence;
    await expect(
      exportQuestionAnnotationImage(state.session, scope, question, null),
    ).rejects.toThrow(/保存/);
  },
);
it("题目答案冲突不混入当前截图", async () => {
  mocks.draft.mockResolvedValue({ answers: {}, answerConflicts: { q: {} } });
  await expect(
    exportQuestionAnnotationImage(state.session, scope, question, null),
  ).rejects.toThrow(/答案.*冲突/);
});
it("账号或草稿epoch变化后丢弃迟到的图片", async () => {
  mocks.render.mockImplementationOnce(async () => {
    state.epoch += 1;
    return new Blob(["late"]);
  });
  await expect(
    exportQuestionAnnotationImage(state.session, scope, question, null),
  ).rejects.toThrow(/会话/);
});
it("仅选纸张时不读取或偷带圈画类别", async () => {
  await exportQuestionAnnotationImage(state.session, scope, question, null, {
    includeAnnotation: false,
  });
  expect(mocks.record).not.toHaveBeenCalled();
  expect(mocks.view).not.toHaveBeenCalled();
  expect(mocks.render).toHaveBeenCalledWith(
    question,
    expect.objectContaining({ doc: null, layout: null }),
  );
});
