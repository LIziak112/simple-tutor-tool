import type { LibraryUsage } from "@tutor/contract";
import { BookOpen, ClipboardList, FilePenLine } from "lucide-react";
import { formatCnTime } from "@/lib/time";

/**
 * 使用情况渲染（D3 删除确认弹层与单元详情面板共用）：
 * 被哪些课程引用（课程名 + 当前是否对学生可见）、被哪些未删除作业使用
 * （作业名 + 截止）、关联作答数。名称列表最多 10 条，其余「等 N 项」（§4-1）。
 */

/** 列表最多展示条数（其余折叠为「等 N 项」） */
const MAX_ITEMS = 10;

/** 取前 N 项 + 剩余数量提示 */
function capped<T>(items: readonly T[]): { shown: T[]; rest: number } {
  return {
    shown: items.slice(0, MAX_ITEMS),
    rest: Math.max(0, items.length - MAX_ITEMS),
  };
}

/** 使用情况区块（loading / 错误 / 数据三态） */
export function UsageSection({
  usage,
  pending,
  error,
}: {
  usage: LibraryUsage | undefined;
  pending: boolean;
  error: string | null;
}) {
  if (pending) {
    return <p className="text-sm text-muted-foreground">正在加载使用情况…</p>;
  }
  if (error !== null || usage === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error ?? "使用情况加载失败"}
      </p>
    );
  }
  const courses = capped(usage.courses);
  const assignments = capped(usage.assignments);
  return (
    <div className="space-y-2.5 text-sm">
      <div>
        <p className="flex items-center gap-1.5 font-medium">
          <BookOpen aria-hidden className="size-4 text-muted-foreground" />
          课程引用（{usage.courses.length}）
        </p>
        {usage.courses.length === 0 ? (
          <p className="text-muted-foreground">未被任何课程引用</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {courses.shown.map((course) => (
              <li key={course.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{course.name}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                    course.visible
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {course.visible ? "学生可见" : "学生不可见"}
                </span>
              </li>
            ))}
            {courses.rest > 0 ? (
              <li className="text-muted-foreground">
                等 {usage.courses.length} 项
              </li>
            ) : null}
          </ul>
        )}
      </div>
      <div>
        <p className="flex items-center gap-1.5 font-medium">
          <ClipboardList aria-hidden className="size-4 text-muted-foreground" />
          作业使用（{usage.assignments.length}）
        </p>
        {usage.assignments.length === 0 ? (
          <p className="text-muted-foreground">未被任何作业使用</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {assignments.shown.map((assignment) => (
              <li
                key={assignment.id}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="min-w-0 flex-1 truncate">
                  {assignment.title}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {assignment.dueAt === null
                    ? "不限截止"
                    : `截止 ${formatCnTime(assignment.dueAt)}`}
                </span>
              </li>
            ))}
            {assignments.rest > 0 ? (
              <li className="text-muted-foreground">
                等 {usage.assignments.length} 项
              </li>
            ) : null}
          </ul>
        )}
      </div>
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <FilePenLine aria-hidden className="size-4" />
        关联作答记录：{usage.attemptCount} 条
      </p>
    </div>
  );
}
