import { Bot, ChevronRight, PenLine, UserRound } from "lucide-react";
import { Link } from "react-router";
import { useStudentMe } from "@/features/auth/student-auth";
import { useInkProfileSelection } from "@/features/ink/ink-profile-store";
import { StudentQuickButtonsSection } from "@/features/student-ai/StudentQuickButtonsSection";

/** 学生个人设置；账号守卫和配置绑定由学生布局负责。 */
export default function StudentSettingsPage() {
  const { data: student } = useStudentMe();
  const profile = useInkProfileSelection();
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">学生设置</h1>
        <p className="text-sm text-muted-foreground">
          查看个人信息，调整适合自己的书写手感。
        </p>
      </header>
      <section aria-labelledby="student-account-title" className="space-y-3">
        <h2
          id="student-account-title"
          className="text-sm font-medium text-muted-foreground"
        >
          个人信息
        </h2>
        <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-5">
          <span
            aria-hidden
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary"
          >
            {student?.displayName.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="break-words font-semibold">{student?.displayName}</p>
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              <UserRound aria-hidden className="size-3.5 shrink-0" />
              <span className="break-all">{student?.loginName}</span>
            </p>
          </div>
        </div>
      </section>
      <section aria-labelledby="student-writing-title" className="space-y-3">
        <h2
          id="student-writing-title"
          className="text-sm font-medium text-muted-foreground"
        >
          书写
        </h2>
        <Link
          to="/s/settings/ink-feel"
          className="flex min-h-11 items-center gap-4 rounded-xl border border-border bg-card p-5 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span
            aria-hidden
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
          >
            <PenLine className="size-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium">手写手感</p>
            <p className="text-sm text-muted-foreground">
              试写、调整并保存配置，草稿和答题自动沿用。
            </p>
            <p className="break-words text-xs text-muted-foreground">
              本设备正在使用：{profile.name}
            </p>
          </div>
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        </Link>
      </section>
      {/* SAI-18：连接 AI 入口(子页管理批准端点/Key/默认通道) */}
      <section aria-labelledby="student-ai-connection-title" className="space-y-3">
        <h2
          id="student-ai-connection-title"
          className="text-sm font-medium text-muted-foreground"
        >
          AI 服务
        </h2>
        <Link
          to="/s/settings/ai"
          className="flex min-h-11 items-center gap-4 rounded-xl border border-border bg-card p-5 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span
            aria-hidden
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
          >
            <Bot className="size-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium">连接 AI</p>
            <p className="text-sm text-muted-foreground">
              配置求助时使用的 AI 服务、测试连接并选择默认通道。
            </p>
          </div>
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        </Link>
      </section>
      {/* SAI-08：AI 求助快捷按钮管理（草稿暂存于 queryClient，离开页面不丢） */}
      <section aria-labelledby="student-ai-title" className="space-y-3">
        <h2
          id="student-ai-title"
          className="text-sm font-medium text-muted-foreground"
        >
          AI 求助
        </h2>
        <StudentQuickButtonsSection />
      </section>
    </div>
  );
}
