import type { AttemptActivity, AttemptResultUnit } from "@tutor/contract";
import { cn } from "cn";
import { RotateCcw } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { formatTimeLimit } from "./attempt-clock";
import {
  type ModuleResultStats,
  moduleResultStatsOf,
} from "./module-result-model";
import { formatActivitySec } from "./QuestionActivity";

/**
 * 结果页「按模块看」（2026-11-09 模块 7 第一刀）：每个单元一行——答对 / 作答 /
 * 题数、跳过、不确定但答对、题内活动用时（口径 v1）、参考配额（单元推荐时长，
 * 与用时分列，不是时钟），以及「专项重练（n）」入口（走结果页既有的错题重练
 * 组卷，范围标题带模块名，新卷标题即可看出来自哪一轮诊断）。
 * 未公布时只给作答 / 跳过 / 用时；多模块时点模块名跳到该节。
 * 响应式：sm 及以上用表格（横向可滚），更窄的手机屏改为逐模块卡片。表格外层
 * 用 w-0 + min-w-full 让它对祖先的 min-content 贡献为 0——否则 560px 的表格
 * 会把结果页主栏撑宽；再加 relative，让表头里 sr-only 的绝对定位文字以它为
 * 包含块、随滚动容器一起裁剪，不会逃出去撑出页面横向滚动（e2e zoom 200% 口径）。
 */
interface WrongPracticeHook {
  loading: boolean;
  onStart: (questionIds: string[], moduleTitle: string) => void;
}

export function ModuleResultTable({
  units,
  released,
  activity,
  wrongPractice,
}: {
  units: readonly AttemptResultUnit[];
  released: boolean;
  activity: AttemptActivity | undefined;
  wrongPractice?: WrongPracticeHook | undefined;
}) {
  const rows = useMemo(
    () => units.map((unit) => moduleResultStatsOf(unit, released, activity)),
    [units, released, activity],
  );
  if (rows.length === 0) return null;
  const multi = rows.length > 1;
  const showQuota = rows.some((row) => row.timeQuotaMinutes !== null);
  const showActions =
    released &&
    wrongPractice !== undefined &&
    rows.some((row) => row.wrongQuestionIds.length > 0);
  const jumpTo = multi
    ? (unitId: string) => {
        document
          .querySelector(`[data-review-unit="${CSS.escape(unitId)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    : undefined;
  const shared = { released, showQuota, showActions, jumpTo, wrongPractice };
  return (
    <section
      data-testid="module-results"
      aria-label="按模块看结果"
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">按模块看</h2>
        <p className="text-xs text-muted-foreground">
          用时为题内活动用时（口径 v1）；参考配额来自单元推荐时长，不是时钟
        </p>
      </div>
      <div className="relative hidden w-0 min-w-full overflow-x-auto sm:block">
        <table className="w-full min-w-[560px] text-sm tabular-nums">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:font-medium">
              <th scope="col">模块</th>
              <th scope="col">
                {released ? "答对 / 作答 / 题数" : "作答 / 题数"}
              </th>
              <th scope="col">跳过</th>
              {released && <th scope="col">不确定但答对</th>}
              <th scope="col">活动用时</th>
              {showQuota && <th scope="col">参考配额</th>}
              {showActions && (
                <th scope="col">
                  <span className="sr-only">操作</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ModuleRow key={row.unitId} row={row} {...shared} />
            ))}
          </tbody>
        </table>
      </div>
      <ul
        data-testid="module-results-cards"
        className="flex flex-col gap-2 sm:hidden"
      >
        {rows.map((row) => (
          <ModuleCard key={row.unitId} row={row} {...shared} />
        ))}
      </ul>
    </section>
  );
}

interface RowProps {
  row: ModuleResultStats;
  released: boolean;
  showQuota: boolean;
  showActions: boolean;
  jumpTo: ((unitId: string) => void) | undefined;
  wrongPractice?: WrongPracticeHook | undefined;
}

/** 单元格文案（表格与卡片共用，口径一处） */
function countsText(row: ModuleResultStats, released: boolean): string {
  return released
    ? `${row.correct} / ${row.answered} / ${row.total}`
    : `${row.answered} / ${row.total}`;
}
function activityText(row: ModuleResultStats): string {
  return row.activeSec === null
    ? "无可用记录"
    : formatActivitySec(row.activeSec);
}
function activityTitle(row: ModuleResultStats): string {
  // null 两种来源同一句：整卷无事件，或整卷有事件但本模块没有任何题的记录
  return row.activeSec === null
    ? "本模块没有作答事件记录"
    : `只看过 ${formatActivitySec(row.observedSec)}（无作答动作）`;
}
function quotaText(row: ModuleResultStats): string {
  return row.timeQuotaMinutes === null
    ? "—"
    : formatTimeLimit(row.timeQuotaMinutes * 60);
}
function overQuota(row: ModuleResultStats): boolean {
  return (
    row.timeQuotaMinutes !== null &&
    row.activeSec !== null &&
    row.activeSec > row.timeQuotaMinutes * 60
  );
}

/** 模块名：表格里单行截断（列宽有上限），卡片里换行（窄屏不能被撑宽） */
function ModuleTitle({
  row,
  jumpTo,
  wrap = false,
}: {
  row: ModuleResultStats;
  jumpTo: ((unitId: string) => void) | undefined;
  wrap?: boolean;
}) {
  const fit = wrap ? "break-words" : "max-w-full truncate";
  return jumpTo !== undefined ? (
    <button
      type="button"
      className={cn(
        "text-left font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        fit,
      )}
      onClick={() => jumpTo(row.unitId)}
    >
      {row.title}
    </button>
  ) : (
    <span className={cn("font-medium", fit)}>{row.title}</span>
  );
}

function RetrainButton({
  row,
  wrongPractice,
}: {
  row: ModuleResultStats;
  wrongPractice: WrongPracticeHook | undefined;
}) {
  if (wrongPractice === undefined || row.wrongQuestionIds.length === 0) {
    return null;
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="min-h-9"
      disabled={wrongPractice.loading}
      onClick={() => wrongPractice.onStart(row.wrongQuestionIds, row.title)}
    >
      <RotateCcw
        aria-hidden
        className={cn("size-3.5", wrongPractice.loading && "animate-spin")}
      />
      专项重练（{row.wrongQuestionIds.length}）
    </Button>
  );
}

function ModuleRow({
  row,
  released,
  showQuota,
  showActions,
  jumpTo,
  wrongPractice,
}: RowProps) {
  return (
    <tr
      data-module-row={row.unitId}
      className="border-t border-border [&>td]:px-2 [&>td]:py-2 [&>td]:align-middle"
    >
      <td className="max-w-[220px]">
        <ModuleTitle row={row} jumpTo={jumpTo} />
      </td>
      <td>
        {released ? (
          <>
            <span className="text-emerald-700 dark:text-emerald-300">
              {row.correct}
            </span>
            {` / ${row.answered} / ${row.total}`}
          </>
        ) : (
          countsText(row, released)
        )}
      </td>
      <td>{row.skipped}</td>
      {released && <td>{row.unsureCorrect}</td>}
      <td
        className={cn(overQuota(row) && "text-amber-700 dark:text-amber-300")}
        title={activityTitle(row)}
      >
        {activityText(row)}
      </td>
      {showQuota && <td>{quotaText(row)}</td>}
      {showActions && (
        <td className="text-right">
          <RetrainButton row={row} wrongPractice={wrongPractice} />
        </td>
      )}
    </tr>
  );
}

function ModuleCard({
  row,
  released,
  showQuota,
  showActions,
  jumpTo,
  wrongPractice,
}: RowProps) {
  return (
    <li
      data-module-card={row.unitId}
      className="flex min-w-0 flex-col items-start gap-1.5 rounded-lg border border-border p-3 text-sm tabular-nums"
    >
      <ModuleTitle row={row} jumpTo={jumpTo} wrap />
      <p className="text-muted-foreground">
        {released ? "答对 / 作答 / 题数 " : "作答 / 题数 "}
        <span className="text-foreground">{countsText(row, released)}</span>
        {` · 跳过 ${row.skipped}`}
        {released && ` · 不确定但答对 ${row.unsureCorrect}`}
      </p>
      <p className="text-muted-foreground" title={activityTitle(row)}>
        活动用时{" "}
        <span
          className={cn(
            "text-foreground",
            overQuota(row) && "text-amber-700 dark:text-amber-300",
          )}
        >
          {activityText(row)}
        </span>
        {showQuota && ` · 参考配额 ${quotaText(row)}`}
      </p>
      {showActions && <RetrainButton row={row} wrongPractice={wrongPractice} />}
    </li>
  );
}
