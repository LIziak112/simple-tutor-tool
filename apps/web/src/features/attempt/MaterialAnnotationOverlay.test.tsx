import { fireEvent, render, screen } from "@testing-library/react";
import type { InkDoc } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatedAnnotationProvider } from "@/features/annotation/coordinated-annotation-context";
import {
  AttemptEditorProvider,
  useAttemptEditor,
} from "./AttemptEditorContext";
import { draftStore, installDraftBackend, memoryBackend } from "./draft-store";
import { MaterialAnnotationOverlay } from "./MaterialAnnotationOverlay";

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

describe("MaterialAnnotationOverlay 材料圈画手写图层", () => {
  beforeEach(() => {
    installDraftBackend(memoryBackend());
  });

  it("非标注态时渲染只读图层（pointer-events: none），内容可读", () => {
    render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider>
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div data-testid="material-content">四天气温与降水量表</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );

    expect(screen.getByTestId("material-content")).toBeInTheDocument();
    const overlay = screen.getByTestId("material-content").parentElement;
    expect(overlay).toHaveAttribute("data-drawing", "false");

    const canvas = overlay?.querySelector("canvas");
    expect(canvas).toHaveStyle({ pointerEvents: "none" });
  });

  it("已存材料笔迹挂载时自动恢复", () => {
    const existingDoc: InkDoc = {
      engine: "atrament",
      version: 1,
      data: {
        width: 1000,
        strokes: [
          {
            tool: "pen",
            color: "red",
            weight: 3,
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
        <CoordinatedAnnotationProvider>
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>材料正文</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );

    const overlay = screen.getByText("材料正文").parentElement;
    expect(overlay).toHaveAttribute("data-stroke-count", "1");
  });

  it("当题进入标注态时，材料图层同步激活为交互态（pointer-events: auto），落笔保存到 draftStore", () => {
    render(
      <AttemptEditorProvider>
        <CoordinatedAnnotationProvider>
          <AnnotationToggle questionId="q1" />
          <MaterialAnnotationOverlay attemptId="att-1" materialId="mat-1">
            <div>材料文章段落</div>
          </MaterialAnnotationOverlay>
        </CoordinatedAnnotationProvider>
      </AttemptEditorProvider>,
    );

    const overlay = screen.getByText("材料文章段落").parentElement;
    expect(overlay).toHaveAttribute("data-drawing", "false");

    // 点击开启题目圈画
    fireEvent.click(screen.getByTestId("toggle-annotation"));

    // 材料图层同步激活
    expect(overlay).toHaveAttribute("data-drawing", "true");
    const canvas = overlay?.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas).toHaveStyle({ pointerEvents: "auto" });

    // 模拟 canvas 矩形与指针捕获
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
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
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();

    // 划一笔：pointerdown -> pointermove -> pointerup
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      button: 0,
      clientX: 50,
      clientY: 50,
    });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 100, clientY: 60 });

    // 验证笔迹已写入 draftStore，且归属 att-1 + mat-1
    const stored = draftStore.getMaterialInk("att-1", "mat-1");
    expect(stored?.engine).toBe("atrament");
    if (stored?.engine === "atrament") {
      expect(stored.data.strokes.length).toBe(1);
      expect(stored.data.strokes[0]?.points.length).toBeGreaterThanOrEqual(2);
    }
  });
});
