import { useQuery } from "@tanstack/react-query";
import type { CourseProgressData } from "@tutor/contract";
import { Table2 } from "lucide-react";
import { useState } from "react";
import { fetchCourseProgressApi } from "@/lib/api";
import { formatCnTime } from "@/lib/time";

/**
 * 课程「进度」页签（T2A.6）：成员 × 可见单元矩阵。
 * - 单元格：次数、首次分（教师侧统计优先口径，D10）、最近分、待批数；
 *   从未做过显示「—」；
 * - 点击单元格展开该生该单元的历次列表（只读元信息；作答详情页属 T3.1）；
 * - 列 = 此刻对学生可见的单元（隐藏/未到发布/无题不进矩阵）。
 */

const progressKey = (courseId: string) =>
  ["teacher", "courses", "progress", courseId] as const;

/** 历次状态中文 */
function statusLabel(status: string): string {
  if (status === "draft") return "进行中";
  if (status === "graded") return "已批改";
  return "已交卷";
}

export function CourseProgressTab({ courseId }: { courseId: string }) {
  const progressQuery = useQuery({
    queryKey: progressKey(courseId),
    queryFn: () => fetchCourseProgressApi(courseId),
  });
  /** 展开中的单元格（studentId:unitId；再次点击收起） */
  const [openCell, setOpenCell] = useState<string | null>(null);

  if (progressQuery.isPending) {
    return (
      <div className="rounded-xl border border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
        正在加载课程进度…
      </div>
    );
  }
  if (progressQuery.isError) {
    return (
      <div className="rounded-xl border border-border bg-card px-6 py-10 text-center">
        <p className="text-sm font-medium">课程进度加载失败</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {progressQuery.error instanceof Error
            ? progressQuery.error.message
            : "网络异常，请稍后重试"}
        </p>
        <button
          type="button"
          className="mt-4 min-h-11 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted"
          onClick={() => void progressQuery.refetch()}
        >
          重试
        </button>
      </div>
    );
  }

  const data: CourseProgressData = progressQuery.data;
  if (data.members.length === 0 || data.units.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
        <Table2 aria-hidden className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium">
          {data.members.length === 0
            ? "课程还没有成员"
            : "课程还没有可见的练习单元"}
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">
          {data.members.length === 0
            ? "在「成员」页签添加学生后，这里会显示每位成员的练习进度。"
            : "在「目录」页签把练习单元设为对学生可见后，这里会显示进度矩阵。"}
        </p>
      </div>
    );
  }

  const cellBy = new Map(
    data.cells.map((cell) => [`${cell.studentId}:${cell.unitId}`, cell]),
  );

  return (
    <div className="flex flex-col gap-3 overflow-x-auto rounded-xl border border-border bg-card p-4">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <caption className="sr-only">
          成员 × 可见练习单元的课程练习进度矩阵
        </caption>
        <thead>
          <tr className="border-b border-border text-left">
            <th scope="col" className="min-w-24 py-2 pr-3 font-medium">
              成员
            </th>
            {data.units.map((unit) => (
              <th
                key={unit.unitId}
                scope="col"
                className="min-w-32 px-3 py-2 align-bottom font-medium"
              >
                {unit.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.members.map((member) => (
            <tr key={member.studentId} className="border-b border-border/60">
              <th scope="row" className="py-2 pr-3 text-left font-normal">
                <span className="font-medium">{member.displayName}</span>
                {member.archived && (
                  <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    已归档
                  </span>
                )}
              </th>
              {data.units.map((unit) => {
                const cell = cellBy.get(`${member.studentId}:${unit.unitId}`);
                const key = `${member.studentId}:${unit.unitId}`;
                const expanded = openCell === key;
                return (
                  <td key={unit.unitId} className="px-3 py-2 align-top">
                    {cell === undefined ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${member.displayName} 在 ${unit.title} 的练习记录（共 ${cell.count} 次）`}
                        onClick={() => setOpenCell(expanded ? null : key)}
                        className="flex min-h-11 w-full flex-col items-start gap-0.5 rounded-lg border border-border px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <span>
                          {cell.count} 次
                          {cell.pendingCount > 0 && (
                            <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                              待批 {cell.pendingCount}
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          首次 {cell.firstScore ?? "—"} · 最近{" "}
                          {cell.latestScore ?? "—"}
                          {cell.bestScore !== null &&
                            ` · 最高 ${cell.bestScore}`}
                        </span>
                        {expanded && (
                          <span className="mt-1 w-full border-t border-border pt-1 text-xs text-muted-foreground">
                            {cell.history.map((h) => (
                              <span key={h.attemptId} className="block">
                                第 {h.attemptNo} 次 · {statusLabel(h.status)}
                                {h.score !== null && ` · ${h.score} 分`}
                                {h.submittedAt !== null &&
                                  ` · ${formatCnTime(h.submittedAt)}`}
                              </span>
                            ))}
                          </span>
                        )}
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        单元格只统计课程练习作答（作业作答不计入）。首次得分最能反映真实掌握
        程度；点击单元格可展开历次记录。
      </p>
    </div>
  );
}
