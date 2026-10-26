import type { AttemptQuestionPublic } from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";
import { exportQuestionAnnotationImage } from "./export-question-annotation";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  view: vi.fn(),
  render: vi.fn(),
  prepare: vi.fn(),
  compositeSource: vi.fn(),
  session: { origin: "test", studentId: "s" },
}));
vi.mock("./annotation-store", () => ({ getAnnotationRecord: mocks.record }));
vi.mock("./annotation-sync", () => ({
  currentAnnotationSession: () => mocks.session,
}));
vi.mock("@/lib/api", () => ({ fetchAnnotationViewApi: mocks.view }));
vi.mock("./question-base-image", () => ({
  renderQuestionBaseImage: mocks.render,
}));
vi.mock("./question-annotation-base", () => ({
  prepareQuestionAnnotationBase: mocks.prepare,
}));
vi.mock("./annotation-composite", () => ({
  exportAnnotationCompositeSource: mocks.compositeSource,
}));
beforeEach(() => vi.clearAllMocks());
const question: AttemptQuestionPublic = {
  id: "q",
  questionRevisionId: "revision-q",
  type: "judge",
  difficulty: 1,
  knowledge: [],
  hintCount: 0,
  stemMd: "公开题面",
};
it("无标画导出只渲染公开题面，不建立底图绑定", async () => {
  mocks.record.mockResolvedValue(null);
  mocks.view.mockResolvedValue({ annotation: null, base: null, doc: null });
  const blob = new Blob(["png"]);
  mocks.render.mockResolvedValue({ blob });
  expect(
    await exportQuestionAnnotationImage(
      mocks.session,
      { attemptId: "a", questionId: "q", phase: "scratch" },
      question,
      document.createElement("div"),
    ),
  ).toBe(blob);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("标画读取失败不能默认为无标画导出", async () => {
  mocks.record.mockResolvedValue(null);
  mocks.view.mockRejectedValue(new Error("读取失败"));
  await expect(
    exportQuestionAnnotationImage(
      mocks.session,
      { attemptId: "a", questionId: "q", phase: "scratch" },
      question,
      document.createElement("div"),
    ),
  ).rejects.toThrow("读取失败");
  expect(mocks.render).not.toHaveBeenCalled();
});

// ---------- surface=null（B05 AI 材料采集：材料收起/画布释放） ----------

it("surface=null 且无任何底图与笔迹：明确报错可重试，不当空稿假成功", async () => {
  mocks.record.mockResolvedValue(null);
  mocks.view.mockResolvedValue({ annotation: null, base: null, doc: null });
  await expect(
    exportQuestionAnnotationImage(
      mocks.session,
      { attemptId: "a", questionId: "q", phase: "scratch" },
      question,
      null,
    ),
  ).rejects.toThrow("题面尚未就绪，请重试");
  expect(mocks.render).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it("surface=null 时已保存底图仍走既有合成，null 透传底图准备入口", async () => {
  const localBase = {
    png: new Blob(["png"], { type: "image/png" }),
    layout: { cssWidth: 300, cssHeight: 200, pixelRatio: 2 },
  };
  mocks.record.mockResolvedValue({
    localBase,
    local: "saved",
    doc: { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
  });
  mocks.prepare.mockResolvedValue({ kind: "surface", localBase });
  const blob = new Blob(["composite"]);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixed");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  mocks.compositeSource.mockResolvedValue({ ok: true, blob });
  expect(
    await exportQuestionAnnotationImage(
      mocks.session,
      { attemptId: "a", questionId: "q", phase: "scratch" },
      question,
      null,
    ),
  ).toBe(blob);
  expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(
    mocks.session,
    { attemptId: "a", questionId: "q", phase: "scratch" },
    question,
    null,
  );
  expect(mocks.compositeSource).toHaveBeenCalledOnce();
});

it("v1 旧版底图明确告知不支持导出合成，不当本机未保存误报", async () => {
  mocks.record.mockResolvedValue({
    localBase: null,
    base: {
      baseId: "legacy",
      state: "ready",
      stale: false,
      pixelWidth: 600,
      pixelHeight: 400,
    },
    doc: { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
  });
  mocks.prepare.mockResolvedValue({ kind: "legacy" });
  await expect(
    exportQuestionAnnotationImage(
      mocks.session,
      { attemptId: "a", questionId: "q", phase: "scratch" },
      question,
      document.createElement("div"),
    ),
  ).rejects.toThrow("旧版");
  expect(mocks.compositeSource).not.toHaveBeenCalled();
});
