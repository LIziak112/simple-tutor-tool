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
  const DataPage = lazy(() => import("./pages/teacher/DataPage"));
  const AttemptDetailPage = lazy(
    () => import("./pages/teacher/AttemptDetailPage"),
  );
  const PendingMarkQueuePage = lazy(
    () => import("./pages/teacher/PendingMarkQueuePage"),
  );
  const InsightsOverviewPage = lazy(
    () => import("./pages/teacher/InsightsOverviewPage"),
  );
  const InsightsStudentPage = lazy(
    () => import("./pages/teacher/InsightsStudentPage"),
  );
  const InsightsQuestionsPage = lazy(
    () => import("./pages/teacher/InsightsQuestionsPage"),
  );
  const ExportPage = lazy(() => import("./pages/teacher/ExportPage"));
  const ConnectPage = lazy(() => import("./pages/teacher/ConnectPage"));

  /** 布局内的懒加载兜底（骨架级提示即可，布局本身很快） */
  const pageFallback = (
    <p className="p-8 text-sm text-muted-foreground">页面加载中…</p>
  );

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
          // T3.1：作答数据页（三视图 + 筛选，侧边栏「数据」入口的落点）
          path="data"
          element={
            <Suspense fallback={pageFallback}>
              <DataPage />
            </Suspense>
          }
        />
        <Route
          // T3.1：作答详情（D7 逐题 + 手写缩略图；draft 亦可用，D5）
          path="data/attempts/:id"
          element={
            <Suspense fallback={pageFallback}>
              <AttemptDetailPage />
            </Suspense>
          }
        />
        <Route
          // T3.2b：待批队列（D4 单题卡片连续批改；数据页头部「待批队列」入口的落点）
          path="data/pending"
          element={
            <Suspense fallback={pageFallback}>
              <PendingMarkQueuePage />
            </Suspense>
          }
        />
        <Route
          // T4.2：学情总览（完成矩阵 + 下节课重点 + 关键计数；侧边栏「学情」落点）
          path="insights"
          element={
            <Suspense fallback={pageFallback}>
              <InsightsOverviewPage />
            </Suspense>
          }
        />
        <Route
          // T4.2：学生画像（趋势/考点条形图/异常题/重做/阅读地图/AI 报告占位）
          path="insights/students/:id"
          element={
            <Suspense fallback={pageFallback}>
              <InsightsStudentPage />
            </Suspense>
          }
        />
        <Route
          // T4.2：题目视角（正确率/用时/高频错误答案；与总览同筛选）
          path="insights/questions"
          element={
            <Suspense fallback={pageFallback}>
              <InsightsQuestionsPage />
            </Suspense>
          }
        />
        <Route
          // T4.4：导出中心（「导出给 AI」五步向导；学情页/画像页入口落点，
          // ?studentId= 预填该生；T4.7 起侧边栏「导出」同指此页）
          path="export"
          element={
            <Suspense fallback={pageFallback}>
              <ExportPage />
            </Suspense>
          }
        />
        <Route
          // T4.7（D26）：连接 AI 说明页——MCP 地址 / Token / 通用与
          // Claude Desktop 配置示例；设置页与侧边栏「连接 AI」入口落点
          path="connect"
          element={
            <Suspense fallback={pageFallback}>
              <ConnectPage />
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
  const StudentWrongQuestionsPage = lazy(
    () => import("./pages/student/StudentWrongQuestionsPage"),
  );
  const StudentQuestionNotebookPage = lazy(
    () => import("./pages/student/StudentQuestionNotebookPage"),
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
        <Route
          // 2026-10 IA 调整：错题本升为一级路由（D11 跨来源聚合；
          // 顶栏导航与首页概览卡的入口落点）
          path="wrong"
          element={
            <Suspense fallback={pageFallback}>
              <StudentWrongQuestionsPage />
            </Suspense>
          }
        />
        <Route
          // 旧路径重定向（书签/历史链接不 404）
          path="records/wrong"
          element={<Navigate to="/s/wrong" replace />}
        />
        <Route
          // T6R.15：题目笔记本（按题聚合跨来源已交卷轮次——原稿/订正/补充稿
          // 历史对照；结果页题卡「本题历史」链接的落点）
          path="notebook/:questionId"
          element={
            <Suspense fallback={pageFallback}>
              <StudentQuestionNotebookPage />
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
