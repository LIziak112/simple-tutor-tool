import { act, render, screen, waitFor } from "@testing-library/react";
import type {
  AnnotationSurfaceLayout,
  AttemptQuestionPublic,
} from "@tutor/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import { QuestionAnnotationFrame } from "./QuestionAnnotationFrame";
import { questionSurfaceMatchesLayout } from "./question-base-image";

vi.mock("./question-base-image", async (original) => ({
  ...(await original<typeof import("./question-base-image")>()),
  awaitQuestionSurfaceReady: vi.fn(async () => ({})),
  questionSurfaceMatchesLayout: vi.fn(async () => true),
  resolveLegacyQuestionProfile: vi.fn(async () => "horizontal"),
}));
const question: AttemptQuestionPublic = {
  id: "q",
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  type: "fill",
  stemMd: "公开 [[]]",
  knowledge: [],
  difficulty: 1,
  hintCount: 0,
};
const layout: AnnotationSurfaceLayout = {
  renderVersion: 4,
  renderProfile: "whole-question-v1",
  styleVersion: 1,
  questionRevisionId: question.questionRevisionId,
  cssWidth: 600,
  cssHeight: 300,
  pixelRatio: 2,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
  compatibility: {
    version: 1,
    contentSignature: "d".repeat(64),
    blocks: [],
    fonts: [],
    textRects: [],
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());
it("保留唯一真实输入，墨层在固定逻辑框的兄弟层", async () => {
  const changed = vi.fn();
  const { container, rerender } = render(
    <QuestionAnnotationFrame
      question={question}
      layout={null}
      scopeKey="s"
      onGeometryChange={changed}
      inkLayer={<canvas data-testid="ink" />}
    >
      <QuestionSurface question={question} />
    </QuestionAnnotationFrame>,
  );
  const input = screen.getByRole("textbox");
  rerender(
    <QuestionAnnotationFrame
      question={question}
      layout={layout}
      scopeKey="s"
      onGeometryChange={changed}
      inkLayer={<canvas data-testid="ink" />}
    >
      <QuestionSurface question={question} />
    </QuestionAnnotationFrame>,
  );
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "ready" }),
    ),
  );
  expect(screen.getByRole("textbox")).toBe(input);
  expect(
    screen.getByTestId("ink").closest('[data-slot="annotation-logical-frame"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-slot="annotation-logical-frame"]'),
  ).toHaveStyle({ width: "600px", height: "300px" });
  const calls = vi.mocked(questionSurfaceMatchesLayout).mock.calls.length;
  rerender(
    <QuestionAnnotationFrame
      question={{ ...question }}
      layout={{ ...layout }}
      scopeKey="s"
      onGeometryChange={changed}
      inkLayer={<canvas data-testid="ink" />}
    >
      <QuestionSurface
        question={question}
        answer={{ kind: "fill", values: ["新值"] }}
      />
    </QuestionAnnotationFrame>,
  );
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("新值");
  expect(questionSurfaceMatchesLayout).toHaveBeenCalledTimes(calls);
});
it("旧 scope 的迟到几何成功不能放行新题", async () => {
  let release = (_: boolean) => {};
  vi.mocked(questionSurfaceMatchesLayout).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const changed = vi.fn();
  const { rerender } = render(
    <QuestionAnnotationFrame
      question={question}
      layout={layout}
      scopeKey="old"
      onGeometryChange={changed}
    >
      <QuestionSurface question={question} />
    </QuestionAnnotationFrame>,
  );
  await waitFor(() =>
    expect(questionSurfaceMatchesLayout).toHaveBeenCalledOnce(),
  );
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  rerender(
    <QuestionAnnotationFrame
      question={question}
      layout={layout}
      scopeKey="new"
      onGeometryChange={changed}
    >
      <QuestionSurface question={question} />
    </QuestionAnnotationFrame>,
  );
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "blocked" }),
    ),
  );
  await act(async () => release(true));
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "blocked" }),
  );
});

it("旧题模板按离屏证据选择横排并核验可见题面", async () => {
  const { renderProfile: _profile, ...old } = layout;
  const legacy = { ...old, renderVersion: 2 as const, cssWidth: 430 };
  const matching = { ...question, type: "matching" as const };
  const { resolveLegacyQuestionProfile } = await import(
    "./question-base-image"
  );
  vi.mocked(resolveLegacyQuestionProfile).mockResolvedValueOnce("horizontal");
  const changed = vi.fn();
  render(
    <QuestionAnnotationFrame
      question={matching}
      layout={legacy}
      scopeKey="legacy"
      onGeometryChange={changed}
    >
      <QuestionSurface question={question} />
    </QuestionAnnotationFrame>,
  );
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "ready" }),
    ),
  );
  expect(resolveLegacyQuestionProfile).toHaveBeenCalled();
});
