/** 开发诊断仅使用固定阶段名，不包含题面、答案或账号标识。 */
type PerformanceStage =
  | "annotation:reference-ready"
  | "annotation:public-copy"
  | "annotation:copy-ready"
  | "annotation:font-css"
  | "annotation:rasterize"
  | "annotation:png-check"
  | "annotation:local-save"
  | "annotation:base-state"
  | "annotation:prepare"
  | "annotation:surface-ready"
  | "annotation:layout-match";

export async function measureStage<T>(
  stage: PerformanceStage,
  task: () => Promise<T>,
): Promise<T> {
  if (!import.meta.env.DEV) return task();
  const start = performance.now();
  try {
    return await task();
  } finally {
    // 诊断不可用不能改变业务返回值或异常；每阶段最多保留二十条。
    try {
      const name = `ownclass:${stage}`;
      if (performance.getEntriesByName(name).length >= 20)
        performance.clearMeasures(name);
      performance.measure(name, { start, duration: performance.now() - start });
    } catch {
      /* 旧浏览器或测试环境没有 User Timing 时忽略诊断。 */
    }
  }
}
