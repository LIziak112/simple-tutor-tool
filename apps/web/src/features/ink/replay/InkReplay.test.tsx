import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInkReplayData } from "./model.ts";

/**
 * <InkReplay> 控制逻辑测试（T3.3）：播放/暂停/进度跳转/倍速/到尾自停/空数据。
 * jsdom 无 canvas 2d context——绘制薄层（draw.ts）与 Excalidraw 桥整体 mock，
 * 断言「喂给绘制层的帧 = frameAt(模型, 当前时刻)」与控制条状态；
 * rAF 手动驱动（stub requestAnimationFrame + performance.now），不依赖真实计时。
 */

const { drawFrameMock } = vi.hoisted(() => ({ drawFrameMock: vi.fn() }));

vi.mock("./draw.ts", () => ({
  createAtramentReplayCanvas: () => ({
    drawFrame: drawFrameMock,
    destroy: vi.fn(),
  }),
}));

vi.mock("./ExcalidrawReplay.tsx", () => ({
  ExcalidrawReplay: ({ visibleElements }: { visibleElements: number }) => (
    <div data-testid="excalidraw-stub" data-visible={visibleElements} />
  ),
}));

import { InkReplay } from "./InkReplay.tsx";

/**
 * 两笔带时间戳的文档：笔 1 点时刻 [0,1000,2000,3000]，间隙 160，
 * 笔 2 [0,800,1600] → 总时长 4.76s ≥ 回放下限 2s（不触发拉伸，断言绝对时刻）。
 */
function atramentModel() {
  const model = parseInkReplayData({
    engine: "atrament",
    version: 1,
    data: {
      width: 1000,
      strokes: [
        {
          tool: "pen",
          color: "#1f2328",
          weight: 4,
          points: [
            { x: 10, y: 10, p: 0.5, t: 0 },
            { x: 50, y: 10, p: 0.6, t: 1000 },
            { x: 90, y: 10, p: 0.5, t: 2000 },
            { x: 130, y: 10, p: 0.5, t: 3000 },
          ],
        },
        {
          tool: "pen",
          color: "#1f2328",
          weight: 4,
          points: [
            { x: 30, y: 20, p: 0.5, t: 0 },
            { x: 30, y: 60, p: 0.7, t: 800 },
            { x: 30, y: 90, p: 0.5, t: 1600 },
          ],
        },
      ],
    },
    updatedAt: 1,
  });
  if (model === null) throw new Error("测试夹具应为合法文档");
  return model;
}

/** 手动驱动的 rAF 与时钟 */
let rafCb: FrameRequestCallback | null = null;
let cancelMock: ReturnType<typeof vi.fn>;
let now = 1_000;
let nowSpy: ReturnType<typeof vi.spyOn>;

/** 推进虚拟时钟并触发一帧 */
function driveFrame(elapsedMs: number): void {
  act(() => {
    now += elapsedMs;
    rafCb?.(now);
  });
}

beforeEach(() => {
  drawFrameMock.mockClear();
  rafCb = null;
  now = 1_000;
  cancelMock = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafCb = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", cancelMock);
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  nowSpy.mockRestore();
  vi.unstubAllGlobals();
  cleanup();
});

describe("<InkReplay>：atrament 控制逻辑", () => {
  it("初始渲染控制条齐全；首帧只画第 1 笔起点（t=0 前段）", () => {
    render(<InkReplay data={atramentModel()} />);
    expect(screen.getByRole("button", { name: "播放" })).toBeEnabled();
    expect(screen.getByRole("slider", { name: "回放进度" })).toHaveValue("0");
    expect(screen.getByRole("button", { name: "1×" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "2×" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "4×" })).toBeInTheDocument();
    expect(screen.getByText("0.0 秒 / 4.8 秒")).toBeInTheDocument();
    expect(drawFrameMock).toHaveBeenCalledTimes(1);
    expect(drawFrameMock.mock.lastCall?.[1]).toEqual([1, 0]);
  });

  it("播放 → 暂停按钮切换，rAF 按真实流逝推进画面与时间文本", () => {
    render(<InkReplay data={atramentModel()} />);
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
    expect(rafCb).not.toBeNull();

    driveFrame(1000); // t=1000：第 1 笔走到第 2 点
    expect(drawFrameMock.mock.lastCall?.[1]).toEqual([2, 0]);
    expect(screen.getByText("1.0 秒 / 4.8 秒")).toBeInTheDocument();

    driveFrame(2160); // t=3160：第 1 笔完整、第 2 笔起点刚落
    expect(drawFrameMock.mock.lastCall?.[1]).toEqual([4, 1]);

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();
    expect(cancelMock).toHaveBeenCalled();
  });

  it("播放到底自动停：按钮回「播放」、时刻停在总时长、画面为完整状态", () => {
    render(<InkReplay data={atramentModel()} />);
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    driveFrame(10_000); // 远超总时长 4760ms
    expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();
    expect(screen.getByText("4.8 秒 / 4.8 秒")).toBeInTheDocument();
    expect(drawFrameMock.mock.lastCall?.[1]).toEqual([4, 3]);
    // 到尾后循环不再排队（当前 cb 已结束，不再发起新帧）
    const cbAtEnd = rafCb;
    driveFrame(100);
    expect(rafCb).toBe(cbAtEnd);
    expect(screen.getByText("4.8 秒 / 4.8 秒")).toBeInTheDocument();
  });

  it("播完再按播放从头重演", () => {
    render(<InkReplay data={atramentModel()} />);
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    driveFrame(10_000);
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(screen.getByText("0.0 秒 / 4.8 秒")).toBeInTheDocument();
    expect(drawFrameMock.mock.lastCall?.[1]).toEqual([1, 0]);
  });

  it("倍速只改变调度快慢：2× 下同样真实时长推进两倍时刻，画面与 1× 同时刻一致", () => {
    render(<InkReplay data={atramentModel()} />);
    fireEvent.click(screen.getByRole("button", { name: "2×" }));
    expect(screen.getByRole("button", { name: "2×" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    driveFrame(500); // 真实 500ms × 2 = t=1000（与 1× 驱动 1000ms 的画面一致）
    expect(screen.getByText("1.0 秒 / 4.8 秒")).toBeInTheDocument();
    expect(drawFrameMock.mock.lastCall?.[1]).toEqual([2, 0]);
  });

  it("进度条拖动（跳转）= 重绘到该时刻的累积状态，任意时刻状态正确", () => {
    render(<InkReplay data={atramentModel()} />);
    fireEvent.change(screen.getByRole("slider", { name: "回放进度" }), {
      target: { value: "1600" },
    });
    expect(drawFrameMock.mock.lastCall?.[1]).toEqual([2, 0]);
    expect(screen.getByText("1.6 秒 / 4.8 秒")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: "回放进度" }), {
      target: { value: "3560" },
    });
    expect(drawFrameMock.mock.lastCall?.[1]).toEqual([4, 1]);

    // 播放中拖动：从新时刻继续推进
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    driveFrame(450); // 3560 + 450 = 4010：第 2 笔走到 850ms 处（第 2 点）
    expect(drawFrameMock.mock.lastCall?.[1]).toEqual([4, 2]);
  });

  it("无笔画的有效文档：控制禁用并提示「无笔画可回放」，不崩溃", () => {
    const empty = parseInkReplayData({
      engine: "atrament",
      version: 1,
      data: { width: 1000, strokes: [] },
      updatedAt: 1,
    });
    if (empty === null) throw new Error("空文档应可解析");
    render(<InkReplay data={empty} />);
    expect(screen.getByText("无笔画可回放")).toBeVisible();
    expect(screen.getByRole("button", { name: "播放" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "回放进度" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "2×" })).toBeDisabled();
    expect(screen.getByText("0.0 秒 / 0.0 秒")).toBeInTheDocument();
  });
});

describe("<InkReplay>：excalidraw 分支", () => {
  function excalidrawModel() {
    // 200 点 freedraw（2400ms）+ 矩形（240ms）→ 总 2.64s ≥ 回放下限 2s，不触发拉伸
    const model = parseInkReplayData({
      engine: "excalidraw",
      version: 1,
      data: {
        scene: {
          elements: [
            { id: "a", type: "freedraw", points: new Array(200).fill(0) },
            { id: "b", type: "rectangle" },
          ],
        },
      },
      updatedAt: 1,
    });
    if (model === null) throw new Error("测试夹具应为合法文档");
    return model;
  }

  it("初始只见第 1 个元素；进度跳转后逐个出现（顺序重演）", () => {
    render(<InkReplay data={excalidrawModel()} />);
    const stub = screen.getByTestId("excalidraw-stub");
    expect(stub).toHaveAttribute("data-visible", "1");
    expect(screen.getByText("0.0 秒 / 2.6 秒")).toBeInTheDocument(); // 2400+240

    fireEvent.change(screen.getByRole("slider", { name: "回放进度" }), {
      target: { value: "2400" },
    });
    expect(stub).toHaveAttribute("data-visible", "2");
    expect(screen.getByText("2.4 秒 / 2.6 秒")).toBeInTheDocument();
  });

  it("播放推进同样驱动元素逐个出现", () => {
    render(<InkReplay data={excalidrawModel()} />);
    const stub = screen.getByTestId("excalidraw-stub");
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    driveFrame(2400);
    expect(stub).toHaveAttribute("data-visible", "2");
  });
});
