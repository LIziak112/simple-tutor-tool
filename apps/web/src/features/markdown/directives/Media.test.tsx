import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphDirective, ImageDirective } from "./Media";

/**
 * GraphDirective 的 function-plot 动态导入互操作测试（T6R.23 P2-3）：
 * function-plot 是 CJS 包，dev（Vite 预构建 interop）与生产 chunk
 * （Rolldown CJS 互操作双重包裹）拿到的模块形态不同——真实可调用函数
 * 分别位于 mod.default 与 mod.default.default。生产形态曾致所有 fn
 * 表达式渲染全崩（TypeError: ... is not a function），此处锁定各形态行为。
 */

const hoisted = vi.hoisted(() => {
  /** 绘制函数桩：记录调用参数；可在用例内改为抛错 */
  const plotMock = vi.fn<(options: unknown) => unknown>();
  /** mock 模块 default 的当前形态：用例运行时切换 dev / 生产 / 不可识别 */
  const state: { currentDefault: unknown } = { currentDefault: undefined };
  return { plotMock, state };
});

vi.mock("function-plot", () => ({
  // getter 延迟取值：vi.mock 工厂被提升执行，形态由各用例运行时指定
  get default() {
    return hoisted.state.currentDefault;
  },
}));

/** 便捷渲染：只给 GraphDirective 关心的属性 */
function renderGraph(fn = "x^2", range = "-3,3") {
  return render(
    <GraphDirective
      name="graph"
      attrs={{ fn, range }}
      index={0}
      docIndex={1}
    />,
  );
}

/** 冲刷动态 import 的微任务链（其内的 setState 进入 act 范围） */
async function flushImportChain(): Promise<void> {
  await act(async () => {});
}

beforeEach(() => {
  hoisted.plotMock.mockReset();
  hoisted.state.currentDefault = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GraphDirective：function-plot 模块形态互操作", () => {
  it("dev 形态（default 即函数）：绘制函数收到完整 options，组件进 ready 态", async () => {
    hoisted.state.currentDefault = hoisted.plotMock;
    const { container } = renderGraph();
    await flushImportChain();
    // ready 态：加载中（status）与错误（alert）均消失
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(hoisted.plotMock).toHaveBeenCalledTimes(1);
    expect(hoisted.plotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: container.querySelector("[data-graph-canvas]"),
        width: 480, // jsdom 无布局：clientWidth=0 落入 480 兜底
        height: 260,
        data: [{ fn: "x^2", graphType: "polyline" }],
        xAxis: { domain: [-3, 3] },
      }),
    );
  });

  it("生产形态（default 双重包裹，真函数在 default.default）：同样完成绘制并 ready", async () => {
    // 生产 chunk：mod.default 是命名空间对象，真函数嵌在其 default 上
    hoisted.state.currentDefault = {
      __esModule: true,
      default: hoisted.plotMock,
    };
    const { container } = renderGraph("sin(x)/x");
    await flushImportChain();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(hoisted.plotMock).toHaveBeenCalledTimes(1);
    expect(hoisted.plotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: container.querySelector("[data-graph-canvas]"),
        data: [{ fn: "sin(x)/x", graphType: "polyline" }],
      }),
    );
  });

  it("模块形态不可识别（default 非函数且无嵌套函数）：进错误态而不崩溃", async () => {
    hoisted.state.currentDefault = { __esModule: true, Chart: {} };
    renderGraph();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "函数图像渲染失败",
    );
  });

  it("绘制抛错：进错误态并输出 console.error 诊断日志", async () => {
    hoisted.plotMock.mockImplementation(() => {
      throw new Error("绘制失败桩");
    });
    hoisted.state.currentDefault = hoisted.plotMock;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    renderGraph();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "函数图像渲染失败",
    );
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("ImageDirective：放大查看与加载重试（QM-08 长内容细项）", () => {
  function renderImage(src = "blobs/media/ab.png", alt = "统计图") {
    return render(
      <ImageDirective name="image" attrs={{ src, alt }} index={0} docIndex={0} />,
    );
  }

  it("成功态：缩略图可点击放大（弹层内同 src 全尺寸图）", async () => {
    const view = renderImage();
    const trigger = screen.getByRole("button", { name: "放大查看：统计图" });
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "/blobs/media/ab.png",
    );
    await act(async () => {
      trigger.click();
    });
    // Dialog 打开：弹层内出现全尺寸图（背景被 Radix aria-hidden，唯一可达
    // img 在弹层中）
    const dialog = screen.getByRole("dialog");
    const zoomed = dialog.querySelector("img");
    expect(zoomed?.getAttribute("src")).toBe("/blobs/media/ab.png");
  });

  it("失败态：占位含重试按钮；点击重试重挂 img 重新请求", async () => {
    const view = renderImage("blobs/media/broken.png", "示意图");
    const img = view.container.querySelector("img") as HTMLImageElement;
    // jsdom 不自动触发网络失败：手动派发 onError（act 内 flush 状态更新）
    act(() => {
      img.dispatchEvent(new Event("error"));
    });
    expect(screen.getByRole("alert").textContent).toContain("图片加载失败");
    const retry = screen.getByRole("button", { name: "重新加载" });
    await act(async () => {
      retry.click();
    });
    // 重试后回到图片形态（key 变化的重挂由 React key 机制保证）
    expect(view.container.querySelector("img")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
