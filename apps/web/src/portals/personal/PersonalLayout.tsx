import type { StudentMeData, TeacherInfo } from "@tutor/contract";
import { type ReactNode, useEffect, useState } from "react";
import {
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router";
import { PersonalViewButton } from "@/features/auth/PersonalViewButton";
import { PortalGuard } from "@/features/auth/PortalGuard";
import { useLogoutPersonal } from "@/features/auth/personal-auth";
import { useStudentMe } from "@/features/auth/student-auth";
import {
  useApplyPersonalAuthed,
  useTeacherMe,
} from "@/features/auth/teacher-auth";
import { usePersonalPair } from "@/features/auth/use-personal-pair";
import { useBindInkProfiles } from "@/features/ink/use-ink-profiles";
import { LearningContextEnvironment } from "@/features/learning-context/LearningContextEnvironment";
import { MemoQuickCapture } from "@/features/memos/MemoQuickCapture";
import { QuestionMemoCaptureProvider } from "@/features/memos/QuestionMemoCapture";
import { usePortalRuntime } from "@/features/runtime/portal-runtime";
import { StudentWorkspaceContext } from "@/features/student/student-workspace-layout";
import { useLearnerBindings } from "@/features/student/use-learner-bindings";
import { useStudentTheme } from "@/features/student/use-student-theme";
import { AiQueueButton } from "@/features/student-ai/AiQueueButton";
import {
  SettingsNavigationProvider,
  useSettingsNavigation,
} from "@/features/teacher-settings/settings-navigation";

function PersonalLearningFrame({
  me,
  workspace,
  setWorkspace,
  children,
}: {
  me: StudentMeData;
  workspace: boolean;
  setWorkspace: (active: boolean) => void;
  children: ReactNode;
}) {
  useLearnerBindings(me);
  useStudentTheme();
  return (
    <LearningContextEnvironment principal={me.id}>
      <QuestionMemoCaptureProvider>
        <StudentWorkspaceContext.Provider value={setWorkspace}>
          <div
            className={
              workspace
                ? "mx-auto w-full max-w-[1120px] px-3"
                : "mx-auto w-full max-w-5xl px-4 py-6"
            }
          >
            {children}
          </div>
          {!workspace && <MemoQuickCapture />}
        </StudentWorkspaceContext.Provider>
      </QuestionMemoCaptureProvider>
    </LearningContextEnvironment>
  );
}
function ManagementFrame({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  useBindInkProfiles("teacher", id);
  return <div className="mx-auto w-full max-w-7xl px-4 py-6">{children}</div>;
}
/** 独立个人门户：双会话核验只写既有角色缓存，不嵌入班级教师布局。 */
export default function PersonalLayout() {
  const { view } = usePortalRuntime();
  return view === "management" ? (
    <SettingsNavigationProvider>
      <PersonalLayoutContent />
    </SettingsNavigationProvider>
  ) : (
    <PersonalLayoutContent />
  );
}
function PersonalLayoutContent() {
  const settingsNavigation = useSettingsNavigation();
  const leave = (action: () => void) =>
    settingsNavigation ? settingsNavigation.leave(action) : action();
  const [workspace, setWorkspace] = useState(false);
  const { view, routes, subject } = usePortalRuntime();
  const role = view === "learning" ? "student" : "teacher";
  const student = useStudentMe();
  const teacher = useTeacherMe();
  const apply = useApplyPersonalAuthed();
  const navigate = useNavigate();
  const location = useLocation();
  const key = subject ? `${role}:${subject.id}` : null;
  const verification = usePersonalPair(
    role,
    subject?.id ?? null,
    async (pair, operation) => {
      if (
        student.data?.id !== pair.student.id ||
        teacher.data?.id !== pair.teacher.id
      ) {
        const committed = await apply(pair, operation);
        committed.assertCurrent();
      }
    },
  );
  const logout = useLogoutPersonal(role, () =>
    navigate(
      `${routes.portal("personal").loginPath}?${new URLSearchParams({ returnTo: location.pathname + location.search + location.hash })}`,
      { replace: true },
    ),
  );
  const loginTarget = `${routes.portal("personal").loginPath}?${new URLSearchParams({ returnTo: location.pathname + location.search + location.hash })}`;
  useEffect(() => {
    if (verification.status === "login")
      verification.consumeLogin(() => navigate(loginTarget, { replace: true }));
  }, [verification.status, verification.consumeLogin, navigate, loginTarget]);
  const me = role === "student" ? student.data : teacher.data;
  if (
    (student.isError && role === "student") ||
    (teacher.isError && role === "teacher")
  )
    return (
      <PortalGuard<StudentMeData | TeacherInfo>
        portal="personal"
        query={role === "student" ? student : teacher}
      >
        {() => null}
      </PortalGuard>
    );
  if (verification.status === "error")
    return (
      <main role="alert">
        <p>{verification.error?.message}</p>
        <button type="button" onClick={verification.retry}>
          重试
        </button>
      </main>
    );
  if (!me || verification.status !== "verified")
    return <main aria-live="polite">正在核验个人学习会话…</main>;
  if (me.accountKind !== "personal")
    return <Navigate to={routes.portal("personal").loginPath} replace />;
  const links =
    view === "learning"
      ? [
          ["home", "首页"],
          ["courses", "课程"],
          ["wrong", "错题本"],
          ["records", "我的记录"],
          ["memos", "随笔"],
          ["settings", "设置"],
        ]
      : [
          ["library", "资源库"],
          ["shared", "共享资源"],
          ["courses", "课程"],
          ["data", "作答记录"],
          ["export", "导出中心"],
          ["settings", "设置"],
        ];
  const address = view === "learning" ? routes.learning : routes.management;
  const content = <Outlet key={key} />;
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      {!(view === "learning" && workspace) && (
        <header className="border-b p-3">
          <div className="flex flex-wrap items-center gap-3">
            <NavLink to={routes.learning("home")} className="font-semibold">
              个人学习空间
            </NavLink>
            <NavLink
              to={
                view === "learning"
                  ? routes.learning("settings")
                  : routes.management("settings")
              }
              aria-label={
                "displayName" in me
                  ? `${me.displayName}，学生设置`
                  : "个人管理设置"
              }
            >
              {"displayName" in me ? me.displayName : me.loginName}
            </NavLink>
            {view === "learning" && <AiQueueButton />}
            <PersonalViewButton
              from={role}
              beforeAction={leave}
              aria-label={
                view === "learning" ? "切换到管理视角" : "切换到学习视角"
              }
              to={
                view === "learning"
                  ? routes.management("library")
                  : routes.learning("home")
              }
              className="min-h-11 px-3"
            >
              {view === "learning" ? "管理视角" : "学习视角"}
            </PersonalViewButton>
            <button
              type="button"
              className="min-h-11 px-3"
              onClick={() => leave(() => logout.mutate())}
              disabled={logout.isPending}
            >
              退出登录
            </button>
          </div>
          <nav
            aria-label={view === "learning" ? "个人学习导航" : "个人管理导航"}
            className="flex flex-wrap gap-2"
          >
            {links.map(([path, label]) => (
              <NavLink
                key={path}
                to={address(path ?? "")}
                className="min-h-11 px-3 py-3"
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </header>
      )}
      {logout.isError && <p role="alert">{logout.error.message}</p>}
      <main id="personal-main" className="flex-1">
        {view === "learning" && student.data ? (
          <PersonalLearningFrame
            me={student.data}
            workspace={workspace}
            setWorkspace={setWorkspace}
          >
            {content}
          </PersonalLearningFrame>
        ) : (
          <ManagementFrame id={teacher.data?.id ?? ""}>
            {content}
          </ManagementFrame>
        )}
      </main>
    </div>
  );
}
