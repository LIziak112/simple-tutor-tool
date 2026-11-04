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
import {
  annotationKeyOf,
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

import { canvasToPngBlob } from "@/features/ink/engine/canvas-png";
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
async function decodeFrozenImage(width = 600, height = 400) {
  const image = await screen.findByRole("img", { name: "第1题冻结原稿" });
  Object.defineProperties(image, {
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true },
  });
  fireEvent.load(image);
  return image;
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
        answer={answer}
        onAnswer={(next) => setAnswer(next)}
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

it("已存 v2 无论目标排版是否相同，都不重新匹配 HTML", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  const before = await getAnnotationRecord(session, scope);
  render(<Harness />);
  await decodeFrozenImage();
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  expect(questionSurfaceMatchesLayout).not.toHaveBeenCalled();
  expect(awaitQuestionSurfaceReady).not.toHaveBeenCalled();
  const after = await getAnnotationRecord(session, scope);
  expect(after?.doc).toEqual(before?.doc);
  expect(after?.pending).toEqual(before?.pending);
  expect(after?.docVersion).toBe(before?.docVersion);
});

it("v2 已存稿即使目标字体和 DOM 排版不同，仍以原稿为主视图并在原坐标续画", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  const before = await getAnnotationRecord(session, scope);
  const { container } = render(<Harness />);
  const frozen = await screen.findByRole("img", { name: "第1题冻结原稿" });
  Object.defineProperties(frozen, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 400 },
  });
  fireEvent.load(frozen);
  expect(
    frozen.closest('[data-slot="annotation-frozen-surface"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-slot="annotation-continuation"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-slot="annotation-answer-view"]'),
  ).toBeNull();
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  expect(createAnnotationSurface).toHaveBeenCalledWith(
    expect.objectContaining({ baseWidth: 600, baseHeight: 400 }),
  );
  expect(questionSurfaceMatchesLayout).not.toHaveBeenCalled();
  const after = await getAnnotationRecord(session, scope);
  expect(after?.localBase).toEqual(before?.localBase);
  expect(after?.doc).toEqual(before?.doc);
  expect(after?.docVersion).toBe(before?.docVersion);
});

it("首次创建先落本机原稿，图片解码尺寸合格后才开放首笔", async () => {
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  vi.mocked(prepareQuestionAnnotationBase).mockImplementation(async () => {
    await writeLocalAnnotationBase(
      session,
      scope,
      { png: new Blob(["first"], { type: "image/png" }), layout },
      { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
    );
    const saved = await getAnnotationRecord(session, scope);
    if (!saved?.localBase) throw new Error("首张原稿未落盘");
    return { kind: "surface", localBase: saved.localBase };
  });
  const { container } = render(<Harness />);
  fireEvent.click(screen.getByText("标画"));
  const frozen = await screen.findByRole("img", { name: "第1题冻结原稿" });
  expect((await getAnnotationRecord(session, scope))?.local).toBe("saved");
  expect(createAnnotationSurface).not.toHaveBeenCalled();
  Object.defineProperties(frozen, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 400 },
  });
  fireEvent.load(frozen);
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  expect(
    container.querySelector('[data-slot="annotation-continuation"]'),
  ).toBeNull();
  expect(createAnnotationSurface).toHaveBeenCalledWith(
    expect.objectContaining({ baseWidth: 600, baseHeight: 400 }),
  );
  expect(questionSurfaceMatchesLayout).not.toHaveBeenCalled();
});

it("坏尺寸图片或文档不进入可写画布，保留本机原稿", async () => {
  const before = await getAnnotationRecord(session, scope);
  render(<Harness />);
  const frozen = await screen.findByRole("img", { name: "第1题冻结原稿" });
  Object.defineProperties(frozen, {
    naturalWidth: { value: 601 },
    naturalHeight: { value: 400 },
  });
  fireEvent.load(frozen);
  expect(createAnnotationSurface).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("标画"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "尺寸与保存的圈画坐标不符",
  );
  expect(createAnnotationSurface).not.toHaveBeenCalled();
  const after = await getAnnotationRecord(session, scope);
  expect(after?.localBase).toEqual(before?.localBase);
  expect(after?.doc).toEqual(before?.doc);
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

it("已提交只读题即使本机已有 v2 底图也不能重启编辑", async () => {
  render(<Harness readOnly />);
  const frozen = await screen.findByRole("img", { name: "第1题冻结原稿" });
  Object.defineProperties(frozen, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 400 },
  });
  fireEvent.load(frozen);
  fireEvent.click(screen.getByText("标画"));
  expect(await screen.findByRole("alert")).toHaveTextContent("已封存");
  expect(engine.setInputEnabled).not.toHaveBeenCalledWith(true);
  expect(screen.queryByRole("toolbar", { name: "第1题标画工具栏" })).toBeNull();
});

it("圈画在途有采样时收到云端封存，收笔保留本机且卸载输入不抛错", async () => {
  render(<Harness />);
  await decodeFrozenImage();
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
  await decodeFrozenImage();
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

it("等待原稿图片解码期间变成只读，迟到图片不能激活圈画", async () => {
  const { rerender } = render(<Harness />);
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() => expect(prepareQuestionAnnotationBase).toHaveBeenCalled());
  expect(screen.getByTestId("active-editor")).toHaveTextContent("none");
  rerender(<Harness readOnly />);
  await act(async () => {
    await decodeFrozenImage();
  });
  await waitFor(() => expect(screen.queryByText(/正在准备标画/)).toBeNull());
  expect(screen.getByTestId("active-editor")).toHaveTextContent("none");
  expect(engine.setInputEnabled).not.toHaveBeenCalledWith(true);
});

it("v2 固定原稿与唯一作答视图切换，离开原稿前先收笔落盘", async () => {
  render(<Harness />);
  const frozen = await screen.findByRole("img", { name: "第1题冻结原稿" });
  Object.defineProperties(frozen, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 400 },
  });
  fireEvent.load(frozen);
  expect(screen.queryByText("公开题面")).toBeNull();
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  const finished = engine.finish.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "进入作答" }));
  await screen.findByText("公开题面");
  expect(engine.finish.mock.calls.length).toBeGreaterThan(finished);
  expect(screen.queryByRole("img", { name: "第1题冻结原稿" })).toBeNull();
  expect(screen.getAllByRole("radiogroup", { name: "判断对错" })).toHaveLength(
    1,
  );
  fireEvent.click(screen.getByRole("button", { name: "返回原稿" }));
  expect(
    await screen.findByRole("img", { name: "第1题冻结原稿" }),
  ).toBeVisible();
  expect(screen.queryByText("公开题面")).toBeNull();
});

it("v2 工具栏按一次作答即完成收笔并进入唯一作答视图", async () => {
  render(<Harness />);
  await decodeFrozenImage();
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  const finishes = engine.finish.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "作答" }));
  expect(await screen.findByText("公开题面")).toBeVisible();
  expect(screen.getAllByRole("radiogroup", { name: "判断对错" })).toHaveLength(
    1,
  );
  expect(screen.queryByRole("img", { name: "第1题冻结原稿" })).toBeNull();
  expect(engine.finish.mock.calls.length).toBeGreaterThan(finishes);
});

it("v3 填空在原稿保存坐标上接唯一答案，笔态保留值并禁用输入", async () => {
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  await writeLocalAnnotationBase(
    session,
    scope,
    { png: new Blob(["fill"], { type: "image/png" }), layout: fillLayout },
    { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
  );
  const saved = await getAnnotationRecord(session, scope);
  if (!saved?.localBase) throw new Error("缺少 v3 原稿");
  vi.mocked(prepareQuestionAnnotationBase).mockResolvedValue({
    kind: "surface",
    localBase: saved.localBase,
  });
  render(<Harness targetQuestion={fillQuestion} />);
  const frozen = await screen.findByRole("img", { name: "第1题冻结原稿" });
  Object.defineProperties(frozen, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 400 },
  });
  fireEvent.load(frozen);
  const input = await screen.findByRole("textbox", { name: "第1空" });
  expect(screen.getAllByRole("textbox", { name: "第1空" })).toHaveLength(1);
  expect(input.closest('[data-slot="frozen-control"]')).toHaveStyle({
    left: "100px",
    top: "75px",
  });
  expect(screen.queryByRole("button", { name: "进入作答" })).toBeNull();
  fireEvent.change(input, { target: { value: "2x" } });
  expect(input).toHaveValue("2x");
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("toolbar", { name: "第1题标画工具栏" });
  expect(input).toHaveValue("2x");
  expect(input).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "作答" }));
  await waitFor(() => expect(input).not.toBeDisabled());
  expect(screen.getByRole("img", { name: "第1题冻结原稿" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "进入作答" })).toBeNull();
});

it("v3 未知槽位仍可读原稿，作答只经兼容视图的一套控件", async () => {
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  if (fillLayout.renderVersion !== 3) throw new Error("测试需要 v3");
  const firstControl = fillLayout.controls[0];
  if (!firstControl) throw new Error("测试缺少填空槽位");
  await writeLocalAnnotationBase(
    session,
    scope,
    {
      png: new Blob(["fill"], { type: "image/png" }),
      layout: {
        ...fillLayout,
        controls: [{ ...firstControl, slotId: "unknown" }],
      },
    },
    { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
  );
  const saved = await getAnnotationRecord(session, scope);
  if (!saved?.localBase) throw new Error("缺少未知槽位原稿");
  vi.mocked(prepareQuestionAnnotationBase).mockResolvedValue({
    kind: "surface",
    localBase: saved.localBase,
  });
  render(<Harness targetQuestion={fillQuestion} />);
  const frozen = await screen.findByRole("img", { name: "第1题冻结原稿" });
  Object.defineProperties(frozen, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 400 },
  });
  fireEvent.load(frozen);
  expect(screen.queryByRole("textbox", { name: "第1空" })).toBeNull();
  expect(frozen).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "进入作答" }));
  expect(await screen.findByRole("textbox", { name: "第1空" })).toBeVisible();
  expect(screen.getAllByRole("textbox", { name: "第1空" })).toHaveLength(1);
});

it("收笔时重试失败的本机稿，恢复写入后可退出圈画且原稿不变", async () => {
  render(<Harness />);
  await decodeFrozenImage();
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
  await decodeFrozenImage();
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

it("45 秒预览栅格化途中收到同底图新云稿，不发布旧预览或卸载已更新画布", async () => {
  render(<Harness />);
  const frozen = await screen.findByRole("img", { name: "第1题冻结原稿" });
  Object.defineProperties(frozen, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 400 },
  });
  fireEvent.load(frozen);
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
  fireEvent.click(screen.getByRole("button", { name: "作答" }));
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
it("固定原稿画笔态收笔后复开，不重建历史引擎", async () => {
  render(<Harness />);
  await decodeFrozenImage();
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() =>
    expect(
      screen.getByRole("toolbar", { name: "第1题标画工具栏" }),
    ).toBeVisible(),
  );
  expect(screen.getByRole("img", { name: "第1题冻结原稿" })).toBeVisible();
  expect(document.querySelector('[data-slot="question-surface"]')).toBeNull();
  await waitFor(() =>
    expect(engine.setInputEnabled).toHaveBeenLastCalledWith(true),
  );
  const overlay = document.querySelector(
    '[data-slot="question-annotation-overlay"]',
  );
  expect(overlay).toHaveStyle({ width: "300px", height: "200px" });
  const mounts = engine.mount.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "作答" }));
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  expect(engine.finish).toHaveBeenCalled();
  expect(engine.setInputEnabled).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() => expect(screen.getByRole("toolbar")).toBeVisible());
  expect(engine.mount).toHaveBeenCalledTimes(mounts);
});
it("同一固定原稿开合不重测 HTML 或重新挂画布", async () => {
  render(<Harness />);
  await decodeFrozenImage();
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() => expect(screen.getByRole("toolbar")).toBeVisible());
  fireEvent.click(screen.getByRole("button", { name: "作答" }));
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  const mounts = engine.mount.mock.calls.length;
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() => expect(screen.getByRole("toolbar")).toBeVisible());
  expect(engine.mount).toHaveBeenCalledTimes(mounts);
  expect(awaitQuestionSurfaceReady).not.toHaveBeenCalled();
  expect(questionSurfaceMatchesLayout).not.toHaveBeenCalled();
  expect(engine.setInputEnabled).toHaveBeenLastCalledWith(true);
});
it("目标端字体变化不改保存的原稿坐标或打断画笔", async () => {
  render(<Harness />);
  const image = await decodeFrozenImage();
  fireEvent.click(screen.getByText("标画"));
  await waitFor(() =>
    expect(engine.setInputEnabled).toHaveBeenLastCalledWith(true),
  );
  document.body.style.fontSize = "18px";
  expect(image).toHaveAttribute("src", "blob:annotation-test");
  expect(createAnnotationSurface).toHaveBeenCalledWith(
    expect.objectContaining({ baseWidth: 600, baseHeight: 400 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "橡皮" }));
  expect(engine.setInputEnabled).toHaveBeenLastCalledWith(true);
  expect(questionSurfaceMatchesLayout).not.toHaveBeenCalled();
  document.body.style.fontSize = "";
});
it("无 CoordinatedAnnotationProvider 的挂载语境（讲练页）工具切换仍生效", async () => {
  // 回归：协同标画 Context 默认值曾携带具体值，导致无 Provider 时
  // `coordinated.tool ?? localTool` 永不回退，橡皮/颜色/粗细切换全部失灵
  render(<Harness />);
  await decodeFrozenImage();
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
  await decodeFrozenImage();
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

it("隐藏再显示只关画笔输入，保留同一原稿与本机待传稿", async () => {
  const before = await getAnnotationRecord(session, scope);
  const { rerender } = render(<Harness />);
  await decodeFrozenImage();
  const image = screen.getByRole("img", { name: "第1题冻结原稿" });
  rerender(<Harness hidden />);
  expect(image).toBeVisible();
  expect(
    document.querySelector('[data-slot="question-annotation-overlay"]'),
  ).not.toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<Harness />);
  expect(screen.getByRole("img", { name: "第1题冻结原稿" })).toBe(image);
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
    get: async (key) =>
      key === annotationKeyOf(session, scope)
        ? {
            ...saved,
            localBase: null,
            pending: null,
            base: {
              baseId: "22222222-2222-4222-8222-222222222222",
              state: "ready",
              stale: false,
              pixelWidth: 600,
              pixelHeight: 400,
              downloadUrl: "/legacy.png",
            },
          }
        : undefined,
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

it("已封存的 v1 旧稿仍可只读查看，打开不生成底图或开放输入", async () => {
  const saved = await getAnnotationRecord(session, scope);
  if (!saved) throw new Error("缺少夹具");
  const sealedAt = "2026-11-05T00:00:00Z";
  resetAnnotationStoreForTest();
  installAnnotationBackend({
    ...memoryAnnotationBackend(),
    get: async (key) =>
      key === annotationKeyOf(session, scope)
        ? {
            ...saved,
            sealedAt,
            localBase: null,
            pending: null,
            base: {
              baseId: "22222222-2222-4222-8222-222222222222",
              state: "ready",
              stale: false,
              pixelWidth: 600,
              pixelHeight: 400,
              downloadUrl: "/legacy.png",
            },
          }
        : undefined,
  });
  const before = await getAnnotationRecord(session, scope);
  render(<Harness readOnly />);
  fireEvent.click(screen.getByText("标画"));
  await screen.findByRole("dialog", { name: "第1题原圈画" });
  expect(screen.getByRole("img", { hidden: true })).toHaveAttribute(
    "src",
    "/legacy.png",
  );
  expect(screen.queryByRole("toolbar")).toBeNull();
  expect(prepareQuestionAnnotationBase).not.toHaveBeenCalled();
  expect(createAnnotationSurface).not.toHaveBeenCalled();
  expect(engine.setInputEnabled).not.toHaveBeenCalledWith(true);
  expect(await getAnnotationRecord(session, scope)).toEqual(before);
});

it("打开时才发现的旧版底图直接转只读查看，不报错不进入编辑", async () => {
  // 本机无任何缓存：record 层分流不接手，prepare 从云端首次带回 v1 底图。
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  vi.mocked(prepareQuestionAnnotationBase).mockImplementation(async () => {
    await applyAnnotationView(session, scope, {
      base: {
        baseId: "22222222-2222-4222-8222-222222222222",
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
  await decodeFrozenImage();
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

it("非整数原稿高度时图片与墨层共用保存的 CSS 几何框", async () => {
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
  const fractionalLayout = { ...layout, cssHeight: 200.25 };
  await writeLocalAnnotationBase(
    session,
    scope,
    { png: new Blob(["png"], { type: "image/png" }), layout: fractionalLayout },
    { version: 1, baseWidth: 600, baseHeight: 401, strokes: [] },
  );
  const { container } = render(<Harness />);
  const image = await decodeFrozenImage(600, 401);
  expect(image).toHaveStyle({ width: "300px", height: "200.25px" });
  expect(
    container.querySelector('[data-slot="question-annotation-overlay"]'),
  ).toHaveStyle({ width: "300px", height: "200.25px" });
});

it("窄屏可放大同一题面再适应宽度，不重新挂载笔迹或改变保存尺寸", async () => {
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ width: 150, height: 100 } as DOMRect);
  try {
    const { container } = render(<Harness />);
    await decodeFrozenImage();
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
    await decodeFrozenImage();
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
  await decodeFrozenImage();
  await act(async () => fireEvent.click(screen.getByText("标画")));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("图片加载失败");
  // 打开失败是前置条件不满足：不走「上次操作未完成」全局横幅、无重试按钮。
  expect(alert).not.toHaveTextContent("上次操作未完成");
  expect(screen.queryByRole("button", { name: "重试操作" })).toBeNull();
  expect(screen.getByRole("img", { name: "第1题冻结原稿" })).toBeVisible();
});

it("撤销快捷键只归活动标画，不能夺取输入框或输入法的撤销", async () => {
  render(<Harness />);
  await decodeFrozenImage();
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
