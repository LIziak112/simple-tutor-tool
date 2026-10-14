import type { AttemptQuestionPublic } from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";
import { exportQuestionAnnotationImage } from "./export-question-annotation";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  view: vi.fn(),
  render: vi.fn(),
  prepare: vi.fn(),
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
