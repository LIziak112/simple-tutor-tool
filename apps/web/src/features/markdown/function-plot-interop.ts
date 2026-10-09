import type { FunctionPlotOptions } from "function-plot";

/**
 * function-plot 动态导入互操作解析器（T6R.23 P2-3 修复）。
 *
 * function-plot 是 CommonJS 包（exports.default = functionPlot）。动态
 * import 在不同环境拿到的模块形态不同：
 * - dev（Vite 预构建 interop）：mod.default 即绘制函数；
 * - 生产 chunk（Rolldown CJS 互操作的双重包裹）：mod.default 是命名空间
 *   对象，真正可调用的绘制函数在 mod.default.default——直接调用
 *   mod.default 抛 TypeError，生产环境任何 fn 表达式渲染全崩的根因；
 * - 少数测试/打包形态：模块自身即函数。
 *
 * 探测顺序：default 为函数 → default.default 为函数 → 模块自身为函数；
 * 都不可调用返回 null（调用方进各自错误态）。两个调用点
 * （directives/Media.tsx 的 GraphDirective 与 export/question-materials.ts
 * 的 renderGraphFigurePng）共用本解析器，搬家不抄数。
 */

/** function-plot 绘制函数：调用方不消费返回值（Chart 实例内部自洽） */
export type FunctionPlotFn = (options: FunctionPlotOptions) => unknown;

/** unknown 收窄：可调用 */
function isCallable(value: unknown): value is FunctionPlotFn {
  return typeof value === "function";
}

/** unknown 收窄：非空对象（可安全读属性） */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 从动态 import 得到的模块中解析出可调用的 function-plot 绘制函数 */
export function resolveFunctionPlot(mod: unknown): FunctionPlotFn | null {
  if (isRecordLike(mod)) {
    const { default: defaultExport } = mod;
    // 形态一（dev / 预构建 interop）：default 即绘制函数
    if (isCallable(defaultExport)) {
      return defaultExport;
    }
    // 形态二（生产 chunk 双重包裹）：绘制函数嵌在 default.default
    if (isRecordLike(defaultExport)) {
      const nestedDefault = defaultExport.default;
      if (isCallable(nestedDefault)) {
        return nestedDefault;
      }
    }
  }
  // 形态三：模块自身可调用
  if (isCallable(mod)) {
    return mod;
  }
  return null;
}
