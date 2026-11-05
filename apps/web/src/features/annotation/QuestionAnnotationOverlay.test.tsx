import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  AnnotationDoc,
  AnnotationSurfaceLayout,
  AttemptQuestionPublic,
  StudentAnswer,
} from "@tutor/contract";
import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AttemptEditorNotice,
  AttemptEditorProvider,
  useAttemptEditor,
} from "@/features/attempt/AttemptEditorContext";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import type { InkChangeReason } from "@/features/ink/engine/surface";
import { preparePwaUpdate } from "@/lib/pwa-update-safety";
import {
  annotationKeyOf,
  applyAnnotationView,
  applyBasePreview,
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
  onChange: vi.fn(
    (_: (doc: AnnotationDoc, reason: InkChangeReason) => void) => () =>
      undefined,
  ),
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
vi.mock("@/features/ink/engine/canvas-png", async (original) => ({
  ...(await original<typeof import("@/features/ink/engine/canvas-png")>()),
  canvasToPngBlob: vi.fn(
    async () => new Blob(["preview"], { type: "image/png" }),
  ),
}));
vi.mock("./question-base-image", async (original) => ({
  ...(await original<typeof import("./question-base-image")>()),
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

import { canvasToPngBlob } from "@/features/ink/engine/canvas-png";
import { createAnnotationSurface } from "./annotation-surface";
import { prepareQuestionAnnotationBase } from "./question-annotation-base";
import {
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
const fillQuestion: AttemptQuestionPublic = {
  ...question,
  type: "fill",
  stemMd: "计算 $f'(x)$： [[]]。",
};
const fillLayout: AnnotationSurfaceLayout = {
  ...layout,
  renderVersion: 3,
  controls: [
    { slotId: "slot-1", kind: "text", x: 100, y: 75, width: 112, height: 44 },
  ],
};
async function settleGeometry() {
  await waitFor(() => expect(questionSurfaceMatchesLayout).toHaveBeenCalled());
  await act(async () => {});
}
/** 模拟切题收笔：对协调器发起本题 flush（标注/草稿/手写固定顺序）。 */
function FlushButton({ questionId }: { questionId: string }) {
  const editor = useAttemptEditor(null);
  return (
    <button type="button" onClick={() => void editor?.flush(questionId)}>
      flush
    </button>
  );
}
function ActiveEditorState() {
  const editor = useAttemptEditor();
  return (
    <output data-testid="active-editor">
      {editor?.active?.kind ?? "none"}
    </output>
  );
}
function Harness({
  hidden = false,
  readOnly = false,
  targetQuestion = question,
}: {
  hidden?: boolean;
  readOnly?: boolean;
  targetQuestion?: AttemptQuestionPublic;
}) {
  const ref = useRef<QuestionAnnotationOverlayHandle>(null);
  const [answer, setAnswer] = useState<StudentAnswer | undefined>();
  return (
    <AttemptEditorProvider>
      <AttemptEditorNotice />
      <ActiveEditorState />
      <button type="button" onClick={() => void ref.current?.start()}>
        标画
      </button>
      <input aria-label="正常答案" />
      <FlushButton questionId={question.id} />
      <QuestionAnnotationOverlay
        ref={ref}
        attemptId={scope.attemptId}
        question={targetQuestion}
        label="第1题"
        hidden={hidden}
        annotationReadOnly={readOnly}
      >
        <QuestionSurface
          question={targetQuestion}
          answer={answer}
          onAnswer={(next) => setAnswer(next)}
          readOnly={readOnly}
        />
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
  engine.finish.mockReset();
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
  const saved = await getAnnotationRecord(session, scope);
  if (!saved?.localBase) throw new Error("缺少已保存底图夹具");
  vi.mocked(prepareQuestionAnnotationBase).mockResolvedValue({
    kind: "surface",
    localBase: saved.localBase,
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetAnnotationSession();
  vi.unstubAllGlobals();
});
it("保存题面只核验真实 DOM，原生判断仍可在笔迹可见时直接作答", async () => {
  const { container } = render(<Harness />);
  await settleGeometry();
  await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());
  expect(screen.queryByRole("img", { name: "第1题冻结原稿" })).toBeNull();
  expect(screen.queryByRole("button", { name: "进入作答" })).toBeNull();
  const radio = screen.getByRole("radio", { name: "错" });
  fireEvent.click(radio);
  expect(screen.getByRole("radio", { name: "错" })).toBe(radio);
  expect(radio).toBeChecked();
  expect(
    container.querySelector('[data-slot="question-annotation-overlay"]'),
  ).toBeVisible();
  expect(
    container.querySelectorAll('[data-slot="question-surface"]'),
  ).toHaveLength(1);
});
it("v3 填空使用原生唯一空位，不从历史 controls 坐标恢复输入", async () => {
  await writeLocalAnnotationBase(
    session,
    scope,
    { png: new Blob(["fill"], { type: "image/png" }), layout: fillLayout },
    { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
  );
  const savedFill = await getAnnotationRecord(session, scope);
  if (!savedFill?.localBase) throw new Error("缺少填空底图");
  vi.mocked(prepareQuestionAnnotationBase).mockResolvedValue({
    kind: "surface",
    localBase: savedFill.localBase,
  });
  const { container } = render(<Harness targetQuestion={fillQuestion} />);
  const input = screen.getByRole("textbox", { name: "第1空" });
  await settleGeometry();
  fireEvent.change(input, { target: { value: "中文 2x" } });
  expect(input).toHaveValue("中文 2x");
  expect(container.querySelector('[data-slot="frozen-control"]')).toBeNull();
  expect(
    container.querySelector('[data-slot="question-annotation-overlay"]'),
  ).toBeVisible();
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar");
  expect(input.closest('[data-slot="question-surface"]')).toHaveAttribute(
    "inert",
  );
  fireEvent.click(screen.getByRole("button", { name: "完成标画" }));
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  expect(screen.getByRole("textbox", { name: "第1空" })).toBe(input);
  expect(input).toHaveValue("中文 2x");
});
it.each(["区域证据", "仅哈希"] as const)(
  "几何无法匹配时明确保稿，不显墨、不开笔也不换图片（%s）",
  async (evidence) => {
    vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
    if (evidence === "区域证据") {
      await writeLocalAnnotationBase(
        session,
        scope,
        {
          png: new Blob(["png"], { type: "image/png" }),
          layout: {
            ...layout,
            renderVersion: 4,
            renderProfile: "whole-question-v1",
            compatibility: {
              version: 1,
              contentSignature: "d".repeat(64),
              blocks: [
                {
                  tag: "P",
                  x: 0,
                  y: 0,
                  width: 300,
                  height: 40,
                  node: "stem/p/0",
                },
              ],
              fonts: [["16px", "16px", "400", "16px", "0px"]],
              textRects: [],
            },
          },
        },
        { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
      );
    }
    const before = await getAnnotationRecord(session, scope);
    render(<Harness />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      evidence === "区域证据" ? "10px" : "缺少位置证据",
    );
    fireEvent.click(screen.getByText("标画"));
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    expect(engine.setInputEnabled).not.toHaveBeenCalledWith(true);
    expect(screen.queryByRole("img")).toBeNull();
    expect((await getAnnotationRecord(session, scope))?.localBase).toEqual(
      before?.localBase,
    );
    expect((await getAnnotationRecord(session, scope))?.doc).toEqual(
      before?.doc,
    );
  },
);
it("每笔正文更新不重新核验或卸载画布，完成与复开保留撤销历史", async () => {
  render(<Harness />);
  await settleGeometry();
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar");
  const count = vi.mocked(questionSurfaceMatchesLayout).mock.calls.length;
  const mounted = engine.mount.mock.calls.length;
  const current = await getAnnotationRecord(session, scope);
  if (!current) throw new Error("缺少稿件");
  await act(async () => {
    writeAnnotationDoc(session, scope, current.doc);
    await settleAnnotationRecordPersistence(session, scope);
  });
  expect(questionSurfaceMatchesLayout).toHaveBeenCalledTimes(count);
  expect(engine.mount).toHaveBeenCalledTimes(mounted);
  fireEvent.click(screen.getByRole("button", { name: "完成标画" }));
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar");
  expect(engine.mount).toHaveBeenCalledTimes(mounted);
});
it("readonly 只锁输入，题面与同框笔迹保持挂载", async () => {
  const { rerender, container } = render(<Harness />);
  await settleGeometry();
  await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());
  const node = container.querySelector('[data-slot="question-surface"]');
  rerender(<Harness readOnly />);
  fireEvent.click(screen.getByText("标画"));
  expect(await screen.findByRole("alert")).toHaveTextContent("已封存");
  expect(container.querySelector('[data-slot="question-surface"]')).toBe(node);
  expect(engine.mount).toHaveBeenCalledOnce();
  expect(engine.setInputEnabled).not.toHaveBeenCalledWith(true);
});
it("本机基准首次绑定云端 baseId 时保留几何核验、画布和撤销历史", async () => {
  render(<Harness />);
  await settleGeometry();
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar");
  const saved = await getAnnotationRecord(session, scope);
  if (!saved?.localBase) throw new Error("缺少本机基准");
  const localBase = saved.localBase;
  const measured = vi.mocked(questionSurfaceMatchesLayout).mock.calls.length;
  const mounted = engine.mount.mock.calls.length;
  await act(async () => {
    await applyBasePreview(
      session,
      scope,
      {
        base: {
          baseId: "22222222-2222-4222-8222-222222222222",
          state: "ready",
          stale: false,
          pixelWidth: 600,
          pixelHeight: 400,
          layout: localBase.layout,
        },
        maxWidthPx: 600,
        baseRenderVersion: 2,
        questionRevisionId: question.questionRevisionId,
        questionNo: 1,
        questionMd: question.stemMd,
        mediaSrcs: [],
        graphFigures: [],
        interactionNotes: [],
      },
      localBase.png,
    );
  });
  expect(questionSurfaceMatchesLayout).toHaveBeenCalledTimes(measured);
  expect(engine.mount).toHaveBeenCalledTimes(mounted);
  expect(engine.destroy).not.toHaveBeenCalled();
  expect(engine.setInputEnabled).toHaveBeenLastCalledWith(true);
});

it("本机未知协议读取失败明确告警，不按无稿生成新底图", async () => {
  const backend = memoryAnnotationBackend();
  await backend.set(annotationKeyOf(session, scope), {
    doc: { version: 2, baseWidth: 600, baseHeight: 400, strokes: [] },
    localBase: null,
    pending: null,
  });
  resetAnnotationStoreForTest();
  installAnnotationBackend(backend);
  render(<Harness />);
  expect(await screen.findByRole("alert")).toHaveTextContent("版本未知");
  fireEvent.click(screen.getByText("标画"));
  expect(await screen.findByRole("alert")).toHaveTextContent("版本未知");
  expect(prepareQuestionAnnotationBase).not.toHaveBeenCalled();
  expect(await backend.get(annotationKeyOf(session, scope))).toMatchObject({
    doc: { version: 2 },
  });
});

it("圈画在途有采样时收到云端封存，收笔保留本机且卸载输入不抛错", async () => {
  render(<Harness />);
  await settleGeometry();
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  const onChange = engine.onChange.mock.calls.at(-1)?.[0];
  if (!onChange) throw new Error("标画画布未登记收笔回调");
  const sampled: AnnotationDoc = {
    version: 1,
    baseWidth: 600,
    baseHeight: 400,
    strokes: [
      {
        tool: "pen",
        color: "#dc2626",
        weight: 4,
        points: [{ x: 20, y: 30, p: 0.5, t: 0 }],
      },
    ],
  };
  let hasLiveStroke = true;
  engine.finish.mockImplementation(() => {
    if (!hasLiveStroke) return;
    hasLiveStroke = false;
    onChange(sampled, "stroke");
  });
  const sealedAt = "2026-11-05T00:00:00Z";
  await act(async () => {
    await applyAnnotationView(session, scope, {
      base: null,
      maxWidthPx: 600,
      doc: { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
      annotation: {
        annotationId: "33333333-3333-4333-8333-333333333333",
        revision: 1,
        hash: "a".repeat(64),
        savedAt: sealedAt,
        sealedAt,
        strokeCount: 0,
        pointCount: 0,
      },
    });
  });
  await waitFor(() =>
    expect(engine.setInputEnabled).toHaveBeenLastCalledWith(false),
  );
  await settleAnnotationRecordPersistence(session, scope);
  const saved = await getAnnotationRecord(session, scope, { strictRead: true });
  expect(saved?.sealedAt).toBe(sealedAt);
  expect(saved?.doc).toEqual(sampled);
  expect(saved?.pending?.doc).toEqual(sampled);
  expect(saved?.retained?.reason).toMatch(/封存/);
  expect(saved?.baseRevision).toBe(1);
  expect(screen.queryByRole("toolbar", { name: "第1题标画工具栏" })).toBeNull();
  expect(() => writeAnnotationDoc(session, scope, sampled)).toThrow(/已封存/);
});

it("准备原稿期间变成只读，迟到结果不能激活圈画", async () => {
  const saved = await getAnnotationRecord(session, scope);
  if (!saved?.localBase) throw new Error("缺少已保存底图夹具");
  const localBase = saved.localBase;
  let release: () => void = () => {
    throw new Error("准备尚未开始");
  };
  vi.mocked(prepareQuestionAnnotationBase).mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { kind: "surface", localBase };
  });
  const { rerender } = render(<Harness />);
  await settleGeometry();
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() => expect(prepareQuestionAnnotationBase).toHaveBeenCalled());
  rerender(<Harness readOnly />);
  await act(async () => {
    release();
  });
  await waitFor(() => expect(screen.queryByText(/正在准备标画/)).toBeNull());
  expect(screen.getByTestId("active-editor")).toHaveTextContent("none");
  expect(engine.setInputEnabled).not.toHaveBeenCalledWith(true);
});

it("收笔时重试失败的本机稿，恢复写入后可退出圈画且原稿不变", async () => {
  render(<Harness />);
  await settleGeometry();
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
  fireEvent.click(screen.getByRole("button", { name: "完成标画" }));
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
it("标画收起保活到期释放空画布，重新打开恢复引擎", async () => {
  render(<Harness />);
  await settleGeometry();
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() => expect(screen.getByRole("toolbar")).toBeVisible());
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "完成标画" }));
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

it("无 CoordinatedAnnotationProvider 的挂载语境（讲练页）工具切换仍生效", async () => {
  // 回归：协同标画 Context 默认值曾携带具体值，导致无 Provider 时
  // `coordinated.tool ?? localTool` 永不回退，橡皮/颜色/粗细切换全部失灵
  render(<Harness />);
  await settleGeometry();
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
it("切题 flush 由固定原稿唯一宿主收笔并等待本机保存", async () => {
  render(<Harness />);
  await settleGeometry();
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  const finishes = engine.finish.mock.calls.length;
  const settleRecord = vi.mocked(settleAnnotationRecordPersistence);
  settleRecord.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "flush" }));
  await waitFor(() =>
    expect(engine.finish.mock.calls.length).toBeGreaterThan(finishes),
  );
  await waitFor(() =>
    expect(settleRecord).toHaveBeenCalledWith(session, scope),
  );
  expect(createAnnotationSurface).toHaveBeenCalledTimes(1);
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

it("底图准备失败仍能答题且就地显示原因，不进全局重试横幅", async () => {
  vi.mocked(prepareQuestionAnnotationBase).mockRejectedValue(
    new Error("图片加载失败"),
  );
  render(<Harness />);
  await settleGeometry();
  await act(async () => fireEvent.click(screen.getByText("标画")));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("图片加载失败");
  // 打开失败是前置条件不满足：不走「上次操作未完成」全局横幅、无重试按钮。
  expect(alert).not.toHaveTextContent("上次操作未完成");
  expect(screen.queryByRole("button", { name: "重试操作" })).toBeNull();
  expect(
    document.querySelector('[data-slot="question-surface"]'),
  ).toBeVisible();
});

it("撤销快捷键只归活动标画，不能夺取输入框或输入法的撤销", async () => {
  render(<Harness />);
  await settleGeometry();
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

it("冻结原稿开笔后，PWA 更新仍先收笔并核验本机稿", async () => {
  render(<Harness />);
  await settleGeometry();
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  engine.finish.mockClear();
  const prepared = await preparePwaUpdate();
  try {
    prepared.assertReady();
    expect(engine.finish).toHaveBeenCalled();
    expect((await getAnnotationRecord(session, scope))?.local).toBe("saved");
  } finally {
    prepared.release();
  }
});

it("45 秒预览栅格化途中收到同底图新云稿，不发布旧预览或卸载已更新画布", async () => {
  render(<Harness />);
  await settleGeometry();
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  const host = document.querySelector(
    '[data-slot="question-annotation-overlay"] > div',
  );
  if (!host) throw new Error("缺少圈画画布宿主");
  host.append(document.createElement("canvas"));
  const delayed = Promise.withResolvers<Blob>();
  vi.mocked(canvasToPngBlob).mockReturnValue(delayed.promise);
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "完成标画" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45_000);
  });
  expect(canvasToPngBlob).toHaveBeenCalledOnce();
  const destroyed = engine.destroy.mock.calls.length;
  const nextDoc = {
    version: 1 as const,
    baseWidth: 600,
    baseHeight: 400,
    strokes: [
      {
        tool: "pen" as const,
        color: "#dc2626",
        weight: 4,
        points: [{ x: 20, y: 30, p: 0.5, t: 0 }],
      },
    ],
  };
  await act(async () => {
    await applyAnnotationView(session, scope, {
      base: null,
      maxWidthPx: 600,
      doc: nextDoc,
      annotation: {
        annotationId: "33333333-3333-4333-8333-333333333333",
        revision: 1,
        hash: "a".repeat(64),
        savedAt: "2026-11-05T00:00:00Z",
        sealedAt: null,
        strokeCount: 1,
        pointCount: 1,
      },
    });
  });
  expect(engine.load).toHaveBeenCalledWith(nextDoc);
  await act(async () =>
    delayed.resolve(new Blob(["old"], { type: "image/png" })),
  );
  expect(engine.destroy.mock.calls.length).toBe(destroyed);
  expect(screen.queryByRole("img", { name: "本题标画笔迹" })).toBeNull();
});
