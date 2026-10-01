// web 组件测试全局 setup：接入 jest-dom 的 DOM 断言扩展（toBeInTheDocument 等）。
// 该导入同时对 vitest 的 expect 做模块增强，供所有测试文件直接使用。
import "@testing-library/jest-dom/vitest";

// jsdom 不实现 ResizeObserver（自有 EChart 封装在挂载时创建观察器）：
// 提供最小桩——实例可创建、各方法为空实现；构造出的观察器记录回调，
// 需要模拟容器尺寸变化的测试用自己的桩覆盖（vi.stubGlobal，见
// features/insights/charts.test.tsx）。
class ResizeObserverStub implements ResizeObserver {
  /** 观察回调（供测试子类收集并手动触发） */
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub;
}
