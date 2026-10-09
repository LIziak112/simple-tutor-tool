import { describe, expect, it, vi } from "vitest";
import { resolveFunctionPlot } from "./function-plot-interop";

/**
 * function-plot 互操作解析器单测（T6R.23 P2-3）：动态 import 在 dev /
 * 生产 chunk / 测试桩下拿到的模块形态不同，解析器须依次兼容——
 * default 为函数（dev 形态）→ default.default 为函数（生产双重包裹形态）
 * → 模块自身为函数；都不可调用时返回 null（调用方进各自错误态）。
 */

describe("resolveFunctionPlot：三种模块形态探测", () => {
  it("dev 形态（default 即函数）：返回 default 本身", () => {
    const plot = vi.fn();
    expect(resolveFunctionPlot({ default: plot })).toBe(plot);
  });

  it("生产形态（default 双重包裹，真函数在 default.default）：返回嵌套函数", () => {
    const plot = vi.fn();
    // 生产 chunk 的 Rolldown CJS 互操作：mod.default 是命名空间对象
    const module = {
      __esModule: true,
      default: { __esModule: true, default: plot, Chart: {} },
    };
    expect(resolveFunctionPlot(module)).toBe(plot);
  });

  it("模块自身可调用形态：返回模块本身", () => {
    const plot = vi.fn();
    expect(resolveFunctionPlot(plot)).toBe(plot);
  });
});

describe("resolveFunctionPlot：不可识别形态返回 null", () => {
  it("default 为原始值（非函数非对象）", () => {
    expect(resolveFunctionPlot({ default: "function-plot" })).toBeNull();
  });

  it("default 为对象但嵌套 default 不可调用", () => {
    expect(
      resolveFunctionPlot({ default: { __esModule: true, Chart: {} } }),
    ).toBeNull();
  });

  it("无 default 的普通对象（命名导出形态）", () => {
    expect(resolveFunctionPlot({ Chart: {}, globals: {} })).toBeNull();
  });

  it("null / undefined 输入", () => {
    expect(resolveFunctionPlot(null)).toBeNull();
    expect(resolveFunctionPlot(undefined)).toBeNull();
  });
});
