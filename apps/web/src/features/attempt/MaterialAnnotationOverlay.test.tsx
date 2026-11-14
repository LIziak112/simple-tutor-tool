import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { InkDoc, InkStroke } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoordinatedAnnotationProvider,
  useCoordinatedAnnotation,
} from "@/features/annotation/coordinated-annotation-context";
import { selectInkTool } from "@/features/ink/engine/toolbox.ts";
import { INK_HIGHLIGHTER_COLORS } from "@/features/ink/engine/types.ts";
import {
  resetSessionInputPreference,
  setSessionInputPreference,
} from "@/features/ink/input-preference";
import { preparePwaUpdate } from "@/lib/pwa-update-safety";
import {
  AttemptEditorProvider,
  useAttemptEditor,
} from "./AttemptEditorContext";
import {
  bindDraftSession,
  draftStore,
  installDraftBackend,
  memoryBackend,
} from "./draft-store";
import { MaterialAnnotationOverlay } from "./MaterialAnnotationOverlay";

// 绘制层复用 ink/replay/draw（jsdom 无 2d 上下文）——按仓内惯例 mock 本模块，
// 按实际可见笔画统一记录全量与顺序绘制的入参。
const drawFrameMock = vi.fn();
/** 图形预览与橡皮圈所在的临时层（真实实现盖在回放画布上） */
const previewMock = {
  showOutline: vi.fn(),
  clear: vi.fn(),
  showRing: vi.fn(),
  hideRing: vi.fn(),
};
vi.mock("@/features/ink/replay/draw", () => ({
  createAtramentReplayCanvas: () => ({
    previewLayer: () => previewMock,
    drawFrame: drawFrameMock,
    drawOrdered: (
      strokes: InkStroke[],
      completed: number,
      active: InkStroke | null,
      points: number,
    ) => {
      const visible = strokes.slice(0, completed);
      drawFrameMock(active === null ? visible : [...visible, active], [
        ...visible.map((stroke) => stroke.points.length),
        ...(active === null ? [] : [points]),
      ]);
    },
    destroy: () => undefined,
  }),
}));

// 辅助触发器：切换编辑器为标注态
function AnnotationToggle({ questionId }: { questionId: string }) {
  const editor = useAttemptEditor();
  return (
    <button
      type="button"
      data-testid="toggle-annotation"
      onClick={() => {
        void editor?.request({ questionId, kind: "annotation" });
      }}
    >
      切换标注态
    </button>
  );
}

// 辅助触发器：协同标画工具切回画笔
function PenToolToggle() {
  const coordinated = useCoordinatedAnnotation();
  return (
    <button
      type="button"
      data-testid="toggle-pen"
      onClick={() =>
        coordinated?.setToolbox(selectInkTool(coordinated.toolbox, "pen"))
      }
    >
      切换画笔
    </button>
  );
}

// 辅助触发器：退出标注态（editor.request(null) 收笔并关闭激活编辑器）
function AnnotationRelease() {
  const editor = useAttemptEditor();
  return (
    <button
      type="button"
      data-testid="release-annotation"
      onClick={() => {
        void editor?.request(null);
      }}
    >
      退出标注态
    </button>
  );
}

function inputLayerOf(container: HTMLElement): HTMLElement {
  const layer = container.querySelector<HTMLElement>(
    '[data-slot="material-annotation-input"]',
  );
  if (!layer) throw new Error("输入层应已挂载");
  return layer;
}

function overlayRootOf(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>(
    '[data-slot="material-annotation-overlay"]',
  );
  if (!root) throw new Error("材料圈画层根应已挂载");
  return root;
}

function frameOf(container: HTMLElement): HTMLElement {
  const frame = container.querySelector<HTMLElement>(
    '[data-slot="material-ink-frame"]',
  );
  if (!frame) throw new Error("冻结框应已挂载");
  return frame;
}

/** 材料正文壳（children+输入层）：首笔捕获的测量面（按钮在壳外） */
function liveSurfaceOf(container: HTMLElement): HTMLElement {
  const live = container.querySelector<HTMLElement>(
    '[data-slot="material-live-surface"]',
  );
  if (!live) throw new Error("活排版壳应已挂载");
  return live;
}

/** 等待 rAF 合帧的重绘落地 */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

function mockLayerRect(layer: HTMLElement, width = 500, height = 400): void {
  vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    x: 0,
    y: 0,
    toJSON: () => {},
  });
}

function strokeAt(x: number, y: number): InkStroke {
  return {
    tool: "pen",
    color: "#dc2626",
    weight: 2.5,
    points: [
      { x, y, p: 0.5, t: 1 },
      { x: x + 20, y, p: 0.5, t: 2 },
    ],
  };
}

function inkDocOf(
  strokes: InkStroke[],
): Extract<InkDoc, { engine: "atrament" }> {
  return {
    engine: "atrament",
    version: 1,
    data: { width: 1000, strokes },
    updatedAt: Date.now(),
  };
}

/** 模拟一次完整落笔（pointer down → up） */
async function drawStroke(
  layer: HTMLElement,
  clientX: number,
  clientY = 50,
): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(layer, {
      pointerId: 1,
      button: 0,
      pointerType: "pen",
      clientX,
      clientY,
      pressure: 0.5,
    });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
  });
}

/**
 * 可手动触发的 ResizeObserver 桩：全局桩不派发回调，冻结宽/缩放/收笔依赖
 * 观察器推送——本桩按 observe 目标过滤，测试对指定元素手动派发 contentRect。
 */
function manualResizeObserver() {
  const instances: {
    targets: Set<Element>;
    callback: ResizeObserverCallback;
  }[] = [];
  class ManualResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      instances.push({ targets: this.targets, callback });
    }
    observe(target: Element): void {
      this.targets.add(target);
    }
    unobserve(target: Element): void {
      this.targets.delete(target);
    }
    disconnect(): void {
      this.targets.clear();
    }
  }
  vi.stubGlobal("ResizeObserver", ManualResizeObserver);
  const entryOf = (target: Element, width: number, height: number) =>
    ({
      target,
      contentRect: { x: 0, y: 0, width, height, top: 0, left: 0 },
    }) as ResizeObserverEntry;
  return {
    fire(target: Element, width: number, height = 100) {
      for (const instance of instances) {
        if (!instance.targets.has(target)) continue;
        instance.callback(
          [entryOf(target, width, height)],
          {} as ResizeObserver,
        );
      }
    },
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

/** 等待无基准材料的就绪门控放行（data-ink-ready=true） */
async function waitInkReady(root: HTMLElement): Promise<void> {
  await waitFor(() => expect(root).toHaveAttribute("data-ink-ready", "true"));
}

describe("MaterialAnnotationOverlay 材料圈画手写图层", () => {
  beforeEach(() => {
    installDraftBackend(memoryBackend());
    drawFrameMock.mockClear();
  });
  afterEach(resetSessionInputPreference);

  it("更新前收下最后一笔真实采样并等材料稿落盘，即使输入层漏收pointerup", async () => {
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>更新前材料</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );
    fireEvent.click(screen.getByTestId("toggle-annotation"));
    await waitInkReady(overlayRootOf(container));
    const layer = inputLayerOf(container);
    mockLayerRect(layer);
    fireEvent.pointerDown(layer, {
      pointerId: 1,
      button: 0,
      pointerType: "pen",
      clientX: 50,
      clientY: 50,
      pressure: 0.5,
    });
    fireEvent.pointerMove(layer, {
      pointerId: 1,
      pointerType: "pen",
      clientX: 80,
      clientY: 60,
      pressure: 0.5,
    });
    fireEvent.pointerUp(document, { pointerId: 1, pointerType: "pen" });
    expect(draftStore.getMaterialInk("att-1", "mat-1")).toBeNull();
    await act(async () => {
      const prepared = await preparePwaUpdate();
      prepared.assertReady();
      prepared.release();
    });
    const stored = draftStore.getMaterialInk("att-1", "mat-1");
    if (stored?.engine !== "atrament")
      throw new Error("更新前必须保留材料最后一笔");
    expect(stored.data.strokes).toHaveLength(1);
    expect(stored.data.strokes[0]?.points).toHaveLength(2);
  });

  it("材料本机落盘失败时拒绝更新并保留已有笔迹", async () => {
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>故障材料</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );
    fireEvent.click(screen.getByTestId("toggle-annotation"));
    await waitInkReady(overlayRootOf(container));
    const layer = inputLayerOf(container);
    mockLayerRect(layer);
    installDraftBackend({
      ...memoryBackend(),
      set: async () => {
        throw new Error("材料无法写入");
      },
    });
    await drawStroke(layer, 50);
    await expect(preparePwaUpdate()).rejects.toThrow("本机");
    expect(draftStore.getMaterialInk("att-1", "mat-1")).not.toBeNull();
  });

  it("非标注态时输入层不拦截指针（pointer-events: none），内容可读", () => {
    const { container } = render(
      <AttemptEditorProvider>
        <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
          <div data-testid="material-content">四天气温与降水量表</div>
        </MaterialAnnotationOverlay>
      </AttemptEditorProvider>,
    );

    expect(screen.getByTestId("material-content")).toBeInTheDocument();
    const root = overlayRootOf(container);
    expect(root).toHaveAttribute("data-drawing", "false");
    expect(inputLayerOf(container)).toHaveStyle({ pointerEvents: "none" });
  });

  it("已存材料笔迹挂载即在固定阅读框恢复并重绘（内存命中路径）", async () => {
    const observer = manualResizeObserver();
    try {
      draftStore.saveMaterialInk(
        "att-1",
        "mat-1",
        inkDocOf([strokeAt(10, 10)]),
      );
      draftStore.saveMaterialInkBase("att-1", "mat-1", {
        cssWidth: 500,
        cssHeight: 400,
      });

      const { container } = render(
        <AttemptEditorProvider>
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>材料正文</div>
          </MaterialAnnotationOverlay>
        </AttemptEditorProvider>,
      );

      const root = overlayRootOf(container);
      expect(root).toHaveAttribute("data-stroke-count", "1");
      // 已有基准恒使用固定阅读框，资源测量不改变笔迹身份
      act(() => observer.fire(liveSurfaceOf(container), 500, 400));
      await waitFor(() =>
        expect(root).toHaveAttribute("data-ink-visible", "true"),
      );
      await flushFrame();
      expect(drawFrameMock).toHaveBeenCalled();
      const [strokes, visible] = drawFrameMock.mock.calls.at(-1) as [
        unknown[],
        number[],
      ];
      expect(strokes).toHaveLength(1);
      expect(visible).toEqual([2]);
    } finally {
      observer.restore();
    }
  });

  it("冷启动异步恢复后触发重绘（回归：恢复只改 state 不重绘画布）", async () => {
    const observer = manualResizeObserver();
    try {
      const backend = memoryBackend();
      installDraftBackend(backend);
      await backend.set("draft:att-cold", {
        answers: {},
        inks: {},
        materialInks: { "mat-cold": inkDocOf([strokeAt(100, 100)]) },
        materialInkBases: { "mat-cold": { cssWidth: 500, cssHeight: 400 } },
        savedAt: Date.now(),
        syncedAt: 0,
        answerDigests: {},
        inkDigests: {},
        answerRevisions: {},
        answerMutationIds: {},
        answerConflicts: {},
      });

      const { container } = render(
        <AttemptEditorProvider>
          <MaterialAnnotationOverlay attemptId="att-cold" materialId="mat-cold">
            <div>冷启动材料</div>
          </MaterialAnnotationOverlay>
        </AttemptEditorProvider>,
      );

      const root = overlayRootOf(container);
      await waitFor(() => {
        expect(root).toHaveAttribute("data-stroke-count", "1");
      });
      act(() => observer.fire(liveSurfaceOf(container), 500, 400));
      await waitFor(() => {
        const [strokes] = drawFrameMock.mock.calls.at(-1) as [
          unknown[],
          number[],
        ];
        expect(strokes).toHaveLength(1);
      });
    } finally {
      observer.restore();
    }
  });

  it("账号 epoch 变化后迟到的材料读取不恢复旧账号笔迹或基准", async () => {
    let resolveRead: (value: unknown) => void = () => {};
    const pendingRead = new Promise<unknown>((resolve) => {
      resolveRead = resolve;
    });
    const get = vi.fn(() => pendingRead);
    installDraftBackend({ ...memoryBackend(), get });
    bindDraftSession({ origin: "https://tutor.test", studentId: "old" });
    const { container } = render(
      <MaterialAnnotationOverlay
        attemptId="same-attempt"
        materialId="m1"
        inkKey="m1|1"
      >
        <div>账号隔离材料</div>
      </MaterialAnnotationOverlay>,
    );
    expect(get).toHaveBeenCalledOnce();
    bindDraftSession({ origin: "https://tutor.test", studentId: "new" });
    await act(async () => {
      resolveRead({
        materialInks: { "m1|1": inkDocOf([strokeAt(100, 100)]) },
        materialInkBases: { "m1|1": { cssWidth: 480, cssHeight: 400 } },
      });
      await pendingRead;
    });
    expect(overlayRootOf(container)).toHaveAttribute("data-stroke-count", "0");
    expect(frameOf(container).style.width).toBe("");
    expect(draftStore.getMaterialInk("same-attempt", "m1|1")).toBeNull();
    expect(draftStore.getMaterialInkBase("same-attempt", "m1|1")).toBeNull();
  });

  it("标注态落笔保存到 draftStore：引擎单源色粗、1000 逻辑宽归一化与相对毫秒", async () => {
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>材料文章段落</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );

    fireEvent.click(screen.getByTestId("toggle-annotation"));
    const root = overlayRootOf(container);
    await waitFor(() => expect(root).toHaveAttribute("data-drawing", "true"));
    await waitInkReady(root);

    const layer = inputLayerOf(container);
    mockLayerRect(layer);

    await act(async () => {
      fireEvent.pointerDown(layer, {
        pointerId: 1,
        button: 0,
        pointerType: "pen",
        clientX: 50,
        clientY: 50,
        pressure: 0.5,
      });
      fireEvent.pointerMove(layer, {
        pointerId: 1,
        pointerType: "pen",
        clientX: 100,
        clientY: 60,
        pressure: 0.5,
      });
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
    });

    const stored = draftStore.getMaterialInk("att-1", "mat-1");
    expect(stored?.engine).toBe("atrament");
    if (stored?.engine === "atrament") {
      expect(stored.data.width).toBe(1000);
      expect(stored.data.strokes).toHaveLength(1);
      const stroke = stored.data.strokes[0];
      // 引擎单源：红=INK_PEN_COLORS.red、细=INK_PEN_SIZES.thin（逻辑单位）
      expect(stroke?.color).toBe("#dc2626");
      expect(stroke?.weight).toBe(2.5);
      const points = stroke?.points ?? [];
      expect(points.length).toBeGreaterThanOrEqual(2);
      // 50px / 500px * 1000 = 100（按容器宽归一化）
      expect(points[0]?.x).toBe(100);
      expect(points[0]?.y).toBe(100);
      // t 为相对本笔毫秒（引擎契约口径），不是绝对纪元
      expect(points[0]?.t).toBeGreaterThanOrEqual(0);
      expect(points[0]?.t).toBeLessThan(1000);
    }
    expect(root).toHaveAttribute("data-stroke-count", "1");
    // 首笔收笔冻结：按落笔矩形（500×400）捕获基准并随稿保存
    expect(draftStore.getMaterialInkBase("att-1", "mat-1")).toEqual({
      cssWidth: 500,
      cssHeight: 400,
    });
  });

  it("材料圈画不沿用正式手写的手指输入偏好", async () => {
    setSessionInputPreference("finger");
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>手掌区域</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );

    fireEvent.click(screen.getByTestId("toggle-annotation"));
    const root = overlayRootOf(container);
    await waitInkReady(root);
    const layer = inputLayerOf(container);
    mockLayerRect(layer);

    // 手指交给浏览器滚动，不能只做到不落墨却取消默认手势。
    const touchDown = createEvent.pointerDown(layer, {
      pointerId: 2,
      button: 0,
      pointerType: "touch",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(layer, touchDown);
    expect(touchDown.defaultPrevented).toBe(false);

    await act(async () => {
      fireEvent.pointerDown(layer, {
        pointerId: 2,
        button: 0,
        pointerType: "touch",
        clientX: 50,
        clientY: 50,
        pressure: 0.5,
      });
      fireEvent.pointerMove(layer, {
        pointerId: 2,
        pointerType: "touch",
        clientX: 120,
        clientY: 60,
      });
      fireEvent.pointerUp(layer, { pointerId: 2, pointerType: "touch" });
    });

    expect(draftStore.getMaterialInk("att-1", "mat-1")).toBeNull();
    expect(overlayRootOf(container)).toHaveAttribute("data-stroke-count", "0");
  });

  it.each(["touchstart", "touchmove"] as const)(
    "%s 只阻止 Pencil 原生滚动，保留手指阅读",
    async (type) => {
      const { container } = render(
        <AttemptEditorProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay attemptId="att-stylus" materialId="m1">
            <div>笔写与手指阅读</div>
          </MaterialAnnotationOverlay>
        </AttemptEditorProvider>,
      );
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      await waitInkReady(overlayRootOf(container));
      const layer = inputLayerOf(container);
      const touch = (changed: string[], all = changed) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          changedTouches: {
            value: changed.map((touchType) => ({ touchType })),
          },
          touches: { value: all.map((touchType) => ({ touchType })) },
        });
        fireEvent(layer, event);
        return event.defaultPrevented;
      };
      expect(touch(["direct"])).toBe(false);
      expect(touch(["stylus"], ["direct", "stylus"])).toBe(true);
      expect(touch(["direct"], ["stylus", "direct"])).toBe(true);
    },
  );

  it("窗口失焦时在途一笔按已收采样收笔保存，后续 move 不再计入", async () => {
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>失焦材料</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );

    fireEvent.click(screen.getByTestId("toggle-annotation"));
    const root = overlayRootOf(container);
    await waitInkReady(root);
    const layer = inputLayerOf(container);
    mockLayerRect(layer);

    await act(async () => {
      fireEvent.pointerDown(layer, {
        pointerId: 1,
        button: 0,
        pointerType: "pen",
        clientX: 50,
        clientY: 50,
        pressure: 0.5,
      });
      fireEvent.pointerMove(layer, {
        pointerId: 1,
        pointerType: "pen",
        clientX: 80,
        clientY: 60,
        pressure: 0.5,
      });
      fireEvent(window, new Event("blur"));
      fireEvent.pointerMove(layer, {
        pointerId: 1,
        pointerType: "pen",
        clientX: 300,
        clientY: 60,
        pressure: 0.5,
      });
    });

    const stored = draftStore.getMaterialInk("att-1", "mat-1");
    if (stored?.engine === "atrament") {
      expect(stored.data.strokes).toHaveLength(1);
      // 已收采样 = down + move(80px)，失焦后的 300px 不补造
      expect(stored.data.strokes[0]?.points).toHaveLength(2);
      expect(stored.data.strokes[0]?.points[1]?.x).toBe(160);
    } else {
      throw new Error("失焦收笔应已落稿");
    }
  });

  it("仅关联题进入标注态时激活手写；无关题目圈画不劫持材料事件", () => {
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider>
          <AnnotationToggle questionId="q-unrelated" />
          <MaterialAnnotationOverlay
            attemptId="att-1"
            materialId="mat-1"
            associatedQuestionIds={["q1", "q2"]}
          >
            <div>材料保护区</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );

    fireEvent.click(screen.getByTestId("toggle-annotation"));
    const root = overlayRootOf(container);
    expect(root).toHaveAttribute("data-drawing", "false");
    expect(
      root.querySelector('[data-slot="material-annotation-input"]'),
    ).toHaveStyle({ pointerEvents: "none" });
  });

  it("inkKey 按材料版本隔离：双版本卷两份面板笔迹互不覆盖", async () => {
    const previousDoc = inkDocOf([strokeAt(20, 20)]);
    const previousBase = { cssWidth: 480, cssHeight: 400 };
    draftStore.saveMaterialInk("att-1", "m1|1", previousDoc);
    draftStore.saveMaterialInkBase("att-1", "m1|1", previousBase);
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay
            attemptId="att-1"
            materialId="m1"
            inkKey="m1|2"
          >
            <div>第二版材料</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );

    expect(frameOf(container).style.width).toBe("");
    expect(overlayRootOf(container)).toHaveAttribute("data-stroke-count", "0");
    fireEvent.click(screen.getByTestId("toggle-annotation"));
    await waitInkReady(overlayRootOf(container));
    const layer = inputLayerOf(container);
    mockLayerRect(layer);

    await drawStroke(layer, 50);

    expect(draftStore.getMaterialInk("att-1", "m1|1")).toEqual(previousDoc);
    expect(draftStore.getMaterialInkBase("att-1", "m1|1")).toEqual(
      previousBase,
    );
    // 落在版本化键 m1|2，不污染裸 materialId 槽位
    expect(draftStore.getMaterialInk("att-1", "m1|2")).not.toBeNull();
    expect(draftStore.getMaterialInk("att-1", "m1")).toBeNull();
  });

  it("橡皮按引擎 INK_ERASE_RADIUS 命中整笔并即时保存", async () => {
    draftStore.saveMaterialInk(
      "att-1",
      "mat-1",
      inkDocOf([strokeAt(100, 100)]),
    );

    draftStore.saveMaterialInkBase("att-1", "mat-1", {
      cssWidth: 500,
      cssHeight: 400,
    });
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider initialToolbox={{ active: "eraser" }}>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>擦除材料</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );

    fireEvent.click(screen.getByTestId("toggle-annotation"));
    const root = overlayRootOf(container);
    await waitInkReady(root);
    const layer = inputLayerOf(container);
    mockLayerRect(layer);

    await act(async () => {
      // 逻辑坐标 (100,100) 正落在既有笔迹上（半径 14 内含半笔宽）
      fireEvent.pointerDown(layer, {
        pointerId: 1,
        button: 0,
        pointerType: "pen",
        clientX: 50,
        clientY: 50,
        pressure: 0.5,
      });
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
    });

    const stored = draftStore.getMaterialInk("att-1", "mat-1");
    if (stored?.engine === "atrament") {
      expect(stored.data.strokes).toHaveLength(0);
    }
    expect(root).toHaveAttribute("data-stroke-count", "0");
  });

  it.each([
    { size: "small", left: 1 },
    { size: "medium", left: 0 },
  ] as const)(
    "橡皮大小跟随协同工具箱：离笔迹 12 逻辑单位处，$size 号擦后剩 $left 笔",
    async ({ size, left }) => {
      // 横线 y=100（笔宽 2.5，半宽 1.25）；小号 8+1.25 够不着，中号 14+1.25 够得着
      draftStore.saveMaterialInk(
        "att-1",
        "mat-1",
        inkDocOf([strokeAt(100, 100)]),
      );
      draftStore.saveMaterialInkBase("att-1", "mat-1", {
        cssWidth: 500,
        cssHeight: 400,
      });
      const { container } = render(
        <AttemptEditorProvider>
          <CoordinatedAnnotationProvider
            initialToolbox={{ active: "eraser", eraser: { size } }}
          >
            <AnnotationToggle questionId="q1" />
            <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
              <div>擦除材料</div>
            </MaterialAnnotationOverlay>
          </CoordinatedAnnotationProvider>
        </AttemptEditorProvider>,
      );
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      const root = overlayRootOf(container);
      await waitInkReady(root);
      const layer = inputLayerOf(container);
      mockLayerRect(layer);
      await act(async () => {
        // 画布宽 500 → 1 CSS px = 2 逻辑单位；(55,56) = 逻辑 (110,112)
        fireEvent.pointerDown(layer, {
          pointerId: 1,
          button: 0,
          pointerType: "pen",
          clientX: 55,
          clientY: 56,
          pressure: 0.5,
        });
        fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
      });
      expect(root).toHaveAttribute("data-stroke-count", String(left));
    },
  );

  it("局部橡皮：只擦掉碰到的一段，两头各留一笔并即时保存；拖动时相邻落点之间按线段扫过", async () => {
    // 横线 x 100→300、y=100（笔宽 2.5，半宽 1.25），另有一笔在远处
    const line: InkStroke = {
      tool: "pen",
      color: "#dc2626",
      weight: 2.5,
      points: [
        { x: 100, y: 100, p: 0.5, t: 1 },
        { x: 300, y: 100, p: 0.5, t: 21 },
      ],
    };
    draftStore.saveMaterialInk(
      "att-1",
      "mat-1",
      inkDocOf([line, strokeAt(100, 300)]),
    );
    draftStore.saveMaterialInkBase("att-1", "mat-1", {
      cssWidth: 500,
      cssHeight: 400,
    });
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider
          initialToolbox={{
            active: "eraser",
            eraser: { mode: "partial", size: "small" },
          }}
        >
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>擦除材料</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );
    fireEvent.click(screen.getByTestId("toggle-annotation"));
    const root = overlayRootOf(container);
    await waitInkReady(root);
    const layer = inputLayerOf(container);
    mockLayerRect(layer);
    const storedXs = () => {
      const stored = draftStore.getMaterialInk("att-1", "mat-1");
      return stored?.engine === "atrament"
        ? stored.data.strokes.map((stroke) => stroke.points.map((p) => p.x))
        : null;
    };

    await act(async () => {
      // (100,50) = 逻辑 (200,100)：小号半径 8 + 半笔宽 1.25 → 切掉 190.75–209.25
      fireEvent.pointerDown(layer, {
        pointerId: 1,
        button: 0,
        pointerType: "pen",
        clientX: 100,
        clientY: 50,
        pressure: 0.5,
      });
    });
    expect(storedXs()).toEqual([
      [100, 190.75],
      [209.25, 300],
      [100, 120],
    ]);

    await act(async () => {
      // 拖到 (110,50) = 逻辑 (220,100)：从上一个落点扫过来，切口右沿推到 229.25
      fireEvent.pointerMove(layer, {
        pointerId: 1,
        pointerType: "pen",
        clientX: 110,
        clientY: 50,
        pressure: 0.5,
      });
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
    });
    expect(storedXs()).toEqual([
      [100, 190.75],
      [229.25, 300],
      [100, 120],
    ]);
    expect(root).toHaveAttribute("data-stroke-count", "3");
  });

  it("笔色、粗细跟随协同工具箱：落笔写入对应的颜色与线宽", async () => {
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider
          initialToolbox={{ pen: { color: "green", size: "heavy" } }}
        >
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>换色材料</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );
    fireEvent.click(screen.getByTestId("toggle-annotation"));
    const root = overlayRootOf(container);
    await waitInkReady(root);
    const layer = inputLayerOf(container);
    mockLayerRect(layer);
    await drawStroke(layer, 50);
    const stored = draftStore.getMaterialInk("att-1", "mat-1");
    expect(stored?.engine).toBe("atrament");
    if (stored?.engine !== "atrament") return;
    expect(stored.data.strokes).toHaveLength(1);
    expect(stored.data.strokes[0]).toMatchObject({
      tool: "pen",
      color: "#15803d",
      weight: 9,
    });
  });
});

describe("材料圈画：图形与直线荧光笔", () => {
  beforeEach(() => {
    installDraftBackend(memoryBackend());
    drawFrameMock.mockClear();
    previewMock.showOutline.mockClear();
    previewMock.clear.mockClear();
  });

  /** 挂一份圈画态的材料，输入层 500×400（1 CSS px = 2 逻辑单位） */
  async function mountWith(
    initialToolbox: NonNullable<
      Parameters<typeof CoordinatedAnnotationProvider>[0]["initialToolbox"]
    >,
  ) {
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider initialToolbox={initialToolbox}>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>画图形的材料</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );
    fireEvent.click(screen.getByTestId("toggle-annotation"));
    const root = overlayRootOf(container);
    await waitInkReady(root);
    const layer = inputLayerOf(container);
    mockLayerRect(layer);
    return { root, layer };
  }
  const pen = (clientX: number, clientY: number) => ({
    pointerId: 1,
    button: 0,
    pointerType: "pen",
    clientX,
    clientY,
    pressure: 0.5,
  });
  const storedStrokes = () => {
    const stored = draftStore.getMaterialInk("att-1", "mat-1");
    return stored?.engine === "atrament" ? stored.data.strokes : [];
  };

  it("拖动中只出预览、不存稿；抬笔落成一笔普通的笔（点都在图形上）并保存、冻结基准", async () => {
    const { root, layer } = await mountWith({
      active: "shape",
      shape: { kind: "rect" },
    });
    await act(async () => {
      fireEvent.pointerDown(layer, pen(50, 50));
      fireEvent.pointerMove(layer, pen(250, 150));
    });
    await flushFrame();
    // (50,50) → (250,150) 即逻辑 (100,100) → (500,300)；圈画缺省红色细笔
    expect(previewMock.showOutline).toHaveBeenLastCalledWith(
      [
        { x: 100, y: 100 },
        { x: 500, y: 100 },
        { x: 500, y: 300 },
        { x: 100, y: 300 },
        { x: 100, y: 100 },
      ],
      { color: "#dc2626", weight: 2.5 },
    );
    expect(storedStrokes()).toHaveLength(0);
    expect(root).toHaveAttribute("data-stroke-count", "0");
    // 画布上没有在途的一笔
    for (const [drawn] of drawFrameMock.mock.calls) {
      expect(drawn).toEqual([]);
    }

    previewMock.clear.mockClear();
    await act(async () => {
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
    });
    await flushFrame();
    expect(previewMock.clear).toHaveBeenCalled();
    const strokes = storedStrokes();
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject({
      tool: "pen",
      color: "#dc2626",
      weight: 2.5,
    });
    expect(strokes[0]?.rendering).toBeUndefined();
    const points = strokes[0]?.points ?? [];
    expect(points.length).toBeGreaterThan(300);
    expect(points[0]).toMatchObject({ x: 100, y: 100, p: 0.51, t: 0 });
    expect(points.at(-1)).toMatchObject({ x: 100, y: 100 });
    for (const p of points) {
      expect(p.x === 100 || p.x === 500 || p.y === 100 || p.y === 300).toBe(
        true,
      );
    }
    expect(root).toHaveAttribute("data-stroke-count", "1");
    expect(drawFrameMock.mock.lastCall?.[0]).toEqual(strokes);
    // 这是首笔：按落笔时的矩形冻结
    expect(draftStore.getMaterialInkBase("att-1", "mat-1")).toEqual({
      cssWidth: 500,
      cssHeight: 400,
    });
  });

  it("只点一下或拖得太短：不落笔、不存稿、不冻结基准", async () => {
    const { root, layer } = await mountWith({ active: "shape" });
    await act(async () => {
      fireEvent.pointerDown(layer, pen(50, 50));
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
      fireEvent.pointerDown(layer, pen(50, 50));
      fireEvent.pointerMove(layer, pen(52, 50));
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
    });
    await flushFrame();
    expect(storedStrokes()).toHaveLength(0);
    expect(draftStore.getMaterialInkBase("att-1", "mat-1")).toBeNull();
    expect(root).toHaveAttribute("data-stroke-count", "0");
    expect(previewMock.showOutline).not.toHaveBeenCalled();
  });

  it("拖出材料范围：只画到边上，点不出界", async () => {
    const { layer } = await mountWith({
      active: "shape",
      shape: { kind: "line" },
    });
    await act(async () => {
      fireEvent.pointerDown(layer, pen(400, 300));
      fireEvent.pointerMove(layer, pen(700, 600));
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
    });
    // 500×400 的输入层 → 逻辑 1000×800
    expect(storedStrokes()[0]?.points.at(-1)).toMatchObject({
      x: 1000,
      y: 800,
    });
  });

  it("手掌先落、笔后落：手掌拖出的图形丢弃，预览收起，不存稿", async () => {
    const { layer } = await mountWith({
      active: "shape",
      shape: { kind: "rect" },
    });
    await act(async () => {
      fireEvent.pointerDown(layer, { ...pen(50, 50), pointerType: "touch" });
    });
    // 材料圈画固定笔写：手指不落墨，由笔来画
    expect(previewMock.showOutline).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.pointerDown(layer, { ...pen(50, 50), pointerId: 2 });
      fireEvent.pointerMove(layer, { ...pen(250, 150), pointerId: 2 });
    });
    expect(previewMock.showOutline).toHaveBeenCalled();
    previewMock.clear.mockClear();
    await act(async () => {
      // 第二支指针到达：在途图形按拖到的位置落笔
      fireEvent.pointerDown(layer, { ...pen(300, 300), pointerId: 3 });
    });
    expect(previewMock.clear).toHaveBeenCalled();
    expect(storedStrokes()).toHaveLength(1);
  });

  it("直线荧光笔：预览是一条直线，落成只有起止两点的荧光笔笔画", async () => {
    const { layer } = await mountWith({
      active: "highlighter",
      highlighter: { straight: true },
    });
    await act(async () => {
      fireEvent.pointerDown(layer, pen(50, 50));
      // 接近水平：吸附
      fireEvent.pointerMove(layer, pen(250, 53));
    });
    expect(previewMock.showOutline).toHaveBeenLastCalledWith(
      [
        { x: 100, y: 100 },
        { x: 500, y: 100 },
      ],
      { color: INK_HIGHLIGHTER_COLORS.yellow, weight: 16 },
    );
    await act(async () => {
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
    });
    const strokes = storedStrokes();
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject({
      tool: "highlighter",
      color: INK_HIGHLIGHTER_COLORS.yellow,
      weight: 16,
    });
    expect(strokes[0]?.points.map(({ x, y, p }) => ({ x, y, p }))).toEqual([
      { x: 100, y: 100, p: 0.51 },
      { x: 500, y: 100, p: 0.51 },
    ]);
  });
});

describe("材料圈画：橡皮圈", () => {
  beforeEach(() => {
    installDraftBackend(memoryBackend());
    previewMock.showRing.mockClear();
    previewMock.hideRing.mockClear();
  });

  /** 挂一份圈画态的材料，输入层 500×400（1 CSS px = 2 逻辑单位） */
  async function mountWith(
    initialToolbox: NonNullable<
      Parameters<typeof CoordinatedAnnotationProvider>[0]["initialToolbox"]
    >,
  ) {
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider initialToolbox={initialToolbox}>
          <AnnotationToggle questionId="q1" />
          <AnnotationRelease />
          <PenToolToggle />
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>要擦的材料</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );
    fireEvent.click(screen.getByTestId("toggle-annotation"));
    await waitInkReady(overlayRootOf(container));
    const layer = inputLayerOf(container);
    mockLayerRect(layer);
    return layer;
  }
  const hover = (pointerType: string, clientX: number, clientY: number) => ({
    pointerId: 1,
    pointerType,
    buttons: 0,
    clientX,
    clientY,
  });

  it("橡皮悬停时橡皮圈跟着走（笔和鼠标），半径就是橡皮的命中半径；手指不显示", async () => {
    const layer = await mountWith({
      active: "eraser",
      eraser: { size: "large" },
    });
    fireEvent.pointerMove(layer, hover("touch", 50, 50));
    expect(previewMock.showRing).not.toHaveBeenCalled();
    // (50,50) 即逻辑 (100,100)；大号橡皮半径 24
    fireEvent.pointerMove(layer, hover("pen", 50, 50));
    expect(previewMock.showRing).toHaveBeenLastCalledWith(100, 100, 24);
    fireEvent.pointerMove(layer, hover("mouse", 60, 80));
    expect(previewMock.showRing).toHaveBeenLastCalledWith(120, 160, 24);
    // 悬停不擦东西、不存稿
    expect(draftStore.getMaterialInk("att-1", "mat-1")).toBeNull();
  });

  it("页面滚动后悬停：按当时的位置算，不用上一次量的矩形", async () => {
    const layer = await mountWith({ active: "eraser" });
    fireEvent.pointerMove(layer, hover("pen", 50, 50));
    expect(previewMock.showRing).toHaveBeenLastCalledWith(100, 100, 14);
    // 输入层整体上移 20 px（页面往下滚了）
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: -20,
      right: 500,
      bottom: 380,
      width: 500,
      height: 400,
      x: 0,
      y: -20,
      toJSON: () => {},
    });
    fireEvent.pointerMove(layer, hover("pen", 50, 50));
    expect(previewMock.showRing).toHaveBeenLastCalledWith(100, 140, 14);
  });

  it("笔、形状等别的工具悬停不显示橡皮圈", async () => {
    const layer = await mountWith({ active: "pen" });
    fireEvent.pointerMove(layer, hover("pen", 50, 50));
    expect(previewMock.showRing).not.toHaveBeenCalled();
  });

  it("按着擦的时候橡皮圈跟到每个落点，抬起收起", async () => {
    const layer = await mountWith({ active: "eraser" });
    const pen = (clientX: number, clientY: number) => ({
      pointerId: 1,
      button: 0,
      buttons: 1,
      pointerType: "pen",
      clientX,
      clientY,
      pressure: 0.5,
    });
    await act(async () => {
      fireEvent.pointerDown(layer, pen(50, 50));
    });
    expect(previewMock.showRing).toHaveBeenLastCalledWith(100, 100, 14);
    await act(async () => {
      fireEvent.pointerMove(layer, pen(80, 60));
    });
    expect(previewMock.showRing).toHaveBeenLastCalledWith(160, 120, 14);
    expect(previewMock.hideRing).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
    });
    expect(previewMock.hideRing).toHaveBeenCalled();
  });

  it("指针移出材料、切到别的工具、退出圈画：橡皮圈都收起", async () => {
    const layer = await mountWith({ active: "eraser" });
    fireEvent.pointerMove(layer, hover("pen", 50, 50));
    expect(previewMock.hideRing).not.toHaveBeenCalled();
    fireEvent.pointerLeave(layer, hover("pen", 600, 50));
    expect(previewMock.hideRing).toHaveBeenCalledTimes(1);

    fireEvent.pointerMove(layer, hover("pen", 50, 50));
    fireEvent.click(screen.getByTestId("toggle-pen"));
    expect(previewMock.hideRing).toHaveBeenCalledTimes(2);
    // 已经是笔：再悬停不出圈
    previewMock.showRing.mockClear();
    fireEvent.pointerMove(layer, hover("pen", 50, 50));
    expect(previewMock.showRing).not.toHaveBeenCalled();
  });

  it("退出圈画时收起橡皮圈", async () => {
    const layer = await mountWith({ active: "eraser" });
    fireEvent.pointerMove(layer, hover("pen", 50, 50));
    previewMock.hideRing.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId("release-annotation"));
    });
    expect(previewMock.hideRing).toHaveBeenCalled();
  });
});

describe("材料圈画固定阅读框（已有基准常显）", () => {
  beforeEach(() => {
    installDraftBackend(memoryBackend());
    drawFrameMock.mockClear();
  });

  it("已有基准在阅读态保持同一固定框与墨层，窄列只缩放且不拦阅读交互", async () => {
    const observer = manualResizeObserver();
    try {
      const doc = inkDocOf([strokeAt(1, 1)]);
      const base = { cssWidth: 480, cssHeight: 400 };
      draftStore.saveMaterialInk("att-f1", "m1|1", doc);
      draftStore.saveMaterialInkBase("att-f1", "m1|1", base);
      const clicked = vi.fn();
      const { container } = render(
        <AttemptEditorProvider>
          <MaterialAnnotationOverlay
            attemptId="att-f1"
            materialId="m1"
            inkKey="m1|1"
          >
            <button type="button" onClick={clicked}>
              阅读链接
            </button>
          </MaterialAnnotationOverlay>
        </AttemptEditorProvider>,
      );
      const root = overlayRootOf(container);
      const frame = frameOf(container);
      const layer = inputLayerOf(container);
      const child = screen.getByRole("button", { name: "阅读链接" });
      expect(frame.style.width).toBe("480px");
      expect(root).toHaveAttribute("data-ink-visible", "true");
      act(() => observer.fire(root, 240, 200));
      expect(frame.style.transform).toBe("scale(0.5)");
      act(() => observer.fire(root, 640, 400));
      expect(frame.style.width).toBe("480px");
      expect(frame.style.transform).toBe("");
      expect(frameOf(container)).toBe(frame);
      expect(inputLayerOf(container)).toBe(layer);
      expect(screen.getByRole("button", { name: "阅读链接" })).toBe(child);
      expect(layer).toHaveStyle({ pointerEvents: "none" });
      fireEvent.click(child);
      expect(clicked).toHaveBeenCalledOnce();
      await flushFrame();
      expect(drawFrameMock.mock.calls.at(-1)?.[0]).toEqual(doc.data.strokes);
      expect(draftStore.getMaterialInkBase("att-f1", "m1|1")).toEqual(base);
      expect(draftStore.getMaterialInk("att-f1", "m1|1")).toEqual(doc);
      expect(screen.queryByRole("button", { name: /排版查看/ })).toBeNull();
    } finally {
      observer.restore();
    }
  });

  it.each([
    [510, 410, true],
    [490, 390, true],
    [502, 402, true],
    [510.001, 400, false],
    [500, 410.001, false],
    [489.999, 400, false],
    [500, 389.999, false],
  ])(
    "材料基准宽高容差 %s×%s：10px 含边界，超出停写保稿",
    async (width, height, allowed) => {
      const observer = manualResizeObserver();
      try {
        const doc = inkDocOf([strokeAt(1, 1)]);
        const base = { cssWidth: 500, cssHeight: 400 };
        draftStore.saveMaterialInk("att-f2", "m1|1", doc);
        draftStore.saveMaterialInkBase("att-f2", "m1|1", base);
        const { container } = render(
          <AttemptEditorProvider>
            <AnnotationToggle questionId="q1" />
            <MaterialAnnotationOverlay
              attemptId="att-f2"
              materialId="m1"
              inkKey="m1|1"
            >
              <div>容差材料</div>
            </MaterialAnnotationOverlay>
          </AttemptEditorProvider>,
        );
        fireEvent.click(screen.getByTestId("toggle-annotation"));
        await waitInkReady(overlayRootOf(container));
        act(() => observer.fire(frameOf(container), width, height));
        expect(inputLayerOf(container)).toHaveStyle({
          pointerEvents: allowed ? "auto" : "none",
        });
        expect(overlayRootOf(container)).toHaveAttribute(
          "data-ink-visible",
          "true",
        );
        if (allowed) expect(screen.queryByRole("note")).toBeNull();
        else expect(screen.getByRole("note")).toHaveTextContent("暂停圈画");
        expect(draftStore.getMaterialInkBase("att-f2", "m1|1")).toEqual(base);
        expect(draftStore.getMaterialInk("att-f2", "m1|1")).toEqual(doc);
      } finally {
        observer.restore();
      }
    },
  );

  it("圈画态且有冻结基准：立即挂冻结框显示旧笔迹，拖窄只等比缩放不回流", async () => {
    const observer = manualResizeObserver();
    try {
      draftStore.saveMaterialInk("att-f4", "m1|1", inkDocOf([strokeAt(1, 1)]));
      draftStore.saveMaterialInkBase("att-f4", "m1|1", {
        cssWidth: 480,
        cssHeight: 400,
      });

      const { container } = render(
        <AttemptEditorProvider>
          <CoordinatedAnnotationProvider>
            <AnnotationToggle questionId="q1" />
            <MaterialAnnotationOverlay
              attemptId="att-f4"
              materialId="m1"
              inkKey="m1|1"
            >
              <div>圈画材料</div>
            </MaterialAnnotationOverlay>
          </CoordinatedAnnotationProvider>
        </AttemptEditorProvider>,
      );
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      const root = overlayRootOf(container);
      await waitFor(() => {
        expect(frameOf(container).style.width).toBe("480px");
      });
      await waitInkReady(root);
      expect(inputLayerOf(container)).toHaveStyle({ pointerEvents: "auto" });

      // 拖窄中缝：根宽 240 → 冻结框仍 480px、整体 scale(0.5)、占位宽 240
      // ——材料文本不回流，笔迹与正文恒对齐（题面底图冻结同款工作台形态）
      act(() => observer.fire(root, 240, 300));
      const frame = frameOf(container);
      const sizer = container.querySelector<HTMLElement>(
        '[data-slot="material-ink-frame-sizer"]',
      );
      expect(frame.style.width).toBe("480px");
      expect(frame.style.transform).toBe("scale(0.5)");
      expect(sizer?.style.width).toBe("240px");
    } finally {
      observer.restore();
    }
  });

  it.each([
    { mountedWidth: null, expectedWidth: 520 },
    { mountedWidth: 480, expectedWidth: 480 },
  ])(
    "进入圈画才读取晚到的基准，已挂载的宽度 $mountedWidth 保持优先",
    async ({ mountedWidth, expectedWidth }) => {
      const attemptId = `att-late-base-${mountedWidth}`;
      const inkKey = "m1|1";
      const doc = inkDocOf([strokeAt(1, 1)]);
      draftStore.saveMaterialInk(attemptId, inkKey, doc);
      if (mountedWidth !== null) {
        draftStore.saveMaterialInkBase(attemptId, inkKey, {
          cssWidth: mountedWidth,
          cssHeight: 400,
        });
      }
      const { container } = render(
        <AttemptEditorProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay
            attemptId={attemptId}
            materialId="m1"
            inkKey={inkKey}
          >
            <div>晚到基准材料</div>
          </MaterialAnnotationOverlay>
        </AttemptEditorProvider>,
      );

      draftStore.saveMaterialInkBase(attemptId, inkKey, {
        cssWidth: 520,
        cssHeight: 400,
      });
      fireEvent.click(screen.getByTestId("toggle-annotation"));

      expect(frameOf(container).style.width).toBe(`${expectedWidth}px`);
      expect(overlayRootOf(container)).toHaveAttribute(
        "data-ink-visible",
        "true",
      );
      await flushFrame();
      expect(drawFrameMock.mock.calls.at(-1)?.[0]).toEqual(doc.data.strokes);
      expect(draftStore.getMaterialInk(attemptId, inkKey)).toEqual(doc);
    },
  );

  it("无基准新材料在圈画态保持自然排版：首笔前不冻结", async () => {
    const observer = manualResizeObserver();
    try {
      const { container } = render(
        <AttemptEditorProvider>
          <CoordinatedAnnotationProvider>
            <AnnotationToggle questionId="q1" />
            <MaterialAnnotationOverlay
              attemptId="att-f5"
              materialId="m1"
              inkKey="m1|1"
            >
              <div>干净材料</div>
            </MaterialAnnotationOverlay>
          </CoordinatedAnnotationProvider>
        </AttemptEditorProvider>,
      );
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      const root = overlayRootOf(container);
      await waitFor(() => expect(root).toHaveAttribute("data-drawing", "true"));
      await waitInkReady(root);
      act(() => observer.fire(liveSurfaceOf(container), 480, 400));
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      expect(frameOf(container).style.width).toBe("");
      expect(draftStore.getMaterialInkBase("att-f5", "m1|1")).toBeNull();
    } finally {
      observer.restore();
    }
  });

  it("首笔收笔时按落笔矩形冻结并随稿存基准；此后拖窄锁定冻结宽", async () => {
    const observer = manualResizeObserver();
    try {
      const { container } = render(
        <AttemptEditorProvider>
          <CoordinatedAnnotationProvider>
            <AnnotationToggle questionId="q1" />
            <MaterialAnnotationOverlay
              attemptId="att-f6"
              materialId="m1"
              inkKey="m1|1"
            >
              <div>首笔材料</div>
            </MaterialAnnotationOverlay>
          </CoordinatedAnnotationProvider>
        </AttemptEditorProvider>,
      );
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      const root = overlayRootOf(container);
      await waitFor(() => expect(root).toHaveAttribute("data-drawing", "true"));
      await waitInkReady(root);
      act(() => observer.fire(root, 480, 400));

      const layer = inputLayerOf(container);
      mockLayerRect(layer, 480, 400);
      await drawStroke(layer, 48);

      // 冻结基准 = 落笔时的活排版矩形（480×400），随稿保存
      expect(draftStore.getMaterialInkBase("att-f6", "m1|1")).toEqual({
        cssWidth: 480,
        cssHeight: 400,
      });
      await waitFor(() => {
        expect(frameOf(container).style.width).toBe("480px");
      });

      // 拖窄后冻结宽锁定不回流
      act(() => observer.fire(root, 240, 300));
      expect(frameOf(container).style.width).toBe("480px");
      expect(frameOf(container).style.transform).toBe("scale(0.5)");
    } finally {
      observer.restore();
    }
  });

  it("首笔前资源未就绪时禁墨并提示；图片加载完成后放行", async () => {
    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay
            attemptId="att-f7"
            materialId="m1"
            inkKey="m1|1"
          >
            <div>
              图片材料
              <img src="pending.png" alt="待加载图" data-testid="mat-img" />
            </div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );
    fireEvent.click(screen.getByTestId("toggle-annotation"));
    const root = overlayRootOf(container);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("正在准备圈画"),
    );

    const layer = inputLayerOf(container);
    mockLayerRect(layer);
    await drawStroke(layer, 50);
    expect(draftStore.getMaterialInk("att-f7", "m1|1")).toBeNull();

    fireEvent.load(screen.getByTestId("mat-img"));
    await waitInkReady(root);
    await drawStroke(inputLayerOf(container), 50);
    expect(draftStore.getMaterialInk("att-f7", "m1|1")).not.toBeNull();
  });

  it("拖窄中缝先收笔；继续落笔仍用同一冻结宽基准（视觉坐标换算一致）", async () => {
    const observer = manualResizeObserver();
    try {
      const { container } = render(
        <AttemptEditorProvider>
          <CoordinatedAnnotationProvider>
            <AnnotationToggle questionId="q1" />
            <MaterialAnnotationOverlay
              attemptId="att-f8"
              materialId="m1"
              inkKey="m1|1"
            >
              <div>对齐材料</div>
            </MaterialAnnotationOverlay>
          </CoordinatedAnnotationProvider>
        </AttemptEditorProvider>,
      );
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      const root = overlayRootOf(container);
      await waitFor(() => expect(root).toHaveAttribute("data-drawing", "true"));
      await waitInkReady(root);
      act(() => observer.fire(root, 480, 400));

      let layer = inputLayerOf(container);
      mockLayerRect(layer, 480, 400);
      await act(async () => {
        fireEvent.pointerDown(layer, {
          pointerId: 1,
          button: 0,
          pointerType: "pen",
          clientX: 48,
          clientY: 50,
          pressure: 0.5,
        });
        fireEvent.pointerMove(layer, {
          pointerId: 1,
          pointerType: "pen",
          clientX: 96,
          clientY: 60,
          pressure: 0.5,
        });
        // 拖窄中缝 → layoutchange 收笔（已收采样 = down + move）
        observer.fire(root, 240, 300);
      });

      const stored = draftStore.getMaterialInk("att-f8", "m1|1");
      if (stored?.engine !== "atrament") throw new Error("收笔应已落稿");
      expect(stored.data.strokes).toHaveLength(1);
      const first = stored.data.strokes[0];
      expect(first?.points).toHaveLength(2);
      // 48/480 与 96/480 的逻辑位置
      expect(first?.points[0]?.x).toBe(100);
      expect(first?.points[1]?.x).toBe(200);
      // 冻结基准随稿保存（落笔矩形 480×400）
      expect(draftStore.getMaterialInkBase("att-f8", "m1|1")).toEqual({
        cssWidth: 480,
        cssHeight: 400,
      });

      // 冻结框已挂（480 逻辑宽、当前容器 240 → scale 0.5）：
      // 缩放后继续画，视觉 24px（240 宽的一半）= 逻辑 100（与首笔同位置）
      layer = inputLayerOf(container);
      mockLayerRect(layer, 240, 300);
      await waitInkReady(root);
      await drawStroke(layer, 24);
      const second = draftStore.getMaterialInk("att-f8", "m1|1");
      if (second?.engine !== "atrament") throw new Error("第二笔应已落稿");
      const secondStroke = second.data.strokes[1];
      expect(secondStroke?.points[0]?.x).toBe(100);
    } finally {
      observer.restore();
    }
  });

  it("笔迹全部擦除后清除冻结基准：活排版回归，下次首笔按当前宽重冻", async () => {
    const observer = manualResizeObserver();
    try {
      draftStore.saveMaterialInk("att-f9", "m1|1", inkDocOf([strokeAt(1, 1)]));
      draftStore.saveMaterialInkBase("att-f9", "m1|1", {
        cssWidth: 480,
        cssHeight: 400,
      });

      const { container } = render(
        <AttemptEditorProvider>
          <CoordinatedAnnotationProvider initialToolbox={{ active: "eraser" }}>
            <AnnotationToggle questionId="q1" />
            <PenToolToggle />
            <MaterialAnnotationOverlay
              attemptId="att-f9"
              materialId="m1"
              inkKey="m1|1"
            >
              <div>擦除冻结</div>
            </MaterialAnnotationOverlay>
          </CoordinatedAnnotationProvider>
        </AttemptEditorProvider>,
      );
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      const root = overlayRootOf(container);
      await waitFor(() => {
        expect(frameOf(container).style.width).toBe("480px");
      });
      await waitInkReady(root);

      const layer = inputLayerOf(container);
      mockLayerRect(layer, 480, 400);
      await act(async () => {
        // 逻辑坐标 (1,1) 落在既有笔迹上 → 整笔擦除
        fireEvent.pointerDown(layer, {
          pointerId: 1,
          button: 0,
          pointerType: "pen",
          clientX: 1,
          clientY: 1,
          pressure: 0.5,
        });
        fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
      });

      expect(draftStore.getMaterialInk("att-f9", "m1|1")?.engine).toBe(
        "atrament",
      );
      // 空稿 → 冻结基准一并清除，冻结框卸载（空稿无对齐负担）
      expect(draftStore.getMaterialInkBase("att-f9", "m1|1")).toBeNull();
      await waitFor(() => {
        expect(frameOf(container).style.width).toBe("");
      });

      // 容器变宽后重画 → 按新列宽 600 重新冻结（就绪门控重新放行）
      act(() => observer.fire(root, 600, 400));
      await waitInkReady(root);
      fireEvent.click(screen.getByTestId("toggle-pen"));
      const freshLayer = inputLayerOf(container);
      mockLayerRect(freshLayer, 600, 400);
      await drawStroke(freshLayer, 60);
      expect(draftStore.getMaterialInkBase("att-f9", "m1|1")).toEqual({
        cssWidth: 600,
        cssHeight: 400,
      });
    } finally {
      observer.restore();
    }
  });

  it("圈画态 fitScale<0.85 时提供「放大材料」1:1 横滚逃生（同题面放大题面）", async () => {
    const observer = manualResizeObserver();
    try {
      draftStore.saveMaterialInk("att-f10", "m1|1", inkDocOf([strokeAt(1, 1)]));
      draftStore.saveMaterialInkBase("att-f10", "m1|1", {
        cssWidth: 480,
        cssHeight: 400,
      });

      const { container } = render(
        <AttemptEditorProvider>
          <CoordinatedAnnotationProvider>
            <AnnotationToggle questionId="q1" />
            <MaterialAnnotationOverlay
              attemptId="att-f10"
              materialId="m1"
              inkKey="m1|1"
            >
              <div>放大材料</div>
            </MaterialAnnotationOverlay>
          </CoordinatedAnnotationProvider>
        </AttemptEditorProvider>,
      );
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      const root = overlayRootOf(container);
      await waitFor(() => {
        expect(frameOf(container).style.width).toBe("480px");
      });
      await waitInkReady(root);
      // 容器 240 → fitScale 0.5 < 0.85：出现放大入口
      act(() => observer.fire(root, 240, 300));
      const expand = await screen.findByRole("button", { name: "放大材料" });
      fireEvent.click(expand);
      const frame = frameOf(container);
      expect(frame.style.transform).toBe("");
      expect(root.className).toContain("overflow-x-auto");
      // 再点恢复等比适配
      fireEvent.click(screen.getByRole("button", { name: "适应宽度" }));
      expect(frameOf(container).style.transform).toBe("scale(0.5)");
    } finally {
      observer.restore();
    }
  });

  it("阅读态放大按钮位于材料测量壳外，适应宽度不重挂输入层", async () => {
    const observer = manualResizeObserver();
    try {
      draftStore.saveMaterialInk("att-g1", "m1|1", inkDocOf([strokeAt(1, 1)]));
      draftStore.saveMaterialInkBase("att-g1", "m1|1", {
        cssWidth: 480,
        cssHeight: 400,
      });
      const { container } = render(
        <MaterialAnnotationOverlay
          attemptId="att-g1"
          materialId="m1"
          inkKey="m1|1"
        >
          <div>壳外材料</div>
        </MaterialAnnotationOverlay>,
      );
      const layer = inputLayerOf(container);
      act(() => observer.fire(overlayRootOf(container), 240, 200));
      const button = screen.getByRole("button", { name: "放大材料" });
      expect(button.closest('[data-slot="material-live-surface"]')).toBeNull();
      fireEvent.click(button);
      expect(frameOf(container).style.transform).toBe("");
      fireEvent.click(screen.getByRole("button", { name: "适应宽度" }));
      expect(frameOf(container).style.transform).toBe("scale(0.5)");
      expect(inputLayerOf(container)).toBe(layer);
      expect(layer).toHaveStyle({ pointerEvents: "none" });
    } finally {
      observer.restore();
    }
  });

  it("进出圈画态材料子树不重挂：children 元素身份保持（结构常驻）", async () => {
    const observer = manualResizeObserver();
    const seen: (Element | null)[] = [];
    function MountProbe() {
      return (
        <div
          data-testid="mount-probe"
          ref={(el) => {
            if (el !== null) seen.push(el);
          }}
        >
          被守护正文
        </div>
      );
    }
    try {
      draftStore.saveMaterialInk("att-g3", "m1|1", inkDocOf([strokeAt(1, 1)]));
      draftStore.saveMaterialInkBase("att-g3", "m1|1", {
        cssWidth: 320,
        cssHeight: 400,
      });

      const { container } = render(
        <AttemptEditorProvider>
          <CoordinatedAnnotationProvider>
            <AnnotationToggle questionId="q1" />
            <AnnotationRelease />
            <MaterialAnnotationOverlay
              attemptId="att-g3"
              materialId="m1"
              inkKey="m1|1"
            >
              <MountProbe />
            </MaterialAnnotationOverlay>
          </CoordinatedAnnotationProvider>
        </AttemptEditorProvider>,
      );
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      await waitFor(() => {
        expect(frameOf(container).style.width).toBe("320px");
      });
      fireEvent.click(screen.getByTestId("release-annotation"));
      await waitFor(() => {
        expect(frameOf(container).style.width).toBe("320px");
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).not.toBeNull();
      expect(new Set(seen).size).toBe(1);
    } finally {
      observer.restore();
    }
  });

  it("晚到图片改变固定框时先收下在途采样，再停写并保留原基准", async () => {
    const observer = manualResizeObserver();
    try {
      const base = { cssWidth: 480, cssHeight: 400 };
      draftStore.saveMaterialInk(
        "att-late",
        "m1|1",
        inkDocOf([strokeAt(1, 1)]),
      );
      draftStore.saveMaterialInkBase("att-late", "m1|1", base);
      const { container } = render(
        <AttemptEditorProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay
            attemptId="att-late"
            materialId="m1"
            inkKey="m1|1"
          >
            <img src="late.png" alt="晚到图片" />
          </MaterialAnnotationOverlay>
        </AttemptEditorProvider>,
      );
      const image = screen.getByAltText("晚到图片");
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      expect(inputLayerOf(container)).toHaveStyle({ pointerEvents: "none" });
      fireEvent.load(image);
      await waitInkReady(overlayRootOf(container));
      const layer = inputLayerOf(container);
      mockLayerRect(layer, 480, 400);
      act(() => observer.fire(frameOf(container), 480, 400));
      fireEvent.pointerDown(layer, {
        pointerId: 1,
        button: 0,
        pointerType: "pen",
        clientX: 48,
        clientY: 48,
      });
      fireEvent.pointerMove(layer, {
        pointerId: 1,
        pointerType: "pen",
        clientX: 96,
        clientY: 48,
      });
      act(() => observer.fire(frameOf(container), 480, 500));
      expect(layer).toHaveStyle({ pointerEvents: "none" });
      expect(screen.getByRole("note")).toHaveTextContent("暂停圈画");
      const stored = draftStore.getMaterialInk("att-late", "m1|1");
      if (stored?.engine !== "atrament") throw new Error("应保留材料稿");
      expect(stored.data.strokes).toHaveLength(2);
      expect(stored.data.strokes[1]?.points).toHaveLength(2);
      fireEvent.pointerMove(layer, {
        pointerId: 1,
        pointerType: "pen",
        clientX: 192,
        clientY: 48,
      });
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
      await drawStroke(layer, 192);
      expect(draftStore.getMaterialInk("att-late", "m1|1")).toEqual(stored);
      expect(draftStore.getMaterialInkBase("att-late", "m1|1")).toEqual(base);
    } finally {
      observer.restore();
    }
  });

  it("无基准旧材料稿说明证据限制，不自动按当前排版收养或写入", async () => {
    const doc = inkDocOf([strokeAt(100, 100)]);
    draftStore.saveMaterialInk("att-legacy", "m1|1", doc);
    const observer = manualResizeObserver();
    try {
      const { container } = render(
        <AttemptEditorProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay
            attemptId="att-legacy"
            materialId="m1"
            inkKey="m1|1"
          >
            <div>旧材料</div>
          </MaterialAnnotationOverlay>
        </AttemptEditorProvider>,
      );
      act(() => observer.fire(liveSurfaceOf(container), 500, 400));
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      await flushFrame();
      expect(screen.getByRole("note")).toHaveTextContent("缺少原排版基准");
      expect(inputLayerOf(container)).toHaveStyle({ pointerEvents: "none" });
      expect(overlayRootOf(container)).toHaveAttribute(
        "data-ink-visible",
        "false",
      );
      expect(draftStore.getMaterialInkBase("att-legacy", "m1|1")).toBeNull();
      expect(draftStore.getMaterialInk("att-legacy", "m1|1")).toEqual(doc);
    } finally {
      observer.restore();
    }
  });

  it("挂框后高度漂移期间禁墨（pointer-events none），漂移恢复即放行", async () => {
    const observer = manualResizeObserver();
    try {
      draftStore.saveMaterialInk("att-g4", "m1|1", inkDocOf([strokeAt(1, 1)]));
      draftStore.saveMaterialInkBase("att-g4", "m1|1", {
        cssWidth: 480,
        cssHeight: 400,
      });

      const { container } = render(
        <AttemptEditorProvider>
          <CoordinatedAnnotationProvider>
            <AnnotationToggle questionId="q1" />
            <MaterialAnnotationOverlay
              attemptId="att-g4"
              materialId="m1"
              inkKey="m1|1"
            >
              <div>漂移材料</div>
            </MaterialAnnotationOverlay>
          </CoordinatedAnnotationProvider>
        </AttemptEditorProvider>,
      );
      fireEvent.click(screen.getByTestId("toggle-annotation"));
      const root = overlayRootOf(container);
      await waitFor(() => {
        expect(frameOf(container).style.width).toBe("480px");
      });
      await waitInkReady(root);
      expect(inputLayerOf(container)).toHaveStyle({ pointerEvents: "auto" });
      // 晚到图片把冻结框内容推高（500 ≠ 基准 400）→ 禁墨并提示
      act(() => observer.fire(frameOf(container), 480, 500));
      expect(inputLayerOf(container)).toHaveStyle({ pointerEvents: "none" });
      expect(root).toHaveAttribute("data-ink-ready", "false");
      expect(screen.getByRole("note")).toHaveTextContent("暂停圈画");
      // 内容回到基准高 → 放行
      act(() => observer.fire(frameOf(container), 480, 400));
      await waitFor(() =>
        expect(inputLayerOf(container)).toHaveStyle({
          pointerEvents: "auto",
        }),
      );
    } finally {
      observer.restore();
    }
  });
});
