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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttemptEditorNotice,
  AttemptEditorProvider,
  useAttemptEditor,
} from "@/features/attempt/AttemptEditorContext";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import {
  applyAnnotationView,
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
  createAnnotationSurface: vi.fn(() => engine),
}));
vi.mock("./question-base-image", () => ({
  awaitQuestionSurfaceReady: vi.fn(async () => ({})),
  questionSurfaceMatchesLayout: vi.fn(async () => true),
  measureQuestionSurface: vi.fn(),
}));
vi.mock("./question-annotation-base", () => ({
  prepareQuestionAnnotationBase: vi.fn(),
}));
// 只包装 overlay 收笔链路里的单题 settle 供断言（其余保持真实实现）。
vi.mock("./annotation-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./annotation-store")>();
  return {
    ...actual,
    settleAnnotationRecordPersistence: vi.fn(
      actual.settleAnnotationRecordPersistence,
    ),
  };
});

import { createAnnotationSurface } from "./annotation-surface";
import { prepareQuestionAnnotationBase } from "./question-annotation-base";
import {
  awaitQuestionSurfaceReady,
  measureQuestionSurface,
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
/** 模拟切题收笔：对协调器发起本题 flush（标注/草稿/手写固定顺序）。 */
function FlushButton({ questionId }: { questionId: string }) {
  const editor = useAttemptEditor(null);
  return (
    <button type="button" onClick={() => void editor?.flush(questionId)}>
      flush
    </button>
  );
}
function Harness({ hidden = false }: { hidden?: boolean }) {
  const ref = useRef<QuestionAnnotationOverlayHandle>(null);
  return (
    <AttemptEditorProvider>
      <AttemptEditorNotice />
      <button type="button" onClick={() => void ref.current?.start()}>
        标画
      </button>
      <input aria-label="正常答案" />
      <FlushButton questionId={question.id} />
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
  vi.mocked(measureQuestionSurface).mockReturnValue({
    cssWidth: 300,
    cssHeight: 200,
    textRects: [],
    blocks: [
      { tag: "P", x: 0, y: 0, width: 300, height: 40, node: "stem/p/0" },
      { tag: "P", x: 0, y: 60, width: 300, height: 60, node: "stem/p/1" },
    ],
    fonts: [
      ["16px", "16px", "400", "16px", "0px"],
      ["16px", "16px", "400", "16px", "0px"],
    ],
  });
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

it("旧稿原排版已匹配时不强制切换像素网格，可继续原位编辑", async () => {
  const { container } = render(<Harness />);
  await waitFor(() => expect(questionSurfaceMatchesLayout).toHaveBeenCalled());
  expect(
    container.querySelector('[data-slot="question-surface-frame"]'),
  ).toHaveAttribute("data-pixel-grid", "native");
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  expect(
    container.querySelector('[data-slot="question-surface-frame"]'),
  ).toHaveAttribute("data-pixel-grid", "native");
});

it("原排版不匹配时尝试稳定网格，成功后原位续写且不修改旧正文", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockImplementation(
    async () =>
      document
        .querySelector('[data-slot="question-surface-frame"]')
        ?.getAttribute("data-pixel-grid") === "stable",
  );
  const before = await getAnnotationRecord(session, scope);
  const { container } = render(<Harness />);
  await waitFor(() =>
    expect(
      container.querySelector('[data-slot="question-surface-frame"]'),
    ).toHaveAttribute("data-pixel-grid", "stable"),
  );
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  expect(screen.queryByRole("dialog")).toBeNull();
  const after = await getAnnotationRecord(session, scope);
  expect(after?.doc).toEqual(before?.doc);
  expect(after?.pending).toEqual(before?.pending);
  expect(after?.docVersion).toBe(before?.docVersion);
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
    return {
      cssWidth: 300,
      cssHeight: 200,
      blocks: [],
      fonts: [],
      textRects: [],
    };
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
it("无 CoordinatedAnnotationProvider 的挂载语境（讲练页）工具切换仍生效", async () => {
  // 回归：协同标画 Context 默认值曾携带具体值，导致无 Provider 时
  // `coordinated.tool ?? localTool` 永不回退，橡皮/颜色/粗细切换全部失灵
  render(<Harness />);
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() =>
    expect(engine.setInputEnabled).toHaveBeenLastCalledWith(true),
  );
  const eraser = screen.getByRole("button", { name: "橡皮" });
  expect(eraser).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(eraser);
  await waitFor(() => expect(eraser).toHaveAttribute("aria-pressed", "true"));
  await waitFor(() =>
    expect(engine.setTool).toHaveBeenLastCalledWith({ type: "eraser" }),
  );
});
it("布局不匹配且有本机底图时内联固定底图续画，不弹只读弹窗且题面保持可作答", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  const before = await getAnnotationRecord(session, scope);
  render(<Harness />);
  await waitFor(() => expect(questionSurfaceMatchesLayout).toHaveBeenCalled());
  // 被动核对失败即出现续画区块（说明 + 固定底图工作台），不进弹窗。
  expect(await screen.findByText(/题面已固定为保存时的底图/)).toBeVisible();
  const continuationImage = await screen.findByRole("img", {
    name: "第1题题干标注底图",
  });
  expect(continuationImage).toHaveAttribute("src", "blob:annotation-test");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    document.querySelector('[data-slot="question-surface"]'),
  ).not.toHaveAttribute("inert");
  expect(screen.getAllByLabelText("正常答案")).toHaveLength(1);
  expect(screen.queryByRole("toolbar", { name: "第1题标画工具栏" })).toBeNull();
  // 重复点击圈画：重校验仍不匹配 → 续画区块恢复展开，仍不自动弹只读弹窗。
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() =>
    expect(prepareQuestionAnnotationBase).toHaveBeenCalledTimes(1),
  );
  expect(await screen.findByText(/题面已固定为保存时的底图/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "收起固定底图圈画" }),
  ).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText(/请重新开始练习/)).toBeNull();
  expect((await getAnnotationRecord(session, scope))?.pending).toEqual(
    before?.pending,
  );
  expect(engine.setInputEnabled).not.toHaveBeenCalledWith(true);
});

it("布局不匹配时续画区块可收起，留入口按钮可再展开", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  render(<Harness />);
  await screen.findByText(/题面已固定为保存时的底图/);
  fireEvent.click(screen.getByRole("button", { name: "收起固定底图圈画" }));
  expect(
    await screen.findByRole("button", { name: "在固定底图上圈画" }),
  ).toBeVisible();
  expect(screen.queryByRole("img", { name: "第1题题干标注底图" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "在固定底图上圈画" }));
  expect(
    await screen.findByRole("img", { name: "第1题题干标注底图" }),
  ).toBeVisible();
});

it("展开续画再收起后切题 flush 仍收笔并落盘本题标画", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  render(<Harness />);
  // 等内嵌工作台真正挂载（objectURL 就绪后第二拍渲染）再断言注册归属。
  await screen.findByRole("img", { name: "第1题题干标注底图" });
  const settleRecord = vi.mocked(settleAnnotationRecordPersistence);
  // 续画工作台挂载期间持有本题收笔注册：flush 走工作台收笔（引擎 finish）。
  const finishes = engine.finish.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "flush" }));
  await waitFor(() =>
    expect(engine.finish.mock.calls.length).toBeGreaterThan(finishes),
  );
  expect(settleRecord).not.toHaveBeenCalled();
  // 收起工作台后注册键交还 overlay：flush 仍 settle 本题标画持久化。
  fireEvent.click(screen.getByRole("button", { name: "收起固定底图圈画" }));
  await screen.findByRole("button", { name: "在固定底图上圈画" });
  settleRecord.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "flush" }));
  await waitFor(() =>
    expect(settleRecord).toHaveBeenCalledWith(session, scope),
  );
});

it("布局恢复匹配后再次圈画回到原位编辑，续画区块退场", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  render(<Harness />);
  await screen.findByRole("button", { name: "收起固定底图圈画" });
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(true);
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  expect(screen.queryByText(/题面已固定为保存时的底图/)).toBeNull();
  expect(screen.queryByRole("button", { name: "在固定底图上圈画" })).toBeNull();
  expect(
    document.querySelector('[data-slot="question-surface"]'),
  ).toHaveAttribute("inert");
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

it("隐藏时收起续画区块，重新显示不复开只读弹窗且保留本机待传材料", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  const before = await getAnnotationRecord(session, scope);
  const { rerender } = render(<Harness />);
  await screen.findByText(/题面已固定为保存时的底图/);
  rerender(<Harness hidden />);
  await waitFor(() =>
    expect(screen.queryByText(/题面已固定为保存时的底图/)).toBeNull(),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<Harness />);
  await screen.findByText(/题面已固定为保存时的底图/);
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
  // v1 底图无 layout：无续画区块，仍自动弹只读原稿弹窗（回归）。
  expect(screen.queryByText(/题面已固定为保存时的底图/)).toBeNull();
  expect(screen.queryByRole("button", { name: "在固定底图上圈画" })).toBeNull();
  expect(prepareQuestionAnnotationBase).not.toHaveBeenCalled();
  expect((await getAnnotationRecord(session, scope))?.pending).toBeNull();
});

it("打开时才发现的旧版底图直接转只读查看，不报错不进入编辑", async () => {
  // 本机无任何缓存：record 层分流不接手，prepare 从云端首次带回 v1 底图。
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  vi.mocked(prepareQuestionAnnotationBase).mockImplementation(async () => {
    await applyAnnotationView(session, scope, {
      base: {
        baseId: "legacy-base",
        state: "ready",
        stale: false,
        pixelWidth: 600,
        pixelHeight: 400,
        downloadUrl: "/legacy.png",
      },
      doc: { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
      maxWidthPx: 1440,
      annotation: null,
    });
    return { kind: "legacy" };
  });
  render(<Harness />);
  fireEvent.click(screen.getByText("标画"));
  const dialog = await screen.findByRole("dialog", { name: "第1题原圈画" });
  expect(dialog).toBeVisible();
  // v1 场景的明确语义文案，而不是错误横幅或误导性重开提示。
  expect(
    screen.getByText("此题标画为旧版，仅供查看。关闭后可继续作答。"),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "重试操作" })).toBeNull();
  expect(screen.queryByText(/上次操作未完成/)).toBeNull();
  expect(screen.queryByRole("toolbar")).toBeNull();
  expect(screen.queryByText(/题面已固定为保存时的底图/)).toBeNull();
  expect(screen.getByRole("img", { hidden: true })).toHaveAttribute(
    "src",
    "/legacy.png",
  );
  // 只读查看：不重建底图、不创建待传空稿。
  const saved = await getAnnotationRecord(session, scope);
  expect(saved?.localBase).toBeNull();
  expect(saved?.pending).toBeNull();
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

it("底图准备失败仍能答题且就地显示原因，不进全局重试横幅", async () => {
  vi.mocked(prepareQuestionAnnotationBase).mockRejectedValue(
    new Error("图片加载失败"),
  );
  render(<Harness />);
  await act(async () => fireEvent.click(screen.getByText("标画")));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("图片加载失败");
  // 打开失败是前置条件不满足：不走「上次操作未完成」全局横幅、无重试按钮。
  expect(alert).not.toHaveTextContent("上次操作未完成");
  expect(screen.queryByRole("button", { name: "重试操作" })).toBeNull();
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

describe("LR-PR4 第二层：近似原位模式（§5.4）", () => {
  const compatLayout = {
    ...layout,
    compatibility: {
      version: 1 as const,
      contentSignature: "a".repeat(64),
      blocks: [
        { x: 0, y: 0, width: 300, height: 40, tag: "p", node: "stem/p/0" },
        { x: 0, y: 60, width: 300, height: 60, tag: "p", node: "stem/p/1" },
      ],
      fonts: [
        ["16px", "16px", "400", "16px", "0px"],
        ["16px", "16px", "400", "16px", "0px"],
      ] as [string, string, string, string, string][],
      textRects: [],
    },
  };
  const anchoredDoc = {
    version: 1 as const,
    baseWidth: 600,
    baseHeight: 400,
    strokes: [
      {
        tool: "pen" as const,
        color: "#1f2328",
        weight: 5.76,
        id: "stroke-s1",
        startedAt: 1727392800000,
        pointer: "pen" as const,
        points: [
          { x: 100, y: 20, p: 0.5, t: 9 },
          { x: 200, y: 30, p: 0.5, t: 16 },
        ],
      },
    ],
    anchors: { "stroke-s1": "stem/p/0" } as Record<string, string>,
  };
  async function seedCompatRecord(doc: typeof anchoredDoc) {
    resetAnnotationStoreForTest();
    installAnnotationBackend(memoryAnnotationBackend());
    bindAnnotationSession(session);
    await writeLocalAnnotationBase(
      session,
      scope,
      { png: new Blob(["png"], { type: "image/png" }), layout: compatLayout },
      doc,
    );
    vi.mocked(prepareQuestionAnnotationBase).mockResolvedValue({
      kind: "surface",
      localBase: {
        png: new Blob(["png"], { type: "image/png" }),
        layout: compatLayout,
      },
    });
  }
  /** 近似模式的目标实测布局：同宽（300）、更高（210，行高漂移），块随内容挪动 */
  function mockMeasureDrifted() {
    vi.mocked(measureQuestionSurface).mockReturnValue({
      cssWidth: 300,
      cssHeight: 210,
      textRects: [],
      blocks: [
        { tag: "P", x: 0, y: 0, width: 300, height: 40, node: "stem/p/0" },
        { tag: "P", x: 0, y: 70, width: 300, height: 70, node: "stem/p/1" },
      ],
      fonts: [
        ["16px", "16px", "400", "16px", "0px"],
        ["16px", "16px", "400", "16px", "0px"],
      ],
    });
  }

  it("布局不匹配但锚全在 → 进近似原位：徽标出现、surface 建在当前布局域、不出续画区块", async () => {
    vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
    mockMeasureDrifted();
    await seedCompatRecord(anchoredDoc);
    render(<Harness />);
    fireEvent.click(screen.getByText("标画"));
    expect(await screen.findByText(/已按内容对齐/)).toBeVisible();
    expect(
      await screen.findByRole("toolbar", { name: "第1题标画工具栏" }),
    ).toBeVisible();
    expect(screen.queryByText(/题面已固定为保存时的底图/)).toBeNull();
    // surface 建在视图域（210×2=420 高），垫片带存储域尺寸（600×400）
    expect(vi.mocked(createAnnotationSurface)).toHaveBeenCalledWith(
      expect.objectContaining({
        baseWidth: 600,
        baseHeight: 420,
        reprojectedView: expect.objectContaining({
          storedBaseWidth: 600,
          storedBaseHeight: 400,
        }),
      }),
    );
    // anchorBlocks 供给视图域块表（CSS×2）
    const options = vi.mocked(createAnnotationSurface).mock.calls[0]?.[0];
    const blocks = options?.anchorBlocks?.();
    expect(blocks?.[0]).toMatchObject({ node: "stem/p/0", width: 600 });
    expect(
      document
        .querySelector('[data-slot="question-annotation-overlay"]')
        ?.getAttribute("data-annotation-approximate"),
    ).toBe("true");
  });

  it("锚缺失（旧稿）→ 仍走固定底图续画，不进近似原位", async () => {
    vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
    mockMeasureDrifted();
    await seedCompatRecord({ ...anchoredDoc, anchors: {} });
    render(<Harness />);
    fireEvent.click(screen.getByText("标画"));
    expect(await screen.findByText(/题面已固定为保存时的底图/)).toBeVisible();
    expect(screen.queryByText(/已按内容对齐/)).toBeNull();
    expect(vi.mocked(createAnnotationSurface)).not.toHaveBeenCalledWith(
      expect.objectContaining({ reprojectedView: expect.anything() }),
    );
  });
});
