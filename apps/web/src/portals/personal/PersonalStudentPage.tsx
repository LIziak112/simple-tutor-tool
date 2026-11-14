import { lazy, Suspense } from "react";
import { Navigate, useParams } from "react-router";
import { useStudentMe } from "@/features/auth/student-auth";
import { usePortalRoutes } from "@/features/runtime/portal-runtime";

const StudentPage = lazy(() => import("../../pages/teacher/StudentHomePage"));
/** 管理记录可回到自己的学习档案，不开放班级学生管理入口。 */
export default function PersonalStudentPage() {
  const { id } = useParams();
  const me = useStudentMe();
  const routes = usePortalRoutes();
  if (me.isPending) return <p aria-live="polite">正在加载…</p>;
  if (!me.data || me.data.id !== id)
    return <Navigate to={routes.management("data")} replace />;
  return (
    <Suspense fallback={<p>正在加载…</p>}>
      <StudentPage />
    </Suspense>
  );
}
