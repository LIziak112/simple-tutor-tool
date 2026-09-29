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

/**
 * 手写开发页 /dev/ink（T2.7）：两区块（Atrament 页内 + Excalidraw 全屏）+
 * 数据面板，是 iPad 真机调手感的实验场（§5.4 真机试验页）。
 * 不做 DEV 门控：真机验收需要在生产构建上测性能，且页面不进入任何导航。
 * 路由级懒加载 + 引擎内部懒加载，Excalidraw 不进主包（构建产物有独立 chunk）。
 */
const inkDevRoute = (() => {
  const InkDevPage = lazy(() => import("./pages/dev/InkDevPage"));
  return (
    <Route
      key="dev-ink"
      path="/dev/ink"
      element={
        <Suspense
          fallback={
            <p className="p-8 text-sm text-muted-foreground">开发页加载中…</p>
          }
        >
          <InkDevPage />
        </Suspense>
      }
    />
  );
})();

/** 教师端路由（T1.9）：路由级代码分割，登录/设置页与主布局分块加载 */
const teacherRoutes = (() => {
  const SetupPage = lazy(() => import("./pages/teacher/SetupPage"));
  const LoginPage = lazy(() => import("./pages/teacher/LoginPage"));
  const RegisterPage = lazy(() => import("./pages/teacher/RegisterPage"));
  const TeacherLayout = lazy(() => import("./pages/teacher/TeacherLayout"));
  const SettingsPage = lazy(() => import("./pages/teacher/SettingsPage"));
  const LibraryPage = lazy(() => import("./pages/teacher/LibraryPage"));
  const SharedPage = lazy(() => import("./pages/teacher/SharedPage"));
  const ImportPage = lazy(() => import("./pages/teacher/ImportPage"));
  const CoursesPage = lazy(() => import("./pages/teacher/CoursesPage"));
  const CourseEditPage = lazy(() => import("./pages/teacher/CourseEditPage"));
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
        // T2B.6：教师自助注册（注册开关关闭时页面内显示关闭提示）
        path="/t/register"
        element={
          <Suspense fallback={<TeacherRouteFallback />}>
            <RegisterPage />
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
        <Route index element={<Navigate to="/t/library" replace />} />
        <Route
          // T2A.2：内容页由资源库页替代，旧路径重定向（外部书签/旧链接兼容）
          path="content"
          element={<Navigate to="/t/library" replace />}
        />
        <Route
          path="library"
          element={
            <Suspense fallback={pageFallback}>
              <LibraryPage />
            </Suspense>
          }
        />
        <Route
          // T2B.7：共享目录（发布 → 浏览 → 导入）
          path="shared"
          element={
            <Suspense fallback={pageFallback}>
              <SharedPage />
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
          path="courses"
          element={
            <Suspense fallback={pageFallback}>
              <CoursesPage />
            </Suspense>
          }
        />
        <Route
          path="courses/:id"
          element={
            <Suspense fallback={pageFallback}>
              <CourseEditPage />
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

/**
 * 管理端路由（T2B.6，D19）：独立布局（不套教师端导航）+ 路由守卫
 * （me.isAdmin 否则跳 /t）。页面：概览（含注册开关行）/ 教师管理。
 */
const adminRoutes = (() => {
  const AdminLayout = lazy(() => import("./pages/admin/AdminLayout"));
  const AdminOverviewPage = lazy(
    () => import("./pages/admin/AdminOverviewPage"),
  );
  const AdminTeachersPage = lazy(
    () => import("./pages/admin/AdminTeachersPage"),
  );
  const AdminSharedFilesPage = lazy(
    () => import("./pages/admin/AdminSharedFilesPage"),
  );

  /** 页面级懒加载兜底（与教师端一致） */
  const pageFallback = (
    <p className="p-8 text-sm text-muted-foreground">页面加载中…</p>
  );

  return (
    <Route
      path="/a"
      element={
        <Suspense fallback={<TeacherRouteFallback />}>
          <AdminLayout />
        </Suspense>
      }
    >
      <Route
        index
        element={
          <Suspense fallback={pageFallback}>
            <AdminOverviewPage />
          </Suspense>
        }
      />
      <Route
        path="teachers"
        element={
          <Suspense fallback={pageFallback}>
            <AdminTeachersPage />
          </Suspense>
        }
      />
      <Route
        // T2B.7：共享文件管理（列表/删除任意，含本地文件）
        path="shared-files"
        element={
          <Suspense fallback={pageFallback}>
            <AdminSharedFilesPage />
          </Suspense>
        }
      />
    </Route>
  );
})();

/**
 * 学生端路由（T2.3）：路由级代码分割，登录相关页与学生主布局分块加载。
 * 路由匹配：/s/login、/s/home 等静态段优先于 /s/:token（专属链接令牌为
 * base64url 随机串，不会与保留路径冲突）。
 */
const studentRoutes = (() => {
  const StudentLinkLoginPage = lazy(
    () => import("./pages/student/StudentLinkLoginPage"),
  );
  const StudentLoginPage = lazy(
    () => import("./pages/student/StudentLoginPage"),
  );
  const StudentLayout = lazy(() => import("./pages/student/StudentLayout"));
  const StudentHomePage = lazy(() => import("./pages/student/StudentHomePage"));
  const StudentAssignmentAttemptPage = lazy(
    () => import("./pages/student/StudentAssignmentAttemptPage"),
  );
  const StudentAttemptPage = lazy(
    () => import("./pages/student/StudentAttemptPage"),
  );
  const StudentCourseUnitPage = lazy(
    () => import("./pages/student/StudentCourseUnitPage"),
  );
  const StudentCoursesPage = lazy(
    () => import("./pages/student/StudentCoursesPage"),
  );
  const StudentCourseDetailPage = lazy(
    () => import("./pages/student/StudentCourseDetailPage"),
  );
  const StudentLecturesPage = lazy(
    () => import("./pages/student/StudentLecturesPage"),
  );
  const StudentLectureViewPage = lazy(
    () => import("./pages/student/StudentLectureViewPage"),
  );
  const StudentRecordsPage = lazy(
    () => import("./pages/student/StudentRecordsPage"),
  );

  const pageFallback = (
    <p className="p-8 text-sm text-muted-foreground">页面加载中…</p>
  );

  return (
    <>
      <Route
        path="/s/:token"
        element={
          <Suspense fallback={<StudentRouteFallback />}>
            <StudentLinkLoginPage />
          </Suspense>
        }
      />
      <Route
        path="/s/login"
        element={
          <Suspense fallback={<StudentRouteFallback />}>
            <StudentLoginPage />
          </Suspense>
        }
      />
      <Route
        path="/s"
        element={
          <Suspense fallback={<StudentRouteFallback />}>
            <StudentLayout />
          </Suspense>
        }
      >
        <Route index element={<Navigate to="/s/home" replace />} />
        <Route
          path="home"
          element={
            <Suspense fallback={pageFallback}>
              <StudentHomePage />
            </Suspense>
          }
        />
        <Route
          path="assignments/:id"
          element={
            <Suspense fallback={pageFallback}>
              <StudentAssignmentAttemptPage />
            </Suspense>
          }
        />
        <Route
          path="attempts/:attemptId"
          element={
            <Suspense fallback={pageFallback}>
              <StudentAttemptPage />
            </Suspense>
          }
        />
        <Route
          path="courses"
          element={
            <Suspense fallback={pageFallback}>
              <StudentCoursesPage />
            </Suspense>
          }
        />
        <Route
          path="courses/:id"
          element={
            <Suspense fallback={pageFallback}>
              <StudentCourseDetailPage />
            </Suspense>
          }
        />
        <Route
          path="courses/:id/units/:unitId"
          element={
            <Suspense fallback={pageFallback}>
              <StudentCourseUnitPage />
            </Suspense>
          }
        />
        <Route
          path="lectures"
          element={
            <Suspense fallback={pageFallback}>
              <StudentLecturesPage />
            </Suspense>
          }
        />
        <Route
          path="lectures/:id"
          element={
            <Suspense fallback={pageFallback}>
              <StudentLectureViewPage />
            </Suspense>
          }
        />
        <Route
          path="records"
          element={
            <Suspense fallback={pageFallback}>
              <StudentRecordsPage />
            </Suspense>
          }
        />
      </Route>
    </>
  );
})();

/** 学生端整页加载兜底（懒加载期间） */
function StudentRouteFallback() {
  return (
    <main
      aria-live="polite"
      className="flex min-h-dvh items-center justify-center bg-background"
    >
      <p className="text-sm text-muted-foreground">页面加载中…</p>
    </main>
  );
}

/** 顶层路由。学生端（/s/*，T2.3）与教师端（/t）、管理端（/a，T2B.6）分区扩展 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      {devOnlyRoutes}
      {inkDevRoute}
      {teacherRoutes}
      {studentRoutes}
      {adminRoutes}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
