import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";

/**
 * 开发环境专属路由（T1.8 渲染开发页）。
 * import.meta.env.DEV 在生产构建中被静态替换为 false，整个 IIFE 连同其中的
 * 动态 import 一起被 tree-shaking 移除——/dev/render 的代码不进入生产产物。
 */
const devOnlyRoutes = import.meta.env.DEV
  ? (() => {
      const RenderDevPage = lazy(() => import("./pages/dev/RenderDevPage"));
      return (
        <Route
          key="dev-render"
          path="/dev/render"
          element={
            <Suspense
              fallback={
                <p className="p-8 text-sm text-muted-foreground">
                  开发页加载中…
                </p>
              }
            >
              <RenderDevPage />
            </Suspense>
          }
        />
      );
    })()
  : null;

/** 顶层路由。后续任务按学生端（/s/:token）与教师端（/t）分区扩展 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      {devOnlyRoutes}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
