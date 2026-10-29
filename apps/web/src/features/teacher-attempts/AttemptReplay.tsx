import {
  QUESTION_TYPE_LABELS,
  type TeacherAttemptDetailData,
} from "@tutor/contract";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCnTime } from "@/lib/time";
import { replayStateAt, replayWindow } from "./replay-model";
import { useTeacherAttemptReplay } from "./teacher-attempt-queries";

/**
 * 做题复现（hall-15077）：教师端卷详情页的只读重放区——按 events 时间轴 +
 * 服务端事实（草稿版本/手写上传/逐题提交）重建任意时刻的做题状态。
 * 组件只消费 replay-model 纯函数，不自行解析载荷；载荷全是元信息与计数，
 * 题面内容一律来自既有详情接口的冻结投影（防泄露红线同口径）。
 */
export function AttemptReplay({
  attemptId,
  detail,
}: {
  attemptId: string;
  detail: TeacherAttemptDetailData;
}) {
  const replayQuery = useTeacherAttemptReplay(attemptId);
  const range = useMemo(
    () =>
      replayQuery.data === undefined ? null : replayWindow(replayQuery.data),
    [replayQuery.data],
  );
  const [tMs, setTMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing || range === null) return;
    const timer = window.setInterval(() => {
      setTMs((previous) => {
        const current = previous ?? range.startMs;
        if (current >= range.endMs) {
          setPlaying(false);
          return range.endMs;
        }
        return Math.min(current + 500, range.endMs);
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [playing, range]);

  if (replayQuery.isPending) {
    return (
      <section
        className="rounded-xl border border-border bg-card p-5"
        aria-label="做题复现"
      >
        <p className="text-sm text-muted-foreground">正在加载复现数据…</p>
      </section>
    );
  }
  if (replayQuery.isError || range === null || replayQuery.data === undefined) {
    return (
      <section
        className="rounded-xl border border-border bg-card p-5"
        aria-label="做题复现"
      >
        <p className="text-sm text-muted-foreground">
          本卷没有可复现的行为数据（未记录到事件与事实）。
        </p>
      </section>
    );
  }

  const t = tMs ?? range.startMs;
  const state = replayStateAt(replayQuery.data, t);
  const labelOf = (questionId: string): string => {
    const found = detail.questions.find((q) => q.questionId === questionId);
    return found === undefined ? questionId : `第 ${found.no} 题`;
  };
  const answerTextOf = (answer: unknown): string => {
    if (answer === null || answer === undefined) return "—";
    const text = JSON.stringify(answer);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
      aria-label="做题复现"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">做题复现</h2>
        <span className="text-xs text-muted-foreground">
          只读重放 · 行为时间轴{" "}
          {state !== null
            ? `${state.consumedEvents}/${replayQuery.data.events.length}`
            : "—"}
        </span>
      </div>
      {state !== null && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPlaying((previous) => !previous)}
              aria-label={playing ? "暂停复现" : "播放复现"}
            >
              {playing ? (
                <Pause aria-hidden className="size-4" />
              ) : (
                <Play aria-hidden className="size-4" />
              )}
              {playing ? "暂停" : "播放"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPlaying(false);
                setTMs(null);
              }}
            >
              <RotateCcw aria-hidden className="size-4" />
              回到开头
            </Button>
            <input
              type="range"
              className="min-w-48 flex-1"
              min={range.startMs}
              max={range.endMs}
              step={500}
              value={t}
              onChange={(event) => {
                setPlaying(false);
                setTMs(Number(event.target.value));
              }}
              aria-label="复现时刻"
            />
            <span className="text-sm text-muted-foreground">
              {formatCnTime(new Date(t).toISOString())}
            </span>
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span>
              当前聚焦：
              {state.focusQuestionId === null
                ? "—"
                : labelOf(state.focusQuestionId)}
            </span>
            {replayQuery.data.submittedAt !== null && (
              <span className="text-emerald-700">
                整卷交卷：{formatCnTime(replayQuery.data.submittedAt)}
              </span>
            )}
            {state.pageHidden && (
              <span className="text-amber-600">页面已隐藏</span>
            )}
            {state.offline && <span className="text-red-600">离线</span>}
            {state.idle && <span className="text-sky-600">空闲中</span>}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">题号</th>
                  <th className="py-1.5 pr-3 font-medium">题型</th>
                  <th className="py-1.5 pr-3 font-medium">改答</th>
                  <th className="py-1.5 pr-3 font-medium">提示</th>
                  <th className="py-1.5 pr-3 font-medium">笔画(事件)</th>
                  <th className="py-1.5 pr-3 font-medium">笔画(上传)</th>
                  <th className="py-1.5 pr-3 font-medium">草稿版</th>
                  <th className="py-1.5 pr-3 font-medium">提交</th>
                  <th className="py-1.5 font-medium">当前答案</th>
                  <th className="py-1.5 font-medium">提交时刻</th>
                </tr>
              </thead>
              <tbody>
                {detail.questions.map((question) => {
                  const questionState = state.questions.get(
                    question.questionId,
                  );
                  return (
                    <tr
                      key={question.questionId}
                      className={
                        state.focusQuestionId === question.questionId
                          ? "bg-sky-50 dark:bg-sky-500/10"
                          : undefined
                      }
                    >
                      <td className="py-1.5 pr-3">{question.no}</td>
                      <td className="py-1.5 pr-3">
                        {QUESTION_TYPE_LABELS[question.type]}
                      </td>
                      <td className="py-1.5 pr-3">
                        {questionState?.answerChanges ?? 0}
                      </td>
                      <td className="py-1.5 pr-3">
                        {questionState?.hintsOpened ?? 0}
                      </td>
                      <td className="py-1.5 pr-3">
                        {questionState?.strokes ?? 0}
                      </td>
                      <td className="py-1.5 pr-3">
                        {questionState?.inkStrokeCount ?? "—"}
                      </td>
                      <td className="py-1.5 pr-3">
                        {questionState?.draftRevision ?? "—"}
                      </td>
                      <td className="py-1.5 pr-3">
                        {questionState?.submittedAtMs !== null &&
                        questionState !== undefined
                          ? "✓"
                          : "—"}
                      </td>
                      <td className="py-1.5">
                        {answerTextOf(questionState?.lastAnswer ?? null)}
                      </td>
                      <td className="py-1.5">
                        {questionState?.submittedAtMs !== null &&
                        questionState !== undefined
                          ? formatCnTime(
                              new Date(
                                questionState.submittedAtMs,
                              ).toISOString(),
                            )
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            状态由行为事实重放推导（未知事件类型自动忽略）；题面与判定见上方逐题列表。
          </p>
        </>
      )}
    </section>
  );
}
