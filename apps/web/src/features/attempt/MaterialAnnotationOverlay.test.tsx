import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { InkDoc, InkStroke } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoordinatedAnnotationProvider,
  useCoordinatedAnnotation,
} from "@/features/annotation/coordinated-annotation-context";
import {
  AttemptEditorProvider,
  useAttemptEditor,
} from "./AttemptEditorContext";
import { draftStore, installDraftBackend, memoryBackend } from "./draft-store";
import { MaterialAnnotationOverlay } from "./MaterialAnnotationOverlay";

// 绘制层复用 ink/replay/draw（jsdom 无 2d 上下文）——按仓内惯例 mock 本模块，
// 断言经 drawFrame 传入的笔画数据
const drawFrameMock = vi.fn();
vi.mock("@/features/ink/replay/draw", () => ({
  createAtramentReplayCanvas: () => ({
    drawFrame: drawFrameMock,
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
      onClick={() => coordinated?.setTool("pen")}
    >
      切换画笔
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

function inkDocOf(strokes: InkStroke[]): InkDoc {
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

  it("已存材料笔迹挂载时恢复并重绘（内存命中路径；活排版匹配时叠显）", async () => {
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
      // 活排版与冻结基准匹配（500×400）→ 笔迹直接叠在活正文上
      act(() => observer.fire(root, 500, 400));
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
      await vi.waitFor(() => {
        expect(root).toHaveAttribute("data-stroke-count", "1");
      });
      act(() => observer.fire(root, 500, 400));
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

  it("笔写输入偏好下手指 touch 不落墨（手掌防误触/手指滚动语义）", async () => {
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

    fireEvent.click(screen.getByTestId("toggle-annotation"));
    await waitInkReady(overlayRootOf(container));
    const layer = inputLayerOf(container);
    mockLayerRect(layer);

    await drawStroke(layer, 50);

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

    const { container } = render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider initialTool="eraser">
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
});

describe("材料圈画冻结作用域（默认活排版 + 圈画态冻结框）", () => {
  beforeEach(() => {
    installDraftBackend(memoryBackend());
    drawFrameMock.mockClear();
  });

  it("默认阅读恒活排版：有冻结稿也不挂框，正文随列宽自然回流", () => {
    const observer = manualResizeObserver();
    try {
      draftStore.saveMaterialInk("att-f1", "m1|1", inkDocOf([strokeAt(1, 1)]));
      draftStore.saveMaterialInkBase("att-f1", "m1|1", {
        cssWidth: 320,
        cssHeight: 400,
      });

      const { container } = render(
        <AttemptEditorProvider>
          <MaterialAnnotationOverlay
            attemptId="att-f1"
            materialId="m1"
            inkKey="m1|1"
          >
            <div>恢复材料</div>
          </MaterialAnnotationOverlay>
        </AttemptEditorProvider>,
      );
      const root = overlayRootOf(container);
      // 容器 640（如切回列表形式/拖宽中缝）：正文直接以 640 宽回流，无冻结框
      act(() => observer.fire(root, 640, 800));
      expect(
        container.querySelector('[data-slot="material-ink-frame"]'),
      ).toBeNull();
      expect(screen.getByText("恢复材料")).toBeInTheDocument();
    } finally {
      observer.restore();
    }
  });

  it("活排版与冻结基准匹配（±1px）时笔迹直接叠在活正文上，不加 transform", async () => {
    const observer = manualResizeObserver();
    try {
      draftStore.saveMaterialInk("att-f2", "m1|1", inkDocOf([strokeAt(1, 1)]));
      draftStore.saveMaterialInkBase("att-f2", "m1|1", {
        cssWidth: 500,
        cssHeight: 400,
      });

      const { container } = render(
        <AttemptEditorProvider>
          <MaterialAnnotationOverlay
            attemptId="att-f2"
            materialId="m1"
            inkKey="m1|1"
          >
            <div>匹配材料</div>
          </MaterialAnnotationOverlay>
        </AttemptEditorProvider>,
      );
      const root = overlayRootOf(container);
      act(() => observer.fire(root, 500, 400));
      await waitFor(() =>
        expect(root).toHaveAttribute("data-ink-visible", "true"),
      );
      expect(
        container.querySelector('[data-slot="material-ink-frame"]'),
      ).toBeNull();
      await flushFrame();
      const [strokes] = drawFrameMock.mock.calls.at(-1) as [
        unknown[],
        number[],
      ];
      expect(strokes).toHaveLength(1);
      // 高度漂移 2px 以上（晚到图片把内容下推）→ 视为不匹配，撤下笔迹
      act(() => observer.fire(root, 500, 402));
      await waitFor(() =>
        expect(root).toHaveAttribute("data-ink-visible", "false"),
      );
    } finally {
      observer.restore();
    }
  });

  it("排版不匹配（分栏拖宽）时隐藏笔迹并提供「按圈画时排版查看」只读冻结框", async () => {
    const observer = manualResizeObserver();
    try {
      draftStore.saveMaterialInk("att-f3", "m1|1", inkDocOf([strokeAt(1, 1)]));
      draftStore.saveMaterialInkBase("att-f3", "m1|1", {
        cssWidth: 320,
        cssHeight: 400,
      });

      const { container } = render(
        <AttemptEditorProvider>
          <MaterialAnnotationOverlay
            attemptId="att-f3"
            materialId="m1"
            inkKey="m1|1"
          >
            <div>切换材料</div>
          </MaterialAnnotationOverlay>
        </AttemptEditorProvider>,
      );
      const root = overlayRootOf(container);
      act(() => observer.fire(root, 480, 520));
      await waitFor(() =>
        expect(root).toHaveAttribute("data-ink-visible", "false"),
      );
      // 只读入口出现；切换后按冻结宽 320 挂框（容器 480 > 320 → scale 1）
      fireEvent.click(screen.getByRole("button", { name: "按圈画时排版查看" }));
      const frame = frameOf(container);
      expect(frame.style.width).toBe("320px");
      expect(frame.style.transform).toBe("");
      expect(inputLayerOf(container)).toHaveStyle({ pointerEvents: "none" });
      await waitFor(() =>
        expect(root).toHaveAttribute("data-ink-visible", "true"),
      );
      // 切回当前排版：冻结框卸载，回到活排版
      fireEvent.click(screen.getByRole("button", { name: "回到当前排版查看" }));
      await waitFor(() => {
        expect(
          container.querySelector('[data-slot="material-ink-frame"]'),
        ).toBeNull();
      });
    } finally {
      observer.restore();
    }
  });

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

  it("无基准材料在圈画态保持活排版：仅激活圈画不挂框（全组材料不因一点圈画被冻结）", async () => {
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
      act(() => observer.fire(root, 480, 400));
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      expect(
        container.querySelector('[data-slot="material-ink-frame"]'),
      ).toBeNull();
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
          <CoordinatedAnnotationProvider initialTool="eraser">
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
        expect(
          container.querySelector('[data-slot="material-ink-frame"]'),
        ).toBeNull();
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
});
