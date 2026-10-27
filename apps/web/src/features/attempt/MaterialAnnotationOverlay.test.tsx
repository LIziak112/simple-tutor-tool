import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { InkDoc } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatedAnnotationProvider } from "@/features/annotation/coordinated-annotation-context";
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

function inputLayerOf(container: HTMLElement): HTMLElement {
  const layer = container.querySelector<HTMLElement>(
    '[data-slot="material-annotation-input"]',
  );
  if (!layer) throw new Error("输入层应已挂载");
  return layer;
}

/** 等待 rAF 合帧的重绘落地 */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

function mockLayerRect(layer: HTMLElement): void {
  vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 500,
    bottom: 400,
    width: 500,
    height: 400,
    x: 0,
    y: 0,
    toJSON: () => {},
  });
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
    const overlay = screen.getByTestId("material-content").parentElement;
    expect(overlay).toHaveAttribute("data-drawing", "false");
    expect(inputLayerOf(container)).toHaveStyle({ pointerEvents: "none" });
  });

  it("已存材料笔迹挂载时恢复并重绘（内存命中路径）", async () => {
    const existingDoc: InkDoc = {
      engine: "atrament",
      version: 1,
      data: {
        width: 1000,
        strokes: [
          {
            tool: "pen",
            color: "#dc2626",
            weight: 2.5,
            points: [
              { x: 10, y: 10, p: 0.5, t: 1 },
              { x: 20, y: 20, p: 0.5, t: 2 },
            ],
          },
        ],
      },
      updatedAt: Date.now(),
    };
    draftStore.saveMaterialInk("att-1", "mat-1", existingDoc);

    render(
      <AttemptEditorProvider>
        <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
          <div>材料正文</div>
        </MaterialAnnotationOverlay>
      </AttemptEditorProvider>,
    );

    const overlay = screen.getByText("材料正文").parentElement;
    expect(overlay).toHaveAttribute("data-stroke-count", "1");
    await flushFrame();
    expect(drawFrameMock).toHaveBeenCalled();
    const [strokes, visible] = drawFrameMock.mock.calls.at(-1) as [
      unknown[],
      number[],
    ];
    expect(strokes).toHaveLength(1);
    expect(visible).toEqual([2]);
  });

  it("冷启动异步恢复后触发重绘（回归：恢复只改 state 不重绘画布）", async () => {
    const backend = memoryBackend();
    installDraftBackend(backend);
    const existingDoc: InkDoc = {
      engine: "atrament",
      version: 1,
      data: {
        width: 1000,
        strokes: [
          {
            tool: "pen",
            color: "#dc2626",
            weight: 2.5,
            points: [{ x: 100, y: 100, p: 0.5, t: 1 }],
          },
        ],
      },
      updatedAt: Date.now(),
    };
    await backend.set("draft:att-cold", {
      answers: {},
      inks: {},
      materialInks: { "mat-cold": existingDoc },
      savedAt: Date.now(),
      syncedAt: 0,
      answerDigests: {},
      inkDigests: {},
      answerRevisions: {},
      answerMutationIds: {},
      answerConflicts: {},
    });

    render(
      <AttemptEditorProvider>
        <MaterialAnnotationOverlay attemptId="att-cold" materialId="mat-cold">
          <div>冷启动材料</div>
        </MaterialAnnotationOverlay>
      </AttemptEditorProvider>,
    );

    const overlay = screen.getByText("冷启动材料").parentElement;
    await vi.waitFor(() => {
      expect(overlay).toHaveAttribute("data-stroke-count", "1");
    });
    await waitFor(() => {
      const [strokes] = drawFrameMock.mock.calls.at(-1) as [
        unknown[],
        number[],
      ];
      expect(strokes).toHaveLength(1);
    });
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
    const overlay = screen.getByText("材料文章段落").parentElement;
    await waitFor(() =>
      expect(overlay).toHaveAttribute("data-drawing", "true"),
    );

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
    expect(overlay).toHaveAttribute("data-stroke-count", "1");
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
    expect(screen.getByText("手掌区域").parentElement).toHaveAttribute(
      "data-stroke-count",
      "0",
    );
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
    render(
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
    const overlay = screen.getByText("材料保护区").parentElement;
    expect(overlay).toHaveAttribute("data-drawing", "false");
    expect(
      overlay?.querySelector('[data-slot="material-annotation-input"]'),
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
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen" });
    });

    // 落在版本化键 m1|2，不污染裸 materialId 槽位
    expect(draftStore.getMaterialInk("att-1", "m1|2")).not.toBeNull();
    expect(draftStore.getMaterialInk("att-1", "m1")).toBeNull();
  });

  it("橡皮按引擎 INK_ERASE_RADIUS 命中整笔并即时保存", async () => {
    const existingDoc: InkDoc = {
      engine: "atrament",
      version: 1,
      data: {
        width: 1000,
        strokes: [
          {
            tool: "pen",
            color: "#dc2626",
            weight: 2.5,
            points: [
              { x: 100, y: 100, p: 0.5, t: 1 },
              { x: 200, y: 100, p: 0.5, t: 2 },
            ],
          },
        ],
      },
      updatedAt: Date.now(),
    };
    draftStore.saveMaterialInk("att-1", "mat-1", existingDoc);

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
    expect(screen.getByText("擦除材料").parentElement).toHaveAttribute(
      "data-stroke-count",
      "0",
    );
  });
});
