import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Loader2,
  LogOut,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  teacherMeKey,
  useLogoutTeacher,
  useTeacherMe,
} from "@/features/auth/teacher-auth";
import { teacherAiPromptsDraftKey } from "@/features/student-ai/ai-prompt-queries";
import { TeacherAiSettingsPanel } from "@/features/student-ai/TeacherAiSettingsPanel";
import { BackupSection } from "@/features/teacher-backup/BackupSection";
import { CapabilityProfileSection } from "@/features/teacher-settings/CapabilityProfileSection";
import { PracticeFeedbackSection } from "@/features/teacher-settings/PracticeFeedbackSection";
import { useSettingsNavigation } from "@/features/teacher-settings/settings-navigation";
import { BRAND_NAME, BRAND_TAGLINE } from "@/lib/brand";
import { formatCnTime } from "@/lib/time";
import { AuthScreenLoading } from "./SetupPage";

const SECTIONS = [
  { id: "teaching", label: "学生作答方式", shortLabel: "作答方式" },
  { id: "ai", label: "AI 设置", shortLabel: "AI 设置" },
  { id: "backup", label: "备份与恢复", shortLabel: "备份恢复" },
  { id: "account", label: "账号与会话", shortLabel: "账号会话" },
] as const;

/** 分类写入 URL；配置控制器持续挂载，切换时保留未保存状态。 */
export function SettingsPage() {
  const meQuery = useTeacherMe();
  const logoutMutation = useLogoutTeacher();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const settingsNavigation = useSettingsNavigation();
  const [searchParams] = useSearchParams();
  const activeSection =
    SECTIONS.find((section) => section.id === searchParams.get("section"))
      ?.id ?? "teaching";
  if (meQuery.isPending) return <AuthScreenLoading text="正在加载设置…" />;
  if (meQuery.isError || !meQuery.data)
    return <Navigate to="/t/login" replace />;
  function handleLogout() {
    const action = () =>
      logoutMutation.mutate(undefined, {
        onSuccess: () => {
          queryClient.removeQueries({
            queryKey: ["teacher", "capability-draft"],
          });
          queryClient.removeQueries({
            queryKey: ["teacher", "ai-settings-draft"],
          });
          queryClient.removeQueries({
            queryKey: ["teacher", "practice-feedback-draft"],
          });
          queryClient.removeQueries({ queryKey: teacherAiPromptsDraftKey });
          void queryClient.invalidateQueries({ queryKey: teacherMeKey });
          navigate("/t/login", { replace: true });
        },
      });
    if (settingsNavigation) settingsNavigation.leave(action);
    else action();
  }
  return (
    <section className="teacher-config-page">
      <header className="mb-7">
        <h1 className="teacher-page-title">设置</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          为你的课堂选择合适的作答方式，并管理数据与账号。
        </p>
      </header>
      <nav
        aria-label="设置分类"
        className="mb-7 flex flex-wrap gap-x-7 border-b border-border"
      >
        {SECTIONS.map(({ id, label, shortLabel }) => (
          <Link
            key={id}
            to={`/t/settings?section=${id}`}
            aria-label={label}
            aria-current={activeSection === id ? "page" : undefined}
            className="teacher-settings-link"
          >
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{shortLabel}</span>
          </Link>
        ))}
      </nav>
      <div hidden={activeSection !== "teaching"}>
        <CapabilityProfileSection
          key={`capability:${meQuery.data.id}`}
          teacherId={meQuery.data.id}
        />
        <PracticeFeedbackSection
          key={`practice-feedback:${meQuery.data.id}`}
          teacherId={meQuery.data.id}
        />
      </div>
      <div hidden={activeSection !== "ai"}>
        <TeacherAiSettingsPanel />
        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
          <div>
            <h2 className="text-sm font-semibold">让 AI 参与备课</h2>
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">
              连接你的 AI 客户端，读取学情并导入练习。
            </p>
          </div>
          <Link
            to="/t/connect"
            className="flex min-h-11 items-center gap-2 text-sm font-medium text-primary"
          >
            管理 AI 连接
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      </div>
      <div hidden={activeSection !== "backup"}>
        <BackupSection />
      </div>
      <div hidden={activeSection !== "account"} className="space-y-7">
        <section>
          <h2 className="text-lg font-semibold">教师账号</h2>
          <dl className="mt-4 divide-y divide-border rounded-xl border border-border bg-card px-6 text-sm">
            <div className="flex flex-wrap justify-between gap-3 py-5">
              <dt className="text-muted-foreground">登录名</dt>
              <dd className="min-w-0 break-all font-medium">
                {meQuery.data.loginName}
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-3 py-5">
              <dt className="text-muted-foreground">创建时间</dt>
              <dd className="tabular-nums">
                {formatCnTime(meQuery.data.createdAt)}
              </dd>
            </div>
          </dl>
          {meQuery.data.isAdmin && (
            <Link
              to="/a"
              className="mt-3 flex min-h-11 items-center gap-2 text-sm font-medium text-primary"
            >
              <ShieldCheck aria-hidden className="size-4" />
              系统管理
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          )}
        </section>
        <section>
          <h2 className="text-lg font-semibold">登录会话</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            退出后需要重新登录，才能继续使用教师工作台。
          </p>
          {logoutMutation.isError && (
            <p
              role="alert"
              className="mt-3 flex items-start gap-2 text-sm text-destructive"
            >
              <TriangleAlert aria-hidden className="size-4 shrink-0" />
              {logoutMutation.error instanceof Error
                ? logoutMutation.error.message
                : "退出失败"}
              ，请重试。
            </p>
          )}
          <Button
            variant="outline"
            className="mt-4 min-h-11"
            disabled={logoutMutation.isPending}
            onClick={handleLogout}
          >
            {logoutMutation.isPending ? (
              <>
                <Loader2 aria-hidden className="motion-safe:animate-spin" />
                正在退出…
              </>
            ) : (
              <>
                <LogOut aria-hidden />
                退出登录
              </>
            )}
          </Button>
        </section>
        <footer className="flex flex-wrap justify-between gap-3 border-t border-border pt-5 text-sm">
          <span className="font-semibold">{BRAND_NAME}</span>
          <span lang="en" className="text-xs text-muted-foreground">
            {BRAND_TAGLINE}
          </span>
        </footer>
      </div>
    </section>
  );
}
export default SettingsPage;
