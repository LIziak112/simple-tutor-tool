import {
  ArrowLeft,
  ClipboardList,
  ListChecks,
  Play,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatResultCounts } from "@/features/attempt/result-counts";
import {
  isStaleLessonRestart,
  useLessonLanding,
  useRestartLesson,
} from "@/features/lesson/lesson-queries";
import { usePortalRoutes } from "@/features/runtime/portal-runtime";
import { lessonRunHref } from "@/features/student/lesson-navigation";
import { aiQueueReturnTarget } from "@/features/student/record-review-navigation";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { ApiError } from "@/lib/api-response";

import { formatRelativeTime } from "@/lib/time";

/**
 * /s/lectures/:id/lesson 讲练落地页（2026-10 教师演示口径，与练习单元落地页
 * /s/courses/:id/units/:unitId 同构）：讲练是老师讲解材料，本页承载——
 * - 三态入口：开始练习（从未做）/ 继续作答（有进行中卷，直达作答页幂等取回）/
 *   再做一次（已完成后）或重新开始（进行中——随时重开：旧卷作废不再计入
 *   历次/记录/统计，确认弹层明示）；
 * - 历次记录：draft 行进作答页续作、已交行进结果页（/s/attempts/:id）；
 * - 作答页在 /lesson/run（进入即幂等开卷）。
 * 越权（D22）与 start 同口径：非成员带 courseId 403 / 缺省 404。
 */

/** 历次状态徽章文案（与单元落地页同词） */
function statusLabel(status: string): string {
  if (status === "draft") return "进行中";
  if (status === "graded") return "已批改";
  return "已交卷";
}

/** 题型中文标签（与单元落地页同款精简版——严格键型表不支持动态索引） */
const TYPE_LABELS: Record<string, string> = {
  judge: "判断",
  choice: "单选",
  multi: "多选",
  fill: "填空",
  solve: "手写解答",
  apply: "应用题",
  findError: "找错题",
};

/** 重开确认弹层（进行中 = 重新开始·作废旧卷；完成 = 再做一次） */
function RestartConfirmDialog({
  open,
  mode,
  nextAttemptNo,
  busy,
  onConfirm,
  onCancel,
  onClosed,
  error,
}: {
  open: boolean;
  mode: "abandon" | "redo";
  nextAttemptNo: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onClosed: () => void;
  error: string | null;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel();
      }}
    >
      <DialogContent
        aria-labelledby={undefined}
        aria-label={mode === "abandon" ? "重新开始确认" : "再做一次确认"}
        className="top-auto bottom-4 w-[calc(100%-2rem)] max-w-sm translate-y-0 rounded-2xl sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
        closeDisabled={busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogTitle>
          {mode === "abandon" ? "重新开始" : "再做一次"}
        </DialogTitle>
        <DialogDescription className="mt-2">
          {mode === "abandon"
            ? `进行中的这一次将被作废（不再计入历次与统计），并开始第 ${nextAttemptNo} 次，从空白开始。`
            : `将开始第 ${nextAttemptNo} 次，从空白开始。之前的记录会保留，可随时回看。`}
        </DialogDescription>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter className="mt-4">
          <Button
            ref={cancelRef}
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function StudentLessonLandingPage() {
  const routes = usePortalRoutes();

  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const courseId = searchParams.get("courseId") ?? undefined;
  // SAI-23 队列跳转来源（aiFrom 白名单）：从助教队列进入落地页时，头部
  // 返回键回到打开队列时的来源位置（缺省仍回课程目录/讲义列表）
  const queueTarget = aiQueueReturnTarget(routes, searchParams.get("aiFrom"));
  const navigate = useNavigate();
  const landingQuery = useLessonLanding(
    id.length > 0 ? id : undefined,
    courseId,
  );
  const restart = useRestartLesson(id);
  const redoTriggerRef = useRef<HTMLButtonElement>(null);
  const [restartTarget, setRestartTarget] = useState<string | null>(null);

  const accessDenied =
    landingQuery.error instanceof ApiError &&
    landingQuery.error.code === "COURSE_ACCESS_DENIED";
  const notVisible =
    landingQuery.error instanceof ApiError && landingQuery.error.status === 404;

  if (landingQuery.isPending) {
    return <StudentListSkeleton label="正在打开讲练" />;
  }
  if (landingQuery.isError) {
    if (accessDenied) {
      return (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="text-sm font-medium">暂时看不到这份讲练</p>
          <p className="text-sm text-muted-foreground">
            你可能已被移出这门课，或课程已结束归档。有疑问请联系老师。
          </p>
          <Link
            to={routes.learning("courses")}
            className="flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            返回我的课程
          </Link>
        </div>
      );
    }
    return (
      <StudentErrorPanel
        title={notVisible ? "讲练还没有开放" : "讲练打开失败"}
        message={
          notVisible
            ? "这份讲练可能还未发布或已被移除，可以先看看其他内容。"
            : landingQuery.error instanceof Error
              ? landingQuery.error.message
              : "网络异常，请稍后重试"
        }
        onRetry={
          notVisible
            ? () => void navigate(routes.learning("lectures"))
            : () => void landingQuery.refetch()
        }
      />
    );
  }

  const landing = landingQuery.data;
  const summary = landing.summary;
  const hasDraft = summary?.hasDraft === true;
  const nextAttemptNo = (summary?.count ?? 0) + 1;
  const busy = restart.isPending;
  const runTo = lessonRunHref(routes, landing.lectureId, courseId);

  const enterRun = () => {
    void navigate(runTo);
  };
  const openRestart = () => {
    const latest = landing.attempts.reduce<
      (typeof landing.attempts)[number] | undefined
    >(
      (head, attempt) =>
        !head || attempt.attemptNo > head.attemptNo ? attempt : head,
      undefined,
    );
    setRestartTarget(latest?.attemptId ?? null);
  };
  const onRestart = () => {
    if (restartTarget === null) return;
    restart.mutate(restartTarget, {
      onSuccess: enterRun,
      onError: (error) => {
        if (isStaleLessonRestart(error)) {
          setRestartTarget(null);
          void landingQuery.refetch();
        }
      },
    });
  };

  const typeBadges = Object.entries(landing.typeDistribution)
    .map(([type, count]) => `${TYPE_LABELS[type] ?? type} ${count}`)
    .join(" · ");

  return (
    <section aria-label="讲练落地" className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <Link
          to={
            queueTarget ??
            (courseId !== undefined
              ? routes.learning(`courses/${courseId}`)
              : routes.learning("lectures"))
          }
          aria-label={
            queueTarget !== null
              ? "返回原页面"
              : courseId !== undefined
                ? "返回课程目录"
                : "返回讲义列表"
          }
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <div className="min-w-0">
          {landing.courseName !== null && (
            <p className="text-xs text-muted-foreground">
              课程：{landing.courseName}
            </p>
          )}
          <h1 className="flex items-center gap-2 truncate text-xl font-semibold">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300"
            >
              <Sparkles className="size-5" />
            </span>
            {landing.title}
          </h1>
        </div>
      </header>

      {/* 讲练信息卡：题数/题型分布 + 三态入口 */}
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span>
            共 <b className="text-primary">{landing.questionCount}</b> 题
          </span>
          {typeBadges !== "" && (
            <span className="text-xs text-muted-foreground">{typeBadges}</span>
          )}
        </div>
        {summary !== null && summary.submittedCount > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>已做 {summary.submittedCount} 次</span>
            {summary.pendingCount > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                有 {summary.pendingCount} 题待批
              </span>
            )}
          </div>
        )}

        {/* 入口：开始练习（从未做）/ 继续作答 + 重新开始（进行中）/ 再做一次（完成） */}
        <div className="flex flex-wrap items-center gap-3">
          {summary === null ? (
            <Button
              className="min-h-12 px-8 text-base"
              onClick={enterRun}
              aria-label={`开始练习 ${landing.title}`}
            >
              <Play aria-hidden className="size-4" />
              开始练习
            </Button>
          ) : hasDraft ? (
            <>
              <Button
                className="min-h-12 px-8 text-base"
                disabled={busy}
                onClick={enterRun}
                aria-label="继续作答"
              >
                <Play aria-hidden className="size-4" />
                {busy ? "正在打开…" : "继续作答"}
              </Button>
              <Button
                variant="outline"
                className="min-h-12 px-6 text-base"
                disabled={busy}
                ref={redoTriggerRef}
                onClick={openRestart}
                aria-label="重新开始"
              >
                <RotateCcw aria-hidden className="size-4" />
                重新开始
              </Button>
            </>
          ) : (
            <Button
              className="min-h-12 px-8 text-base"
              disabled={busy}
              ref={redoTriggerRef}
              onClick={openRestart}
              aria-label="再做一次"
            >
              <RotateCcw aria-hidden className="size-4" />
              再做一次
            </Button>
          )}
          {restart.isError && (
            <p role="alert" className="text-xs text-destructive">
              {restart.error instanceof Error
                ? restart.error.message
                : "重开失败，请稍后重试"}
            </p>
          )}
        </div>
      </div>

      {/* 历次记录（作废卷不计入；draft 行进作答页、已交行进结果页） */}
      <div className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 pt-2 text-sm font-semibold text-muted-foreground">
          <ListChecks aria-hidden className="size-4" />
          历次记录（{landing.attempts.length}）
        </h2>
        {landing.attempts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-8 text-center text-sm text-muted-foreground">
            <ClipboardList aria-hidden className="mx-auto mb-2 size-6" />
            还没有做过——从上面的按钮开始第一次讲练。
          </div>
        ) : (
          <ol className="flex flex-col gap-2">
            {landing.attempts.map((attempt) => {
              const draft = attempt.status === "draft";
              return (
                <li key={attempt.attemptId}>
                  <button
                    type="button"
                    aria-label={`${draft ? "继续作答" : "查看"}第 ${attempt.attemptNo} 次`}
                    onClick={() => {
                      void navigate(
                        draft
                          ? runTo
                          : routes.learning(`attempts/${attempt.attemptId}`),
                      );
                    }}
                    className="flex min-h-14 w-full flex-wrap items-center gap-3 rounded-2xl border border-border bg-card px-4 py-2 text-left shadow-xs outline-none transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="w-14 shrink-0 text-sm font-medium">
                      第 {attempt.attemptNo} 次
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                      {statusLabel(attempt.status)}
                    </span>
                    {!draft && (
                      <span className="min-w-0 max-w-full text-sm break-words">
                        {formatResultCounts(attempt.resultCounts)}
                      </span>
                    )}
                    <span className="ml-auto truncate text-xs text-muted-foreground">
                      {attempt.submittedAt !== null
                        ? formatRelativeTime(attempt.submittedAt)
                        : "未交卷"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <RestartConfirmDialog
        open={restartTarget !== null}
        mode={hasDraft ? "abandon" : "redo"}
        nextAttemptNo={nextAttemptNo}
        busy={busy}
        onClosed={() => redoTriggerRef.current?.focus()}
        error={
          restart.isError
            ? restart.error instanceof Error
              ? restart.error.message
              : "开始失败，请稍后重试"
            : null
        }
        onConfirm={() => {
          onRestart();
        }}
        onCancel={() => setRestartTarget(null)}
      />
    </section>
  );
}
