import type {
  AssignmentStatus,
  StudentAssignment,
  StudentCourseSummary,
} from "@tutor/contract";
import { cn } from "cn";
import {
  ArrowRight,
  CalendarClock,
  ChevronRight,
  ClipboardList,
  School,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { formatDueTime } from "@/lib/time";

/**
 * 学生端共享展示组件（T2.3；2026-10 UI 打磨：统一卡片风格、页头、空态）。
 * 学生端面向中小学生：字号偏大、触控目标 ≥44px、文案直白。
 */

/** 完成状态 → 徽章文案与配色（§5.8 完成矩阵四态；数据源见 studentAssignmentSchema） */
const STATUS_META: Record<
  AssignmentStatus,
  { label: string; className: string }
> = {
  not_started: { label: "未开始", className: "bg-muted text-muted-foreground" },
  in_progress: {
    label: "进行中",
    className: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  },
  submitted: {
    label: "已交卷",
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  },
  graded: {
    label: "已批改",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  },
};

/** 完成状态徽章（小标签，非触控目标，信息展示用） */
export function AssignmentStatusBadge({
  status,
}: {
  status: AssignmentStatus;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

/** 作业是否还要做（未开始 / 进行中） */
export function isAssignmentTodo(status: AssignmentStatus): boolean {
  return status === "not_started" || status === "in_progress";
}

/** 截止紧迫度：overdue=已过截止、soon=48 小时内截止、normal=其他 */
function dueUrgencyOf(dueAt: string, now: Date): "overdue" | "soon" | "normal" {
  const left = Date.parse(dueAt) - now.getTime();
  if (left < 0) return "overdue";
  if (left < 48 * 3_600_000) return "soon";
  return "normal";
}

/**
 * 截止时间展示：北京时间「10月1日 20:00 截止」/ 未设置时「不限截止」。
 * highlight=true（作业还没做完）时按紧迫度上色：48 小时内琥珀、已过期红色。
 */
export function AssignmentDueLabel({
  dueAt,
  highlight = false,
  now = new Date(),
}: {
  dueAt: string | null;
  highlight?: boolean;
  now?: Date;
}) {
  if (dueAt === null) {
    return <span className="text-xs text-muted-foreground">不限截止</span>;
  }
  const urgency = highlight ? dueUrgencyOf(dueAt, now) : "normal";
  return (
    <span
      className={cn(
        "flex items-center gap-1 text-xs",
        urgency === "overdue" && "font-medium text-red-600 dark:text-red-400",
        urgency === "soon" && "font-medium text-amber-600 dark:text-amber-400",
        urgency === "normal" && "text-muted-foreground",
      )}
    >
      <CalendarClock aria-hidden className="size-3.5 shrink-0" />
      <span>{formatDueTime(dueAt)} 截止</span>
      {urgency === "soon" && <span>· 快到了</span>}
      {urgency === "overdue" && <span>· 已过截止</span>}
    </span>
  );
}

/** 作业状态 → 答题入口文案（T2.6 起可进入答题页） */
const ENTRY_LABEL: Record<AssignmentStatus, string> = {
  not_started: "开始练习",
  in_progress: "继续作答",
  submitted: "查看结果",
  graded: "查看结果",
};

/** 卡片左侧状态色条（还要做的作业用主色强调，做完的淡化） */
const STATUS_ACCENT: Record<AssignmentStatus, string> = {
  not_started: "before:bg-primary",
  in_progress: "before:bg-sky-500",
  submitted: "before:bg-emerald-400",
  graded: "before:bg-amber-400",
};

/**
 * 「我的作业」卡片（T2A.7 多单元化；2026-10 UI 打磨：左侧状态色条、
 * 还要做的作业入口用实心主按钮，做完的用描边按钮）。
 * 单元行：1 个单元显示该单元标题；多个单元显示「n 个单元」并列出各单元标题。
 * T2.6 起入口打通：点击进入 /s/assignments/:id（自动创建/取回 attempt，
 * 未开始与进行中都进答题视图，已交/已批进结果视图）。
 */
export function StudentAssignmentCard({
  assignment,
}: {
  assignment: StudentAssignment;
}) {
  const unitNames = assignment.units.map((unit) => unit.title);
  const todo = isAssignmentTodo(assignment.status);
  return (
    <li
      className={cn(
        "relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-card p-4 pl-5 text-card-foreground shadow-xs",
        "before:absolute before:inset-y-0 before:left-0 before:w-1.5",
        STATUS_ACCENT[assignment.status],
      )}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-base font-semibold break-words">
            {assignment.title}
          </p>
          <AssignmentStatusBadge status={assignment.status} />
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {unitNames.length > 1 ? (
            <span>
              {assignment.unitCount} 个单元（{unitNames.join("、")}）
            </span>
          ) : (
            <span>单元：{unitNames[0] ?? "（内容整理中）"}</span>
          )}
          <span>共 {assignment.questionCount} 题</span>
        </p>
        <AssignmentDueLabel dueAt={assignment.dueAt} highlight={todo} />
      </div>
      <Button
        asChild
        variant={todo ? "default" : "outline"}
        className="min-h-11 text-sm"
      >
        <Link to={`/s/assignments/${assignment.id}`}>
          {ENTRY_LABEL[assignment.status]}
        </Link>
      </Button>
    </li>
  );
}

/** 页面标题区（图标方块 + 标题 + 可选说明；右侧可放操作） */
export function StudentPageHeader({
  icon,
  title,
  titleId,
  description,
  actions,
}: {
  icon: ReactNode;
  title: string;
  /** h1 的 id（区块 aria-labelledby 用） */
  titleId?: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary [&_svg]:size-5"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <h1 id={titleId} className="text-xl font-semibold">
            {title}
          </h1>
          {description !== undefined && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      {actions}
    </header>
  );
}

/** 空态卡片（图标 + 标题 + 解释 + 可选下一步动作） */
export function StudentEmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** 紧凑形态（首页侧栏等小区块） */
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card px-6 text-center",
        compact ? "py-8" : "py-14",
      )}
    >
      {icon !== undefined && (
        <span
          aria-hidden
          className="mb-1 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6"
        >
          {icon}
        </span>
      )}
      <p className="text-sm font-medium">{title}</p>
      {description !== undefined && (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** 三态兜底：加载骨架（若干卡片占位，不白屏）。占位行数量静态、顺序无关，位置 key 安全 */
const SKELETON_ROWS = [0, 1, 2] as const;

export function StudentListSkeleton({
  label,
  rows = 3,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3">
      {SKELETON_ROWS.slice(0, rows).map((row) => (
        <div
          key={row}
          className="h-28 animate-pulse rounded-2xl border border-border bg-muted/60"
        />
      ))}
      <p className="text-sm text-muted-foreground">{label}…</p>
    </div>
  );
}

/** 三态兜底：错误态（原因 + 重试，触控目标 ≥44px） */
export function StudentErrorPanel({
  title,
  message,
  onRetry,
  className,
}: {
  title: string;
  message: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-card p-5 dark:border-red-500/30",
        className,
      )}
    >
      <p className="text-sm font-medium text-destructive">{title}</p>
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" className="min-h-11" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

/**
 * 「我的课程」卡片（T2A.5，首页与 /s/courses 共用）：课程名/简介 + 可见讲义与
 * 练习计数 + 完成进度条。无可见练习时显示「练习即将开放」代替 0/0 进度。
 * 整卡为触控目标 ≥44px 的链接。
 */
export function StudentCourseCard({
  course,
}: {
  course: StudentCourseSummary;
}) {
  const { completedUnitCount, visibleUnitCount } = course;
  const percent =
    visibleUnitCount > 0
      ? Math.round((completedUnitCount / visibleUnitCount) * 100)
      : 0;
  return (
    <li>
      <Link
        to={`/s/courses/${course.id}`}
        aria-label={`打开课程 ${course.name}`}
        className="group flex min-h-14 items-start gap-3 rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-xs outline-none transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
        >
          <School className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-base font-semibold">
              {course.name}
            </p>
            <ChevronRight
              aria-hidden
              className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
            />
          </div>
          {course.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {course.description}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {course.visibleLectureCount} 篇讲义 · {course.visibleUnitCount}{" "}
            个练习
          </p>
          {visibleUnitCount > 0 ? (
            <div className="flex items-center gap-2">
              <div
                role="progressbar"
                aria-label={`${course.name} 的练习进度`}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {completedUnitCount}/{visibleUnitCount}
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">练习即将开放</p>
          )}
        </div>
      </Link>
    </li>
  );
}

/** 首页「去看看」类次级入口链接（文字 + 箭头，触控 ≥44px） */
export function StudentSectionLink({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-primary outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {children}
      <ArrowRight aria-hidden className="size-4 shrink-0" />
    </Link>
  );
}

/** 首页分区标题（图标 + 标题 + 可选计数 + 右侧入口） */
export function StudentSectionTitle({
  id,
  icon,
  title,
  count,
  action,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex min-h-11 items-center justify-between gap-2">
      <h2
        id={id}
        className="flex items-center gap-2 text-base font-semibold [&_svg]:size-5 [&_svg]:text-primary"
      >
        {icon}
        {title}
        {count !== undefined && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {count}
          </span>
        )}
      </h2>
      {action}
    </div>
  );
}

/** 作业分组小标题（待完成 / 已完成） */
export function AssignmentGroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground">
      <ClipboardList aria-hidden className="size-3.5" />
      {children}
    </p>
  );
}
