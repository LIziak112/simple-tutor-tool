import {
  ArrowLeft,
  ClipboardList,
  Dumbbell,
  ListChecks,
  Play,
  RotateCcw,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  useStartCourseAttempt,
  useStudentUnitLanding,
} from "@/features/attempt/attempt-queries";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { ApiError } from "@/lib/api";
import { formatCnTime } from "@/lib/time";

/**
 * /s/courses/:id/units/:unitId 单元落地页（T2A.6，D10）：
 * - 单元信息：标题/主题/题数/题型分布 + 首次/最近/最高分汇总；
 * - 入口三态：开始练习（从未做）/ 继续作答（存在未交卷作答 → 直接进答题页）/
 *   再做一次（已交卷后，确认「将开始第 n+1 次，从空白开始」）；
 * - 历次记录列表：点击进入该次结果视图（只读，/s/attempts/:attemptId）。
 * 越权（D22）：非成员/课程归档 → 403 COURSE_ACCESS_DENIED（中文引导）；
 * 课程或条目不可见 → 404（不暴露存在性）。
 */

/** 题型中文标签（与 answer-format 的 QUESTION_TYPE_LABELS 同口径的精简版） */
const TYPE_LABELS: Record<string, string> = {
  judge: "判断",
  choice: "单选",
  multi: "多选",
  fill: "填空",
  solve: "手写解答",
  apply: "应用题",
  findError: "找错题",
};

/** 历次状态徽章文案 */
function statusLabel(status: string): string {
  if (status === "draft") return "进行中";
  if (status === "graded") return "已批改";
  return "已交卷";
}

/** 再做一次的确认弹层（D10：新一次从空白开始） */
function RedoConfirmDialog({
  open,
  nextAttemptNo,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  nextAttemptNo: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="再做一次确认"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-lg">
        <h2 className="text-base font-semibold">再做一次</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          将开始第 {nextAttemptNo}{" "}
          次，从空白开始。之前的记录会保留，可随时回看。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={onCancel}
          >
            先不做
          </Button>
          <Button className="min-h-11" disabled={busy} onClick={onConfirm}>
            {busy ? "正在开始…" : "开始新一次"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function StudentCourseUnitPage() {
  const { id: courseId = "", unitId = "" } = useParams<{
    id: string;
    unitId: string;
  }>();
  const navigate = useNavigate();
  const landingQuery = useStudentUnitLanding(courseId, unitId);
  const startAttempt = useStartCourseAttempt(courseId, unitId);
  const [redoOpen, setRedoOpen] = useState(false);

  const accessDenied =
    landingQuery.error instanceof ApiError &&
    landingQuery.error.code === "COURSE_ACCESS_DENIED";
  const notVisible =
    landingQuery.error instanceof ApiError && landingQuery.error.status === 404;

  if (landingQuery.isPending) {
    return <StudentListSkeleton label="正在加载练习" />;
  }
  if (landingQuery.isError) {
    if (accessDenied) {
      return (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="text-sm font-medium">暂时看不到这个练习</p>
          <p className="text-sm text-muted-foreground">
            你可能已被移出这门课，或课程已结束归档。有疑问请联系老师。
          </p>
          <Link
            to="/s/courses"
            className="flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            返回我的课程
          </Link>
        </div>
      );
    }
    return (
      <StudentErrorPanel
        title={notVisible ? "练习还没有开放" : "练习加载失败"}
        message={
          notVisible
            ? "这个练习可能还未发布或已被移除，可以先看看课程里的其他内容。"
            : landingQuery.error instanceof Error
              ? landingQuery.error.message
              : "网络异常，请稍后重试"
        }
        onRetry={
          notVisible
            ? () => void navigate("/s/courses")
            : () => void landingQuery.refetch()
        }
      />
    );
  }

  const landing = landingQuery.data;
  const summary = landing.summary;
  const hasDraft = summary?.hasDraft === true;
  const submittedCount = summary?.submittedCount ?? 0;
  const nextAttemptNo = (summary?.count ?? 0) + 1;
  const busy = startAttempt.isPending;

  const enterAttempt = (attemptId: string) => {
    void navigate(`/s/attempts/${attemptId}`);
  };

  const onStart = () => {
    startAttempt.mutate(undefined, {
      onSuccess: (attempt) => enterAttempt(attempt.id),
    });
  };

  const typeBadges = Object.entries(landing.typeDistribution)
    .map(([type, count]) => `${TYPE_LABELS[type] ?? type} ${count}`)
    .join(" · ");

  return (
    <section aria-label="单元练习" className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <Link
          to={`/s/courses/${courseId}`}
          aria-label="返回课程目录"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            课程：{landing.courseName}
          </p>
          <h1 className="flex items-center gap-2 truncate text-lg font-semibold">
            <Dumbbell aria-hidden className="size-5 shrink-0 text-primary" />
            {landing.title}
          </h1>
        </div>
      </header>

      {/* 单元信息卡：题数/题型分布/得分汇总 */}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span>
            共 <b className="text-primary">{landing.questionCount}</b> 题
          </span>
          {typeBadges !== "" && (
            <span className="text-xs text-muted-foreground">{typeBadges}</span>
          )}
        </div>
        {summary !== null && submittedCount > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>已做 {summary.count} 次</span>
            <span>
              首次 {summary.firstScore ?? "—"} 分 · 最近{" "}
              {summary.latestScore ?? "—"} 分 · 最高 {summary.bestScore ?? "—"}{" "}
              分
            </span>
            {summary.pendingCount > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                有 {summary.pendingCount} 题待批
              </span>
            )}
          </div>
        )}
      </div>

      {/* 入口：开始练习（从未做）/ 继续作答（有未交卷）/ 再做一次（确认后新建） */}
      <div className="flex flex-wrap items-center gap-3">
        {summary === null ? (
          <Button
            className="min-h-11 px-6"
            disabled={busy}
            onClick={onStart}
            aria-label={`开始练习 ${landing.title}`}
          >
            <Play aria-hidden className="size-4" />
            {busy ? "正在开始…" : "开始练习"}
          </Button>
        ) : hasDraft ? (
          <Button
            className="min-h-11 px-6"
            disabled={busy}
            onClick={onStart}
            aria-label="继续作答"
          >
            <Play aria-hidden className="size-4" />
            {busy ? "正在打开…" : "继续作答"}
          </Button>
        ) : (
          <Button
            className="min-h-11 px-6"
            onClick={() => setRedoOpen(true)}
            aria-label="再做一次"
          >
            <RotateCcw aria-hidden className="size-4" />
            再做一次
          </Button>
        )}
        {startAttempt.isError && (
          <p role="alert" className="text-xs text-destructive">
            {startAttempt.error instanceof Error
              ? startAttempt.error.message
              : "开始失败，请稍后重试"}
          </p>
        )}
      </div>

      {/* 历次记录 */}
      <div className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 pt-2 text-sm font-semibold text-muted-foreground">
          <ListChecks aria-hidden className="size-4" />
          历次记录（{landing.attempts.length}）
        </h2>
        {landing.attempts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card px-6 py-8 text-center text-sm text-muted-foreground">
            <ClipboardList aria-hidden className="mx-auto mb-2 size-6" />
            还没有做过——从上面的按钮开始第一次练习。
          </div>
        ) : (
          <ol className="flex flex-col gap-2">
            {landing.attempts.map((attempt) => (
              <li key={attempt.attemptId}>
                <button
                  type="button"
                  aria-label={`查看第 ${attempt.attemptNo} 次记录`}
                  onClick={() => enterAttempt(attempt.attemptId)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="w-14 shrink-0 text-sm font-medium">
                    第 {attempt.attemptNo} 次
                  </span>
                  <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    {statusLabel(attempt.status)}
                  </span>
                  {attempt.status !== "draft" && (
                    <span className="shrink-0 text-sm">
                      {attempt.score !== null ? `${attempt.score} 分` : "待批"}
                    </span>
                  )}
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {attempt.submittedAt !== null
                      ? formatCnTime(attempt.submittedAt)
                      : "未交卷"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      <RedoConfirmDialog
        open={redoOpen}
        nextAttemptNo={nextAttemptNo}
        busy={busy}
        onConfirm={() => {
          setRedoOpen(false);
          onStart();
        }}
        onCancel={() => setRedoOpen(false)}
      />
    </section>
  );
}
