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
 */
export function ModuleResultTable({
  units,
  released,
  activity,
  wrongPractice,
}: {
  units: readonly AttemptResultUnit[];
  released: boolean;
  activity: AttemptActivity | undefined;
  wrongPractice?:
    | {
        loading: boolean;
        onStart: (questionIds: string[], moduleTitle: string) => void;
      }
    | undefined;
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
  const jumpTo = (unitId: string) => {
    document
      .querySelector(`[data-review-unit="${CSS.escape(unitId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <section
      data-testid="module-results"
      aria-label="按模块看结果"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">按模块看</h2>
        <p className="text-xs text-muted-foreground">
          用时为题内活动用时（口径 v1）；参考配额来自单元推荐时长，不是时钟
        </p>
      </div>
      <div className="overflow-x-auto">
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
              <ModuleRow
                key={row.unitId}
                row={row}
                released={released}
                showQuota={showQuota}
                showActions={showActions}
                onJump={multi ? jumpTo : undefined}
                wrongPractice={wrongPractice}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ModuleRow({
  row,
  released,
  showQuota,
  showActions,
  onJump,
  wrongPractice,
}: {
  row: ModuleResultStats;
  released: boolean;
  showQuota: boolean;
  showActions: boolean;
  onJump: ((unitId: string) => void) | undefined;
  wrongPractice?:
    | {
        loading: boolean;
        onStart: (questionIds: string[], moduleTitle: string) => void;
      }
    | undefined;
}) {
  const overQuota =
    row.timeQuotaMinutes !== null &&
    row.activeSec !== null &&
    row.activeSec > row.timeQuotaMinutes * 60;
  return (
    <tr
      data-module-row={row.unitId}
      className="border-t border-border [&>td]:px-2 [&>td]:py-2 [&>td]:align-middle"
    >
      <td className="max-w-[220px] font-medium">
        {onJump !== undefined ? (
          <button
            type="button"
            className="truncate text-left underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onJump(row.unitId)}
          >
            {row.title}
          </button>
        ) : (
          <span className="truncate">{row.title}</span>
        )}
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
          `${row.answered} / ${row.total}`
        )}
      </td>
      <td>{row.skipped}</td>
      {released && <td>{row.unsureCorrect}</td>}
      <td
        className={cn(overQuota && "text-amber-700 dark:text-amber-300")}
        title={
          row.activeSec === null
            ? "本卷没有作答事件记录"
            : `只看过 ${formatActivitySec(row.observedSec)}（无作答动作）`
        }
      >
        {row.activeSec === null
          ? "无可用记录"
          : formatActivitySec(row.activeSec)}
      </td>
      {showQuota && (
        <td>
          {row.timeQuotaMinutes === null
            ? "—"
            : formatTimeLimit(row.timeQuotaMinutes * 60)}
        </td>
      )}
      {showActions && (
        <td className="text-right">
          {wrongPractice !== undefined && row.wrongQuestionIds.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="min-h-9"
              disabled={wrongPractice.loading}
              onClick={() =>
                wrongPractice.onStart(row.wrongQuestionIds, row.title)
              }
            >
              <RotateCcw
                aria-hidden
                className={cn(
                  "size-3.5",
                  wrongPractice.loading && "animate-spin",
                )}
              />
              专项重练（{row.wrongQuestionIds.length}）
            </Button>
          )}
        </td>
      )}
    </tr>
  );
}
