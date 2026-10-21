import type { AttemptScoreSummary } from "@tutor/contract";
import { CheckCircle2, Clock, Lightbulb, ShieldCheck } from "lucide-react";
import { formatCnTime } from "@/lib/time";
import { useDueCountdown } from "./use-due-countdown";

export interface PendingReleaseBannerProps {
  /** 截止时间（UTC ISO），可为 null */
  dueAt: string | null;
  /** 交卷时间（UTC ISO），可为 null */
  submittedAt?: string | null | undefined;
  /** 作答统计摘要 */
  summary: Pick<AttemptScoreSummary, "answered" | "total">;
  /** 倒计时到期回调 */
  onExpire?: (() => void) | undefined;
  /** 手写原稿状态文案，默认 "已归档保存" */
  handwritingStatus?: string | undefined;
}

/**
 * 结果页“截止后公布（after_due）”未公布态横幅
 * - 绿色高辨识度成功 Hero 确认区（🎉 作业已成功交卷！）；
 * - 动态倒计时胶囊：显眼的 [天] [时] [分] [秒] 胶囊卡片；到期时提示正在加载；
 * - 作答凭证摘要行：交卷时间、已作答题数、手写原稿状态、待公布锁定状态；
 * - 防疑惑科普小贴士（说明为何统一公布、如何查看）。
 */
export function PendingReleaseBanner({
  dueAt,
  submittedAt,
  summary,
  onExpire,
  handwritingStatus = "已归档保存",
}: PendingReleaseBannerProps) {
  const countdown = useDueCountdown(dueAt, { onExpire });

  return (
    <section
      aria-label="交卷成功与待公布提示"
      className="flex flex-col gap-5 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 text-foreground sm:p-6 dark:border-emerald-500/30 dark:bg-emerald-950/15"
    >
      {/* 绿色高辨识度成功 Hero 确认区 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white shadow-sm dark:bg-emerald-600">
          <CheckCircle2 aria-hidden className="size-7" />
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-bold tracking-tight text-emerald-950 dark:text-emerald-100 sm:text-2xl">
            🎉 作业已成功交卷！
          </h2>
          <p className="text-sm leading-relaxed text-emerald-800/90 dark:text-emerald-200/80">
            作答与过程草稿已妥善保存，请放心休息。
          </p>
        </div>
      </div>

      {/* 动态倒计时胶囊 */}
      <div className="flex flex-col gap-3 rounded-xl border border-border/80 bg-background/80 p-4 shadow-xs backdrop-blur-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Clock aria-hidden className="size-4 text-primary" />
            <span>成绩公布倒计时</span>
          </div>
          {dueAt && (
            <span className="text-xs text-muted-foreground">
              截止时间：{formatCnTime(dueAt)}
            </span>
          )}
        </div>

        {countdown.isExpired ? (
          <div
            role="status"
            className="flex items-center gap-2 py-2 text-sm font-medium text-emerald-700 dark:text-emerald-300"
          >
            <Clock aria-hidden className="size-4 animate-spin" />
            <span>截止时间已到，正在加载批改结果…</span>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2 sm:max-w-md">
            {[
              { label: "天", val: countdown.days },
              { label: "时", val: countdown.hours },
              { label: "分", val: countdown.minutes },
              { label: "秒", val: countdown.seconds },
            ].map(({ label, val }) => (
              <div
                key={label}
                className="flex flex-col items-center justify-center rounded-lg border border-border bg-muted/40 py-2"
              >
                <span className="font-mono text-2xl font-bold tabular-nums text-foreground sm:text-3xl">
                  {String(val).padStart(2, "0")}
                </span>
                <span className="text-[11px] font-medium text-muted-foreground">
                  {label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 作答凭证摘要行 */}
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-background/60 p-3">
          <span className="text-xs text-muted-foreground">交卷时间</span>
          <span className="font-medium text-foreground">
            {submittedAt ? formatCnTime(submittedAt) : "已记录"}
          </span>
        </div>
        <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-background/60 p-3">
          <span className="text-xs text-muted-foreground">已作答题数</span>
          <span className="font-medium tabular-nums text-foreground">
            {summary.answered} / {summary.total} 题
          </span>
        </div>
        <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-background/60 p-3">
          <span className="text-xs text-muted-foreground">手写原稿状态</span>
          <span className="flex items-center gap-1 font-medium text-foreground">
            <ShieldCheck
              aria-hidden
              className="size-3.5 text-emerald-600 dark:text-emerald-400"
            />
            {handwritingStatus}
          </span>
        </div>
        <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-background/60 p-3">
          <span className="text-xs text-muted-foreground">得分状态</span>
          <span className="font-medium text-amber-700 dark:text-amber-400">
            待公布 🔒（截止后自动判分）
          </span>
        </div>
      </div>

      {/* 防疑惑科普小贴士 */}
      <div className="flex items-start gap-2.5 rounded-xl border border-amber-200/60 bg-amber-50/70 p-3.5 text-xs leading-relaxed text-amber-900 sm:text-sm dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
        <Lightbulb
          aria-hidden
          className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5"
        />
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-amber-950 dark:text-amber-100">
            为什么不在交卷后立即出分？
          </p>
          <p>
            为保障全班同学独立思考和练习公平，老师设置了在截止时间后统一公布。截止后系统将自动完成判分，届时再次进入本页面即可查看完整成绩、参考答案与题目解析。
          </p>
        </div>
      </div>
    </section>
  );
}
