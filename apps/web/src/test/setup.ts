// web 组件测试全局 setup：接入 jest-dom 的 DOM 断言扩展（toBeInTheDocument 等）。
// 该导入同时对 vitest 的 expect 做模块增强，供所有测试文件直接使用。
import "@testing-library/jest-dom/vitest";
