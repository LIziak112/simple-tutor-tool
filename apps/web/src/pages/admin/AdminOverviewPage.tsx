import {
  ClipboardList,
  FileText,
  Loader2,
  TriangleAlert,
  UserRound,
  UserRoundCheck,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useAdminOverview,
  useUpdateAdminSettings,
} from "@/features/admin/admin-queries";
import { formatCnTime } from "@/lib/time";

/**
 * /a 管理端概览（T2B.6，D20）：只显示聚合计数——教师数/未禁用教师数/学生总数/
 * 作答总数/共享文件数 + 注册开关行（就地切换，§4.3 设置区显示当前注册状态）。
 * 三态齐全；卡片为纯展示，无任何明细（管理员没有业务数据权限，D19）。
 */
export function AdminOverviewPage() {
  const overviewQuery = useAdminOverview();
  const updateSettings = useUpdateAdminSettings();

  if (overviewQuery.isPending) {
    return (
      <section
        role="status"
        aria-label="正在加载概览"
        className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8"
      >
        <h1 className="text-xl font-semibold">概览</h1>
        <div className="h-40 animate-pulse rounded-xl border border-border bg-muted/50" />
        <p className="text-sm text-muted-foreground">正在加载概览…</p>
      </section>
    );
  }
  if (overviewQuery.isError) {
    return (
      <section className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            概览加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {overviewQuery.error instanceof Error
              ? overviewQuery.error.message
              : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void overviewQuery.refetch()}
          >
            重试
          </Button>
        </div>
      </section>
    );
  }

  const data = overviewQuery.data;
  const cards = [
    {
      icon: UserRound,
      label: "教师",
      value: `${data.teacherCount} 人`,
      hint: `未禁用 ${data.activeTeacherCount} 人`,
    },
    {
      icon: Users,
      label: "学生总数",
      value: `${data.studentCount} 人`,
      hint: "全体教师合计",
    },
    {
      icon: ClipboardList,
      label: "作答总数",
      value: `${data.attemptCount} 份`,
      hint: "全体学生合计",
    },
    {
      icon: FileText,
      label: "共享文件",
      value: `${data.sharedFileCount} 个`,
      hint: "共享目录内的 .md 文件",
    },
  ] as const;

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header>
        <h1 className="text-xl font-semibold">概览</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          系统规模一览（{formatCnTime(new Date().toISOString())}，北京时间）。
          管理端只管账号与注册开关，不涉及任何老师的题库、课程与学生数据。
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4 text-card-foreground"
          >
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <card.icon aria-hidden className="size-3.5" />
              {card.label}
            </p>
            <p className="text-2xl font-semibold tabular-nums">{card.value}</p>
            <p className="text-xs text-muted-foreground">{card.hint}</p>
          </div>
        ))}
      </div>

      {/* 注册开关行（§4.3 就地切换；§4.1 影响先说清） */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <UserRoundCheck aria-hidden className="size-4" />
            教师自助注册
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            当前状态：
            <span
              data-testid="registration-state"
              className={
                data.registrationOpen
                  ? "font-medium text-primary"
                  : "font-medium text-muted-foreground"
              }
            >
              {data.registrationOpen ? "开放中" : "已关闭"}
            </span>
            。关闭后登录页不再显示注册入口，注册页提示已关闭；已注册老师不受影响。
          </p>
        </div>
        <Button
          variant={data.registrationOpen ? "outline" : "default"}
          className="min-h-11 px-4"
          disabled={updateSettings.isPending}
          aria-pressed={data.registrationOpen}
          onClick={() =>
            updateSettings.mutate({
              allowRegistration: !data.registrationOpen,
            })
          }
        >
          {updateSettings.isPending ? (
            <>
              <Loader2 aria-hidden className="animate-spin" />
              正在切换…
            </>
          ) : data.registrationOpen ? (
            "关闭注册"
          ) : (
            "开放注册"
          )}
        </Button>
      </div>

      {updateSettings.isError && (
        <p role="alert" className="text-sm text-destructive">
          {updateSettings.error instanceof Error
            ? updateSettings.error.message
            : "切换失败，请稍后重试"}
        </p>
      )}
    </section>
  );
}

// 供 App.tsx 路由级懒加载
export default AdminOverviewPage;
