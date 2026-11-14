import { lazy, Suspense } from "react";
import { Navigate, Route } from "react-router";

const InkFeelPage = lazy(() => import("../../pages/InkFeelPage"));
function StudentRouteFallback() {
  return <p aria-live="polite">页面加载中…</p>;
}
const PersonalStudentPage = lazy(() => import("./PersonalStudentPage"));
export const personalRoutes = (() => {
  const PersonalLoginPage = lazy(
    () => import("../../pages/personal/PersonalLoginPage"),
  );
  const PersonalRegisterPage = lazy(
    () => import("../../pages/personal/PersonalRegisterPage"),
  );
  const PersonalLayout = lazy(
    () => import("../../portals/personal/PersonalLayout"),
  );
  const PersonalStudentHomePage = lazy(
    () => import("../../pages/student/StudentHomePage"),
  );
  const PersonalStudentSettingsPage = lazy(
    () => import("../../pages/student/StudentSettingsPage"),
  );
  const PersonalStudentAiConnectionPage = lazy(
    () => import("../../pages/student/StudentAiConnectionPage"),
  );
  const PersonalStudentAttemptPage = lazy(
    () => import("../../pages/student/StudentAttemptPage"),
  );
  const PersonalStudentCoursesPage = lazy(
    () => import("../../pages/student/StudentCoursesPage"),
  );
  const PersonalStudentCourseDetailPage = lazy(
    () => import("../../pages/student/StudentCourseDetailPage"),
  );
  const PersonalStudentCourseUnitPage = lazy(
    () => import("../../pages/student/StudentCourseUnitPage"),
  );
  const PersonalStudentLecturesPage = lazy(
    () => import("../../pages/student/StudentLecturesPage"),
  );
  const PersonalStudentLectureViewPage = lazy(
    () => import("../../pages/student/StudentLectureViewPage"),
  );
  const PersonalStudentLessonLandingPage = lazy(
    () => import("../../pages/student/StudentLessonLandingPage"),
  );
  const PersonalStudentLessonPage = lazy(
    () => import("../../pages/student/StudentLessonPage"),
  );
  const PersonalStudentRecordsPage = lazy(
    () => import("../../pages/student/StudentRecordsPage"),
  );
  const PersonalStudentWrongQuestionsPage = lazy(
    () => import("../../pages/student/StudentWrongQuestionsPage"),
  );
  const PersonalStudentMemosPage = lazy(
    () => import("../../pages/student/StudentMemosPage"),
  );
  const PersonalStudentQuestionNotebookPage = lazy(
    () => import("../../pages/student/StudentQuestionNotebookPage"),
  );
  const PersonalLibraryPage = lazy(
    () => import("../../pages/teacher/LibraryPage"),
  );
  const PersonalSharedPage = lazy(
    () => import("../../pages/teacher/SharedPage"),
  );
  const PersonalImportPage = lazy(
    () => import("../../pages/teacher/ImportPage"),
  );
  const PersonalCoursesPage = lazy(
    () => import("../../pages/teacher/CoursesPage"),
  );
  const PersonalCourseEditPage = lazy(
    () => import("../../pages/teacher/CourseEditPage"),
  );
  const PersonalDataPage = lazy(() => import("../../pages/teacher/DataPage"));
  const PersonalAttemptDetailPage = lazy(
    () => import("../../pages/teacher/AttemptDetailPage"),
  );
  const PersonalPendingMarkQueuePage = lazy(
    () => import("../../pages/teacher/PendingMarkQueuePage"),
  );
  const PersonalInsightsOverviewPage = lazy(
    () => import("../../pages/teacher/InsightsOverviewPage"),
  );
  const PersonalInsightsQuestionsPage = lazy(
    () => import("../../pages/teacher/InsightsQuestionsPage"),
  );
  const PersonalExportPage = lazy(
    () => import("../../pages/teacher/ExportPage"),
  );
  const PersonalConnectPage = lazy(() =>
    import("../../pages/teacher/ConnectPage").then((module) => ({
      default: module.ConnectPage,
    })),
  );
  const PersonalSettingsPage = lazy(
    () => import("../../pages/teacher/SettingsPage"),
  );
  return (
    <>
      <Route
        path="/p/login"
        element={
          <Suspense fallback={<StudentRouteFallback />}>
            <PersonalLoginPage />
          </Suspense>
        }
      />
      <Route
        path="/p/register"
        element={
          <Suspense fallback={<StudentRouteFallback />}>
            <PersonalRegisterPage />
          </Suspense>
        }
      />
      <Route
        path="/p/learn"
        element={
          <Suspense fallback={<StudentRouteFallback />}>
            <PersonalLayout />
          </Suspense>
        }
      >
        <Route index element={<Navigate to="/p/learn/home" replace />} />
        <Route
          path="home"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentHomePage />
            </Suspense>
          }
        />
        <Route
          path="settings"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentSettingsPage />
            </Suspense>
          }
        />
        <Route
          path="settings/ai"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentAiConnectionPage />
            </Suspense>
          }
        />
        <Route
          path="attempts/:attemptId"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentAttemptPage />
            </Suspense>
          }
        />
        <Route
          path="courses"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentCoursesPage />
            </Suspense>
          }
        />
        <Route
          path="courses/:id"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentCourseDetailPage />
            </Suspense>
          }
        />
        <Route
          path="courses/:id/units/:unitId"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentCourseUnitPage />
            </Suspense>
          }
        />
        <Route
          path="lectures"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentLecturesPage />
            </Suspense>
          }
        />
        <Route
          path="lectures/:id"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentLectureViewPage />
            </Suspense>
          }
        />
        <Route
          path="lectures/:id/lesson"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentLessonLandingPage />
            </Suspense>
          }
        />
        <Route
          path="lectures/:id/lesson/run"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentLessonPage />
            </Suspense>
          }
        />
        <Route
          path="records"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentRecordsPage />
            </Suspense>
          }
        />
        <Route
          path="wrong"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentWrongQuestionsPage />
            </Suspense>
          }
        />
        <Route
          path="memos"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentMemosPage />
            </Suspense>
          }
        />
        <Route
          path="notebook/:questionId"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalStudentQuestionNotebookPage />
            </Suspense>
          }
        />
        <Route
          path="settings/ink-feel"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <InkFeelPage embedded />
            </Suspense>
          }
        />
        <Route
          path="records/wrong"
          element={<Navigate to="/p/learn/wrong" replace />}
        />
      </Route>
      <Route
        path="/p/manage"
        element={
          <Suspense fallback={<StudentRouteFallback />}>
            <PersonalLayout />
          </Suspense>
        }
      >
        <Route index element={<Navigate to="/p/manage/library" replace />} />
        <Route
          path="library"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalLibraryPage />
            </Suspense>
          }
        />
        <Route
          path="shared"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalSharedPage />
            </Suspense>
          }
        />
        <Route
          path="import"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalImportPage />
            </Suspense>
          }
        />
        <Route
          path="courses"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalCoursesPage />
            </Suspense>
          }
        />
        <Route
          path="courses/:id"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalCourseEditPage />
            </Suspense>
          }
        />
        <Route
          path="data"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalDataPage />
            </Suspense>
          }
        />
        <Route
          path="data/attempts/:id"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalAttemptDetailPage />
            </Suspense>
          }
        />
        <Route
          path="data/pending"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalPendingMarkQueuePage />
            </Suspense>
          }
        />
        <Route
          path="insights"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalInsightsOverviewPage />
            </Suspense>
          }
        />
        <Route
          path="insights/questions"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalInsightsQuestionsPage />
            </Suspense>
          }
        />
        <Route
          path="export"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalExportPage />
            </Suspense>
          }
        />
        <Route
          path="settings"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalSettingsPage />
            </Suspense>
          }
        />
        <Route
          path="connect"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <PersonalConnectPage />
            </Suspense>
          }
        />
        <Route path="students/:id" element={<PersonalStudentPage />} />
        <Route
          path="ink-feel"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <InkFeelPage embedded />
            </Suspense>
          }
        />
        <Route
          path="settings/ink-feel"
          element={
            <Suspense fallback={<StudentRouteFallback />}>
              <InkFeelPage embedded />
            </Suspense>
          }
        />
      </Route>
    </>
  );
})();
