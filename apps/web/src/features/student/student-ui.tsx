import type { AssignmentStatus, StudentAssignment } from "@tutor/contract";
import { cn } from "cn";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { formatDueTime } from "@/lib/time";

/**
 * 学生端共享展示组件（T2.3）：状态徽章、作业卡片、三态兜底。
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
      className={`rounded-full px-2.5 py-1 text-xs font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

/** 截止时间展示：北京时间「10月1日 20:00 截止」/ 未设置时「不限截止」 */
export function AssignmentDueLabel({ dueAt }: { dueAt: string | null }) {
  if (dueAt === null) {
    return <span className="text-xs text-muted-foreground">不限截止</span>;
  }
  return (
    <span className="text-xs text-muted-foreground">
      {formatDueTime(dueAt)} 截止
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

/**
 * 「我的作业」卡片：标题/单元/主题/题数/截止/状态徽章 + 答题入口。
 * T2.6 起入口打通：点击进入 /s/assignments/:id（自动创建/取回 attempt，
 * 未开始与进行中都进答题视图，已交/已批进结果视图）。
 */
export function StudentAssignmentCard({
  assignment,
}: {
  assignment: StudentAssignment;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-card-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-base font-semibold">{assignment.title}</p>
        <AssignmentStatusBadge status={assignment.status} />
        <AssignmentDueLabel dueAt={assignment.dueAt} />
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span>单元：{assignment.unitTitle}</span>
        {assignment.topic && <span>主题：{assignment.topic}</span>}
        <span>共 {assignment.questionCount} 题</span>
      </p>
      <Button asChild variant="outline" className="min-h-11">
        <Link to={`/s/assignments/${assignment.id}`}>
          {ENTRY_LABEL[assignment.status]}
        </Link>
      </Button>
    </li>
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
          className="h-28 animate-pulse rounded-xl border border-border bg-muted/50"
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
        "flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5",
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
