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
import {
  AttemptEditorNotice,
  AttemptEditorProvider,
} from "@/features/attempt/AttemptEditorContext";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import {
  getAnnotationRecord,
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
  settleAnnotationRecordPersistence,
  writeAnnotationDoc,
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
  setInputMode: vi.fn(),
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
  awaitQuestionSurfaceReady: vi.fn(async () => ({})),
  questionSurfaceMatchesLayout: vi.fn(async () => true),
}));
vi.mock("./question-annotation-base", () => ({
  prepareQuestionAnnotationBase: vi.fn(),
}));

import { prepareQuestionAnnotationBase } from "./question-annotation-base";
import {
  awaitQuestionSurfaceReady,
  questionSurfaceMatchesLayout,
} from "./question-base-image";

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
function Harness({ hidden = false }: { hidden?: boolean }) {
  const ref = useRef<QuestionAnnotationOverlayHandle>(null);
  return (
    <AttemptEditorProvider>
      <AttemptEditorNotice />
      <button type="button" onClick={() => void ref.current?.start()}>
        标画
      </button>
      <input aria-label="正常答案" />
      <QuestionAnnotationOverlay
        ref={ref}
        attemptId={scope.attemptId}
        question={question}
        label="第1题"
        hidden={hidden}
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
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:annotation-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
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

it("收笔时重试失败的本机稿，恢复写入后可退出圈画且原稿不变", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  const before = await getAnnotationRecord(session, scope);
  if (!before) throw new Error("缺少标画夹具");
  const backend = memoryAnnotationBackend();
  let failed = true;
  // 保留已有记录，只给后续写入注入失败；重新读取后模拟继续书写。
  installAnnotationBackend({
    ...backend,
    get: async () => before,
    set: async (key, value) => {
      if (failed) throw null;
      await backend.set(key, value);
    },
  });
  await getAnnotationRecord(session, scope);
  await act(async () => {
    writeAnnotationDoc(session, scope, before.doc);
    await settleAnnotationRecordPersistence(session, scope);
  });
  fireEvent.click(screen.getByRole("button", { name: "作答" }));
  await screen.findByRole("alert");
  expect(
    screen.getByRole("toolbar", { name: "第1题标画工具栏" }),
  ).toBeVisible();
  const pending = (await getAnnotationRecord(session, scope))?.pending;
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "重试操作" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("toolbar", { name: "第1题标画工具栏" }),
    ).toBeNull(),
  );
  const saved = await getAnnotationRecord(session, scope);
  expect(saved?.local).toBe("saved");
  expect(saved?.pending).toEqual(pending);
  expect(saved?.doc).toEqual(before?.doc);
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
  await waitFor(() =>
    expect(engine.setInputEnabled).toHaveBeenLastCalledWith(true),
  );
  const overlay = document.querySelector(
    '[data-slot="question-annotation-overlay"]',
  );
  expect(overlay).toHaveStyle({ width: "300px", height: "200px" });
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
it("同一题面开合复用几何观察，重新打开只等待显式资源核对", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() => expect(screen.getByRole("toolbar")).toBeVisible());
  fireEvent.click(screen.getByRole("button", { name: "作答" }));
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  // 等待首次几何核对结束，再记录本次打开带来的资源等待。
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  const checks = vi.mocked(awaitQuestionSurfaceReady).mock.calls.length;
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() => expect(screen.getByRole("toolbar")).toBeVisible());
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expect(awaitQuestionSurfaceReady).toHaveBeenCalledTimes(checks + 1);
  expect(engine.setInputEnabled).toHaveBeenLastCalledWith(true);
});
it("题面变化时先收笔，核对期间切工具继续保持输入保护", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() =>
    expect(engine.setInputEnabled).toHaveBeenLastCalledWith(true),
  );
  let release = () => {};
  vi.mocked(awaitQuestionSurfaceReady).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { cssWidth: 300, cssHeight: 200, blocks: [], fonts: [] };
  });
  const finishes = engine.finish.mock.calls.length;
  const surface = document.querySelector<HTMLElement>(
    '[data-slot="question-surface"]',
  );
  if (!surface) throw new Error("题面应已挂载");
  await act(async () => {
    surface.style.fontSize = "18px";
  });
  await waitFor(() =>
    expect(engine.finish.mock.calls.length).toBeGreaterThan(finishes),
  );
  expect(engine.setInputEnabled).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "橡皮" }));
  expect(engine.setInputEnabled).toHaveBeenLastCalledWith(false);
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    release();
  });
  await waitFor(() =>
    expect(engine.setInputEnabled).toHaveBeenLastCalledWith(true),
  );
});
it("布局不匹配时从圈画入口查看原稿，保留唯一原生作答且不启用编辑", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  const before = await getAnnotationRecord(session, scope);
  render(<Harness />);
  await waitFor(() => expect(questionSurfaceMatchesLayout).toHaveBeenCalled());
  expect(screen.queryByRole("img", { name: /原标画底图/ })).toBeNull();
  expect(screen.queryByText(/答案在下方填写/)).toBeNull();
  expect(
    document.querySelector('[data-slot="question-surface"]'),
  ).toBeVisible();
  expect(
    document.querySelector('[data-slot="question-surface"]'),
  ).not.toHaveAttribute("inert");
  fireEvent.click(screen.getByText("标画"));
  expect(
    await screen.findByRole("dialog", { name: "第1题原圈画" }),
  ).toBeVisible();
  expect(
    screen.getByRole("img", { name: "第1题原圈画底图", hidden: true }),
  ).toHaveAttribute("src", "blob:annotation-test");
  expect(screen.queryByText(/请重新开始练习/)).toBeNull();
  expect(screen.getAllByLabelText("正常答案")).toHaveLength(1);
  expect((await getAnnotationRecord(session, scope))?.pending).toEqual(
    before?.pending,
  );
  expect(engine.setInputEnabled).not.toHaveBeenCalledWith(true);
  expect(screen.queryByRole("toolbar")).toBeNull();
});

it("无保存布局时题面和标画容器共同跟随父列宽度", async () => {
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  const { container } = render(<Harness />);
  await act(async () => {
    await getAnnotationRecord(session, scope);
  });
  for (const slot of [
    "annotated-question",
    "annotation-viewport",
    "question-surface",
  ]) {
    const element = container.querySelector<HTMLElement>(
      `[data-slot="${slot}"]`,
    );
    expect(element).toHaveClass("w-full", "min-w-0");
    expect(element?.style.maxWidth).toBe("");
  }
});

it("隐藏再显示题面不复开原稿弹窗，查看保留本机待传材料", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  const before = await getAnnotationRecord(session, scope);
  const { rerender } = render(<Harness />);
  await waitFor(() => expect(questionSurfaceMatchesLayout).toHaveBeenCalled());
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("dialog", { name: "第1题原圈画" });
  expect(screen.getByText("本设备有尚未同步的圈画。")).toBeVisible();
  rerender(<Harness hidden />);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  rerender(<Harness />);
  expect(screen.queryByRole("dialog")).toBeNull();
  const after = await getAnnotationRecord(session, scope);
  expect(after?.doc).toEqual(before?.doc);
  expect(after?.pending).toEqual(before?.pending);
});

it("旧稿缺少布局信息仍能查看云端原底图，读取不创建待传稿", async () => {
  const saved = await getAnnotationRecord(session, scope);
  if (!saved) throw new Error("缺少夹具");
  resetAnnotationStoreForTest();
  installAnnotationBackend({
    ...memoryAnnotationBackend(),
    get: async () => ({
      ...saved,
      localBase: null,
      pending: null,
      base: {
        baseId: "legacy-base",
        state: "ready",
        stale: false,
        pixelWidth: 600,
        pixelHeight: 400,
        downloadUrl: "/legacy.png",
      },
    }),
  });
  await getAnnotationRecord(session, scope);
  render(<Harness />);
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("dialog", { name: "第1题原圈画" });
  expect(screen.getByRole("img", { hidden: true })).toHaveAttribute(
    "src",
    "/legacy.png",
  );
  expect(prepareQuestionAnnotationBase).not.toHaveBeenCalled();
  expect((await getAnnotationRecord(session, scope))?.pending).toBeNull();
});

it("已有布局固定逻辑宽度，由同一区域整体缩放，隐藏标画不解除排版", async () => {
  const { container, rerender } = render(<Harness />);
  expect(
    container.querySelector('[data-slot="annotated-question"]'),
  ).toHaveStyle({
    maxWidth: "300px",
  });
  expect(
    container.querySelector('[data-slot="annotation-viewport"]'),
  ).toHaveStyle({
    maxWidth: "300px",
  });
  const frame = container.querySelector(
    '[data-slot="annotation-logical-frame"]',
  );
  expect(frame).toHaveStyle({ width: "300px", transformOrigin: "top left" });
  await waitFor(() => expect(engine.mount).toHaveBeenCalled());
  expect(screen.queryByRole("toolbar")).toBeNull();
  rerender(<Harness hidden />);
  expect(frame).toHaveStyle({ width: "300px" });
  expect(
    container.querySelector('[data-slot="question-annotation-overlay"]'),
  ).not.toBeVisible();
});

it("窄屏可放大同一题面再适应宽度，不重新挂载笔迹或改变保存尺寸", async () => {
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ width: 150, height: 100 } as DOMRect);
  try {
    const { container } = render(<Harness />);
    await waitFor(() => expect(engine.mount).toHaveBeenCalled());
    const frame = container.querySelector(
      '[data-slot="annotation-logical-frame"]',
    );
    expect(frame).toHaveStyle({ transform: "scale(0.5)" });
    const mounts = engine.mount.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "放大题面" }));
    await waitFor(() => expect(frame).toHaveStyle({ transform: "scale(1)" }));
    fireEvent.click(screen.getByRole("button", { name: "适应宽度" }));
    await waitFor(() => expect(frame).toHaveStyle({ transform: "scale(0.5)" }));
    expect(engine.mount).toHaveBeenCalledTimes(mounts);
    expect((await getAnnotationRecord(session, scope))?.doc.baseWidth).toBe(
      600,
    );
  } finally {
    rect.mockRestore();
  }
});
it("分栏改变可用宽度后重新适配，不能保留放大造成局部横向滚动", async () => {
  let width = 150;
  const callbacks: Array<() => void> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(() => ({ width, height: 100 }) as DOMRect);
  try {
    const { container } = render(<Harness />);
    await waitFor(() => expect(engine.mount).toHaveBeenCalled());
    const frame = container.querySelector(
      '[data-slot="annotation-logical-frame"]',
    );
    fireEvent.click(screen.getByRole("button", { name: "放大题面" }));
    await waitFor(() => expect(frame).toHaveStyle({ transform: "scale(1)" }));
    // 高度通知不能取消用户放大；只有可用宽度改变才重新适配。
    act(() => {
      callbacks.forEach((callback) => {
        callback();
      });
    });
    expect(frame).toHaveStyle({ transform: "scale(1)" });
    width = 120;
    act(() => {
      callbacks.forEach((callback) => {
        callback();
      });
    });
    await waitFor(() => expect(frame).toHaveStyle({ transform: "scale(0.4)" }));
    expect((await getAnnotationRecord(session, scope))?.doc.baseWidth).toBe(
      600,
    );
  } finally {
    rect.mockRestore();
  }
});

it("底图准备失败仍能答题且显示重试原因", async () => {
  vi.mocked(prepareQuestionAnnotationBase).mockRejectedValue(
    new Error("图片加载失败"),
  );
  render(<Harness />);
  await act(async () => fireEvent.click(screen.getByText("标画")));
  expect(await screen.findByRole("alert")).toHaveTextContent("图片加载失败");
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
