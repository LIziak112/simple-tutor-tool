import { act, render, screen } from "@testing-library/react";
import type {
  AnalyticsKnowledgeRow,
  AnalyticsTrendPoint,
} from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeBarChart, TrendLineChart } from "./charts";

/**
 * 自有 EChart 封装的生命周期测试（T4.2 白屏修复）：mock echarts/core——
 * init 桩返回 setOption/resize/dispose 可 spy 的实例；ResizeObserver 用本文件
 * 桩替换（记录观察器实例，测试手动触发回调模拟容器尺寸变化）。
 * option 装配口径由 chart-options.test 锁定，这里只断言「何时调用哪个实例方法」。
 */

/** echarts/core 桩：三个实例方法 + init 记录入参容器并返回实例形状 */
const echartsStub = vi.hoisted(() => {
  const setOption = vi.fn();
  const resize = vi.fn();
  const dispose = vi.fn();
  const init = vi.fn((_el: HTMLElement) => ({ setOption, resize, dispose }));
  return { setOption, resize, dispose, init };
});

vi.mock("echarts/core", () => ({ use: vi.fn(), init: echartsStub.init }));
vi.mock("echarts/charts", () => ({ LineChart: {}, BarChart: {} }));
vi.mock("echarts/components", () => ({
  GridComponent: {},
  TooltipComponent: {},
}));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));

/** 本文件专用的 ResizeObserver 桩：收集实例供手动触发回调 */
const observerStubs: {
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}[] = [];
class ResizeObserverSpy {
  readonly callback: ResizeObserverCallback;
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observerStubs.push(this);
  }
}

/** 趋势数据工厂（两周，第二周无已判定题） */
function makeTrend(rates: (number | null)[]): AnalyticsTrendPoint[] {
  return rates.map((rate, index) => ({
    weekStart: `2026-09-${String(7 * index + 7).padStart(2, "0")}`,
    attemptCount: rate === null ? 0 : 1,
    judgedCount: rate === null ? 0 : 4,
    correctCount: rate === null ? 0 : Math.round(rate * 4),
    correctRate: rate,
  }));
}

/** 考点数据工厂 */
function makeKnowledge(rate: number | null): AnalyticsKnowledgeRow {
  return {
    knowledge: "数轴",
    correctCount: rate === null ? 0 : 1,
    wrongCount: 1,
    pendingCount: 0,
    judgedCount: rate === null ? 0 : 2,
    correctRate: rate,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  observerStubs.length = 0;
  // 每个用例前重新覆盖（afterEach unstub 后回到 setup.ts 的全局桩）
  vi.stubGlobal("ResizeObserver", ResizeObserverSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** setOption 第 n 次调用收到的 option */
function optionAt(call: number): unknown {
  return echartsStub.setOption.mock.calls[call]?.[0];
}

describe("EChart 生命周期（自有封装）", () => {
  it("挂载：init 拿到渲染出的容器并 setOption 一次（趋势数据装配）", () => {
    render(<TrendLineChart points={makeTrend([2 / 3, null])} />);
    expect(echartsStub.init).toHaveBeenCalledTimes(1);
    const el = echartsStub.init.mock.calls[0]?.[0] as HTMLElement;
    // init 的容器就是带 data-testid 的 div（断言装配落点，而非另起的桩节点）
    expect(el.dataset.testid).toBe("analytics-trend-chart");
    expect(echartsStub.setOption).toHaveBeenCalledTimes(1);
    const option = optionAt(0) as {
      xAxis: { data: string[] };
      series: { data: (number | null)[] }[];
    };
    expect(option.xAxis.data).toEqual(["9/7", "9/14"]);
    expect(option.series[0]?.data).toEqual([66.7, null]);
  });

  it("option 变更：再次 setOption 且整体重设（notMerge）", () => {
    const { rerender } = render(
      <TrendLineChart points={makeTrend([2 / 3, null])} />,
    );
    expect(echartsStub.setOption).toHaveBeenCalledTimes(1);
    rerender(<TrendLineChart points={makeTrend([1, 0.5])} />);
    expect(echartsStub.setOption).toHaveBeenCalledTimes(2);
    const option = optionAt(1) as {
      series: { data: (number | null)[] }[];
    };
    expect(option.series[0]?.data).toEqual([100, 50]);
    // 整体重设：防筛选切换后旧系列/旧配色残留
    expect(echartsStub.setOption.mock.calls[1]?.[1]).toEqual({
      notMerge: true,
    });
  });

  it("容器尺寸变化：观察器回调触发 chart.resize（iPad 横竖屏）", () => {
    render(<TrendLineChart points={makeTrend([1])} />);
    expect(observerStubs.length).toBe(1);
    expect(echartsStub.resize).not.toHaveBeenCalled();
    act(() => {
      observerStubs[0]?.callback([], {} as ResizeObserver);
    });
    expect(echartsStub.resize).toHaveBeenCalledTimes(1);
  });

  it("卸载：dispose 实例并断开观察", () => {
    const { unmount } = render(<TrendLineChart points={makeTrend([1])} />);
    unmount();
    expect(echartsStub.dispose).toHaveBeenCalledTimes(1);
    expect(observerStubs[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("条形图同样经 init + setOption 装配（薄弱序口径在 chart-options.test）", () => {
    render(<KnowledgeBarChart rows={[makeKnowledge(0.5)]} />);
    expect(echartsStub.init).toHaveBeenCalledTimes(1);
    expect(echartsStub.setOption).toHaveBeenCalledTimes(1);
    const el = echartsStub.init.mock.calls[0]?.[0] as HTMLElement;
    expect(el.dataset.testid).toBe("analytics-knowledge-chart");
  });

  it("空数据不 init（不渲染 canvas）出空态文案", () => {
    render(<TrendLineChart points={makeTrend([null])} />);
    expect(
      screen.getByText("时间范围内还没有已判定的作答，暂无趋势可看。"),
    ).toBeInTheDocument();
    render(<KnowledgeBarChart rows={[]} />);
    expect(
      screen.getByText("时间范围内还没有已判定的作答，暂无考点统计。"),
    ).toBeInTheDocument();
    expect(echartsStub.init).not.toHaveBeenCalled();
    expect(echartsStub.setOption).not.toHaveBeenCalled();
  });
});
