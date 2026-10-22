import {
  Bot,
  ChevronDown,
  ChevronRight,
  PenLine,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { StudentPracticePreferenceSection } from "@/features/attempt/StudentPracticePreferenceSection";
import { useStudentMe } from "@/features/auth/student-auth";
import { useInkProfileSelection } from "@/features/ink/ink-profile-store";
import { aiDisplayReturnTo } from "@/features/student-ai/ai-display-return";
import { StudentAiDisplaySection } from "@/features/student-ai/StudentAiDisplaySection";
import { StudentQuickButtonsSection } from "@/features/student-ai/StudentQuickButtonsSection";

/** 学生个人设置；账号守卫和配置绑定由学生布局负责。 */
export default function StudentSettingsPage() {
  const { data: student } = useStudentMe();
  const [params] = useSearchParams();
  const from = aiDisplayReturnTo(params.get("from"));
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === "#ai-display")
      document
        .getElementById("ai-display")
        ?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [hash]);
  const profile = useInkProfileSelection();
  const [quickButtonsDirty, setQuickButtonsDirty] = useState(false);
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-8 pb-8">
      <header className="space-y-2">
        {from && (
          <Link
            to={from}
            className="inline-flex min-h-11 items-center text-sm font-medium text-primary"
          >
            返回本题
          </Link>
        )}
        <h1 className="text-2xl font-semibold tracking-tight">学生设置</h1>
        <p className="text-sm text-muted-foreground">
          管理个人信息、书写偏好和 AI 助教。
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
      <section
        aria-labelledby="student-preferences-title"
        className="space-y-3"
      >
        <h2
          id="student-preferences-title"
          className="text-sm font-medium text-muted-foreground"
        >
          学习偏好
        </h2>
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          <Link
            to="/s/settings/ink-feel"
            className="flex min-h-11 items-center gap-4 rounded-xl p-5 sm:p-6 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span
              aria-hidden
              className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"
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

          {/* M3-D1：做题方式默认偏好（布局 + 快捷键开关，暂存-保存） */}
          <div className="p-5 sm:p-6">
            <StudentPracticePreferenceSection key={student?.id} />
          </div>

          <Link
            to="/s/settings/ai"
            className="flex min-h-11 items-center gap-4 rounded-xl p-5 sm:p-6 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span
              aria-hidden
              className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"
            >
              <Bot className="size-5" />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-medium">连接 AI</p>
              <p className="text-sm text-muted-foreground">
                管理已保存的连接、复制客户端配置或添加新的使用方式。
              </p>
            </div>
            <ChevronRight
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
          </Link>
        </div>
      </section>
      <section aria-labelledby="student-ai-title" className="space-y-3">
        <h2
          id="student-ai-title"
          className="text-sm font-medium text-muted-foreground"
        >
          AI 求助偏好
        </h2>
        <StudentAiDisplaySection key={student?.id} />
        <details className="group rounded-xl border border-border bg-card">
          <summary className="flex min-h-16 cursor-pointer list-none items-center gap-4 rounded-xl p-5 focus-visible:outline-2 focus-visible:outline-ring sm:p-6 [&::-webkit-details-marker]:hidden">
            <SlidersHorizontal
              aria-hidden
              className="size-5 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block font-medium">自定义求助快捷按钮</span>
              {quickButtonsDirty && (
                <span className="block text-xs font-medium text-primary">
                  有未保存更改
                </span>
              )}
              <span className="block text-sm text-muted-foreground">
                调整常用提问和附带材料，修改后保存生效。
              </span>
            </span>
            <ChevronDown
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground group-open:rotate-180"
            />
          </summary>
          <div className="border-t border-border p-4 sm:p-6">
            <StudentQuickButtonsSection onDirtyChange={setQuickButtonsDirty} />
          </div>
        </details>
      </section>
    </div>
  );
}
