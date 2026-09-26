import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
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

/** 教师端路由（T1.9）：路由级代码分割，登录/设置页与主布局分块加载 */
const teacherRoutes = (() => {
  const SetupPage = lazy(() => import("./pages/teacher/SetupPage"));
  const LoginPage = lazy(() => import("./pages/teacher/LoginPage"));
  const TeacherLayout = lazy(() => import("./pages/teacher/TeacherLayout"));
  const SettingsPage = lazy(() => import("./pages/teacher/SettingsPage"));
  const ContentPage = lazy(() => import("./pages/teacher/ContentPage"));
  const ImportPage = lazy(() => import("./pages/teacher/ImportPage"));
  const StudentsPage = lazy(() => import("./pages/teacher/StudentsPage"));
  const AssignmentsPage = lazy(() => import("./pages/teacher/AssignmentsPage"));
  const PlaceholderPage = lazy(() => import("./pages/teacher/PlaceholderPage"));

  /** 布局内的懒加载兜底（骨架级提示即可，布局本身很快） */
  const pageFallback = (
    <p className="p-8 text-sm text-muted-foreground">页面加载中…</p>
  );

  /** 两个「建设中」占位分区（后续任务逐个替换；内容由 T1.11/T2.1 实现并移出占位） */
  const placeholders = [
    {
      path: "data",
      title: "数据",
      description: "作答数据导出与备份将在这里提供（T4.x 起）。",
    },
    {
      path: "insights",
      title: "学情",
      description: "学情分析与报告将在这里提供（T3.x 起）。",
    },
  ] as const;

  return (
    <>
      <Route
        path="/t/setup"
        element={
          <Suspense fallback={<TeacherRouteFallback />}>
            <SetupPage />
          </Suspense>
        }
      />
      <Route
        path="/t/login"
        element={
          <Suspense fallback={<TeacherRouteFallback />}>
            <LoginPage />
          </Suspense>
        }
      />
      <Route
        path="/t"
        element={
          <Suspense fallback={<TeacherRouteFallback />}>
            <TeacherLayout />
          </Suspense>
        }
      >
        <Route index element={<Navigate to="/t/content" replace />} />
        <Route
          path="content"
          element={
            <Suspense fallback={pageFallback}>
              <ContentPage />
            </Suspense>
          }
        />
        <Route
          path="import"
          element={
            <Suspense fallback={pageFallback}>
              <ImportPage />
            </Suspense>
          }
        />
        <Route
          path="students"
          element={
            <Suspense fallback={pageFallback}>
              <StudentsPage />
            </Suspense>
          }
        />
        <Route
          path="assignments"
          element={
            <Suspense fallback={pageFallback}>
              <AssignmentsPage />
            </Suspense>
          }
        />
        <Route
          path="settings"
          element={
            <Suspense fallback={pageFallback}>
              <SettingsPage />
            </Suspense>
          }
        />
        {placeholders.map((item) => (
          <Route
            key={item.path}
            path={item.path}
            element={
              <Suspense fallback={pageFallback}>
                <PlaceholderPage
                  title={item.title}
                  description={item.description}
                />
              </Suspense>
            }
          />
        ))}
      </Route>
    </>
  );
})();

/** 教师端整页加载兜底（懒加载期间） */
function TeacherRouteFallback() {
  return (
    <main
      aria-live="polite"
      className="flex min-h-dvh items-center justify-center bg-background"
    >
      <p className="text-sm text-muted-foreground">页面加载中…</p>
    </main>
  );
}

/** 顶层路由。学生端（/s/:token，T2.x）与教师端（/t）分区扩展 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      {devOnlyRoutes}
      {teacherRoutes}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
