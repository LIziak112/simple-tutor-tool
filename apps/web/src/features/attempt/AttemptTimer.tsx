import { Hourglass, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type AttemptClock,
  formatRemaining,
  formatTimeLimit,
} from "./attempt-clock";

/** 最后 5 分钟醒目提示 */
const WARN_MS = 5 * 60 * 1000;

/**
 * 答题页头部下方的倒计时条（限时卷专用；非限时卷不渲染）：吸顶跟随头部，右对齐
 * 徽章。aria-live 只在整分钟与最后一分钟逐秒播报，避免读屏每秒打断。
 */
export function AttemptCountdown({ clock }: { clock: AttemptClock }) {
  const warn = clock.phase === "running" && clock.remainingMs <= WARN_MS;
  const text =
    clock.phase === "running"
      ? `剩余 ${formatRemaining(clock.remainingMs)}`
      : "已到时";
  const announce =
    clock.phase !== "running" ||
    clock.remainingMs <= 60_000 ||
    Math.ceil(clock.remainingMs / 1000) % 60 === 0;
  return (
    <div className="sticky top-14 z-10 -mx-3 flex justify-end bg-background/95 px-3 py-1 text-xs backdrop-blur sm:top-16 sm:-mx-6 sm:px-6">
      <span
        data-testid="attempt-countdown"
        aria-live={announce ? "polite" : "off"}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium tabular-nums ${
          clock.phase !== "running"
            ? "bg-destructive/10 text-destructive"
            : warn
              ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
              : "bg-muted text-foreground"
        }`}
        title={`限时 ${formatTimeLimit(clock.timeLimitSec)}`}
      >
        <Timer aria-hidden className="size-3.5" />
        {text}
      </span>
    </div>
  );
}

/**
 * 到时横幅：锁住继续作答，说明本机稿 / 服务端稿的状态，给「确认交卷」入口。
 * - grace：宽限内，待同步稿仍在追平（syncing=true 时显示「待同步」），确认即交卷；
 * - locked：宽限已过，未同步的本机稿不再纳入，只能交卷。
 */
export function AttemptTimeUpBanner({
  clock,
  syncing,
  offline,
  onConfirmSubmit,
  submitDisabled,
}: {
  clock: AttemptClock;
  /** 草稿同步状态：true = 还有本机稿待同步到服务端 */
  syncing: boolean;
  offline: boolean;
  onConfirmSubmit: () => void;
  submitDisabled: boolean;
}) {
  const locked = clock.phase === "locked";
  const draftState = offline
    ? "离线：本机稿已保住，联网后会先追平再交卷"
    : syncing
      ? "有本机稿待同步，正在追平服务端…"
      : "服务端稿已是最新";
  return (
    <section
      role="alert"
      aria-label="限时已到"
      data-testid="attempt-time-up"
      className="flex flex-col gap-2 rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Hourglass
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-destructive"
        />
        <div className="min-w-0">
          <p className="font-medium">
            {locked ? "到时，宽限已过：只能交卷" : "到时，待确认交卷"}
          </p>
          <p className="text-muted-foreground">
            {locked
              ? "限时已到且 10 分钟宽限已过，不能再修改答案；未同步的本机稿不再纳入，按服务端已有答案判分。"
              : `限时已到，不能再修改答案。${draftState}；宽限还剩 ${formatRemaining(clock.graceRemainingMs)}，请确认交卷。`}
          </p>
        </div>
      </div>
      <Button
        type="button"
        className="min-h-11 shrink-0"
        onClick={onConfirmSubmit}
        disabled={submitDisabled}
      >
        确认交卷
      </Button>
    </section>
  );
}

/**
 * 结果页的限时行：时长 + 是否到时后交卷（按服务端截止与交卷时刻现算，不存新列）。
 * 非限时卷 / 旧响应缺省不渲染。
 */
export function ResultTimeLimitLine({
  attempt,
}: {
  attempt: {
    timeLimitSec?: number | null | undefined;
    deadlineAt?: string | null | undefined;
    submittedAt: string | null;
  };
}) {
  if (
    typeof attempt.timeLimitSec !== "number" ||
    typeof attempt.deadlineAt !== "string"
  ) {
    return null;
  }
  const lateMs =
    attempt.submittedAt === null
      ? 0
      : Date.parse(attempt.submittedAt) - Date.parse(attempt.deadlineAt);
  return (
    <p
      data-testid="result-time-limit"
      className="text-sm leading-relaxed text-muted-foreground"
    >
      限时 {formatTimeLimit(attempt.timeLimitSec)}
      {lateMs > 0 &&
        ` · 到时后 ${Math.max(1, Math.round(lateMs / 60000))} 分钟交卷`}
    </p>
  );
}
