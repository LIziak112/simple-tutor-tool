import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  AnnotationSurfaceLayout,
  AttemptQuestionPublic,
} from "@tutor/contract";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AttemptEditorProvider } from "@/features/attempt/AttemptEditorContext";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import {
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
  writeLocalAnnotationBase,
} from "./annotation-store";
import {
  bindAnnotationSession,
  resetAnnotationSession,
} from "./annotation-sync";
import {
  QuestionAnnotationOverlay,
  type QuestionAnnotationOverlayHandle,
} from "./QuestionAnnotationOverlay";

const engine = vi.hoisted(() => ({
  mount: vi.fn(),
  destroy: vi.fn(),
  finish: vi.fn(),
  setInputEnabled: vi.fn(),
  setTool: vi.fn(),
  onChange: vi.fn(() => () => undefined),
  load: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  clear: vi.fn(),
  canUndo: vi.fn(() => false),
  canRedo: vi.fn(() => false),
}));
vi.mock("./annotation-surface", () => ({
  createAnnotationSurface: () => engine,
}));
vi.mock("./question-base-image", () => ({
  questionSurfaceMatchesLayout: vi.fn(async () => true),
}));
vi.mock("./question-annotation-base", () => ({
  prepareQuestionAnnotationBase: vi.fn(),
}));

import { prepareQuestionAnnotationBase } from "./question-annotation-base";
import { questionSurfaceMatchesLayout } from "./question-base-image";

const session = { origin: "https://tutor.test", studentId: "student" };
const scope = {
  attemptId: "attempt",
  questionId: "q",
  phase: "scratch" as const,
};
const question: AttemptQuestionPublic = {
  id: "q",
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  type: "judge",
  stemMd: "公开题面",
  knowledge: [],
  difficulty: 1,
  hintCount: 0,
};
const layout: AnnotationSurfaceLayout = {
  renderVersion: 2,
  questionRevisionId: question.questionRevisionId,
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
function Harness() {
  const ref = useRef<QuestionAnnotationOverlayHandle>(null);
  return (
    <AttemptEditorProvider>
      <button type="button" onClick={() => void ref.current?.start()}>
        标画
      </button>
      <input aria-label="正常答案" />
      <QuestionAnnotationOverlay
        ref={ref}
        attemptId={scope.attemptId}
        question={question}
        label="第1题"
        onLegacy={() => undefined}
      >
        <QuestionSurface question={question} />
      </QuestionAnnotationOverlay>
    </AttemptEditorProvider>
  );
}
beforeEach(async () => {
  resetAnnotationSession();
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  bindAnnotationSession(session);
  vi.clearAllMocks();
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(true);
  vi.mocked(prepareQuestionAnnotationBase).mockResolvedValue({
    kind: "surface",
    localBase: { png: new Blob(["png"], { type: "image/png" }), layout },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  await writeLocalAnnotationBase(
    session,
    scope,
    { png: new Blob(["png"], { type: "image/png" }), layout },
    { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
  );
});
afterEach(() => {
  vi.useRealTimers();
  resetAnnotationSession();
  vi.unstubAllGlobals();
});
it("标画收起保活到期释放空画布，重新打开恢复引擎", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() => expect(screen.getByRole("toolbar")).toBeVisible());
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "作答" }));
  await act(async () => {
    await Promise.resolve();
  });
  const destroyed = engine.destroy.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(45_000));
  expect(engine.destroy.mock.calls.length).toBeGreaterThan(destroyed);
  vi.useRealTimers();
  const mounted = engine.mount.mock.calls.length;
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() =>
    expect(engine.mount.mock.calls.length).toBeGreaterThan(mounted),
  );
});
it("绘制时锁表单，退出留痕且不重建历史引擎", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() =>
    expect(
      screen.getByRole("toolbar", { name: "第1题标画工具栏" }),
    ).toBeVisible(),
  );
  expect(
    document.querySelector('[data-slot="question-surface"]'),
  ).toHaveAttribute("inert");
  expect(engine.setInputEnabled).toHaveBeenLastCalledWith(true);
  const mounts = engine.mount.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "作答" }));
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="question-surface"]'),
    ).not.toHaveAttribute("inert"),
  );
  expect(engine.finish).toHaveBeenCalled();
  expect(engine.setInputEnabled).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() => expect(screen.getByRole("toolbar")).toBeVisible());
  expect(engine.mount).toHaveBeenCalledTimes(mounts);
});
it("布局不匹配不把圈套到新题面，提供原底图入口", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  render(<Harness />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "查看原标画" })).toBeVisible(),
  );
  expect(
    document.querySelector('[data-slot="question-surface"]'),
  ).not.toHaveAttribute("inert");
  expect(engine.setInputEnabled).not.toHaveBeenCalledWith(true);
});
it("底图准备失败仍能答题且显示重试原因", async () => {
  vi.mocked(prepareQuestionAnnotationBase).mockRejectedValue(
    new Error("图片加载失败"),
  );
  render(<Harness />);
  await act(async () => fireEvent.click(screen.getByText("标画")));
  expect(screen.getByRole("alert")).toHaveTextContent("图片加载失败");
  expect(
    document.querySelector('[data-slot="question-surface"]'),
  ).not.toHaveAttribute("inert");
});

it("撤销快捷键只归活动标画，不能夺取输入框或输入法的撤销", async () => {
  render(<Harness />);
  fireEvent.keyDown(window, { key: "z", ctrlKey: true });
  expect(engine.undo).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() => expect(screen.getByRole("toolbar")).toBeVisible());
  fireEvent.keyDown(screen.getByRole("textbox", { name: "正常答案" }), {
    key: "z",
    ctrlKey: true,
  });
  fireEvent.keyDown(window, { key: "z", ctrlKey: true, isComposing: true });
  expect(engine.undo).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "z", ctrlKey: true });
  expect(engine.undo).toHaveBeenCalledOnce();
  fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
  expect(engine.redo).toHaveBeenCalledOnce();
});
