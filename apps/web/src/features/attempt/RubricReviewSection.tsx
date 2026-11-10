import { useQueryClient } from "@tanstack/react-query";
import type {
  AttemptResultQuestion,
  RubricAssessment,
  RubricDecision,
  RubricRating,
  RubricReview,
} from "@tutor/contract";
import {
  rubricDisagreementsOf,
  rubricEffectiveOf,
  rubricMaxOf,
  rubricRatingsEqual,
  rubricTotalOf,
} from "@tutor/contract";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  createStudentAiTaskApi,
  fetchStudentAiStatusApi,
} from "@/lib/api";
import { saveRubricFinalApi, saveRubricSelfApi } from "@/lib/rubric-api";
import { randomUuid } from "@/lib/uuid";
import { studentAiQueueSummaryKey } from "../student-ai/ai-queue-queries";
import { RubricRatingForm } from "./RubricRatingForm";

/**
 * 通用量表判卷（模块 3）结果页交互件：题有 `:::rubric` 且已公布时挂在答案对照
 * 之后。三份记录并排（我的 / Agent / 裁定），自评先行，「请 Agent 判卷」把题面、
 * 作答与参考要点作为任务发给学习者自己配置的 AI（purpose=rubric_opinion），
 * 回信后分歧项高亮，由本人裁定（保留我的 / 采纳 Agent / 自行改写）。
 * 纪律：只消费服务端投影（question.rubricReview）；量表分不进总分与错题；
 * 失败保留现场；成功后刷新本卷缓存由投影接管。
 */

const AGENT_PROMPT = "请按量表逐项评定我的作答：每项一个档位，附一句依据。";

/**
 * 判卷任务在途时刷新本卷缓存的周期（审查 #99-05）：「回信后自动显示」靠它兑现
 * ——Agent 回信走 MCP / 页内 worker 写库，结果页没有推送通道。页面不可见时
 * 不轮询（切回后一个周期内补刷）。
 */
export const RUBRIC_PENDING_POLL_MS = 15_000;

type Panel = "none" | "self" | "custom";

/**
 * 「保留我的 / 采纳 Agent」是否已无事可做：裁定来源相同且档位与当前那份记录
 * 逐项一致。来源相同但档位已变（自评改过 / 新一份意见）仍可再裁（审查 #99-06）。
 */
function decisionAlreadyApplied(
  review: RubricReview,
  decision: "self" | "agent",
): boolean {
  const source = review[decision];
  return (
    review.final !== null &&
    review.final.decision === decision &&
    source !== null &&
    rubricRatingsEqual(review.final.ratings, source.ratings)
  );
}

function levelCell(rating: RubricRating | undefined): string {
  return rating === undefined ? "—" : String(rating.level);
}

function ratingOf(
  record: { ratings: readonly RubricRating[] } | null,
  id: string,
): RubricRating | undefined {
  return record?.ratings.find((rating) => rating.id === id);
}

const DECISION_LABEL: Record<RubricDecision, string> = {
  self: "保留我的",
  agent: "采纳 Agent",
  custom: "自行改写",
};

function AssessmentNote({
  label,
  record,
}: {
  label: string;
  record: RubricAssessment | null;
}) {
  if (record === null) return null;
  const evidences = record.ratings.filter((r) => r.evidence !== undefined);
  if (record.note === "" && evidences.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{label}</span>
      {evidences.map((r) => (
        <span key={r.id}>
          {r.id}：{r.evidence}
        </span>
      ))}
      {record.note !== "" && <span>{record.note}</span>}
    </div>
  );
}

export function RubricReviewSection({
  attemptId,
  question,
}: {
  attemptId: string;
  question: AttemptResultQuestion;
}) {
  const client = useQueryClient();
  const projected = question.rubricReview ?? null;
  const [override, setOverride] = useState<RubricReview | null>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localPendingTask, setLocalPendingTask] = useState<string | null>(null);
  const agentMutationRef = useRef<string | null>(null);
  const scope = `${attemptId}:${question.questionId}`;
  const projectedKey = JSON.stringify(projected);

  // 换题重置；服务端投影更新后以投影为准（override 只是等待 refetch 的过渡）
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope/projectedKey 是重置的变更键
  useEffect(() => {
    setOverride(null);
    setPanel("none");
    setError(null);
    setLocalPendingTask(null);
    agentMutationRef.current = null;
  }, [scope, projectedKey]);

  const pendingTask =
    (override ?? projected)?.pendingAgentTaskId ?? localPendingTask;
  // 判卷任务在途：按周期刷新本卷缓存，回信落地（pendingAgentTaskId 归零、
  // agent 记录出现）后由投影接管并停止
  useEffect(() => {
    if (pendingTask === null) return;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void client.invalidateQueries({
        queryKey: ["student", "attempt", attemptId],
      });
    };
    const timer = window.setInterval(tick, RUBRIC_PENDING_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [pendingTask, attemptId, client]);

  if (projected === null) return null;
  const review = override ?? projected;
  const { rubric } = review;
  const disagreements =
    review.self !== null && review.agent !== null
      ? new Set(
          rubricDisagreementsOf(review.self.ratings, review.agent.ratings),
        )
      : new Set<string>();
  const effective = rubricEffectiveOf(review);
  const max = rubricMaxOf(rubric);

  const invalidate = () => {
    void client.invalidateQueries({
      queryKey: ["student", "attempt", attemptId],
    });
  };

  const run = async (action: () => Promise<RubricReview>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setOverride(await action());
      setPanel("none");
      invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请稍后重试");
      if (cause instanceof ApiError && cause.code === "RUBRIC_NOT_AVAILABLE") {
        invalidate();
      }
    } finally {
      setBusy(false);
    }
  };

  const saveSelf = (ratings: RubricRating[], note: string) =>
    run(() =>
      saveRubricSelfApi(attemptId, question.questionId, { ratings, note }),
    );
  const saveFinal = (
    decision: RubricDecision,
    ratings?: RubricRating[],
    note = "",
  ) =>
    run(() =>
      saveRubricFinalApi(attemptId, question.questionId, {
        decision,
        ...(ratings !== undefined ? { ratings } : {}),
        note,
      }),
    );

  const requestAgent = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await fetchStudentAiStatusApi(
        attemptId,
        question.questionId,
      );
      if (
        status.channelDefault === null ||
        status.firstUseRequired ||
        !status.connectionReady
      ) {
        setError(
          status.channelDefault === null || status.firstUseRequired
            ? "还没有可用的 AI 连接，请先到「AI 伴学」完成连接设置"
            : "默认 AI 连接需要重新验证，请到设置中更新",
        );
        return;
      }
      // 同一次点击的重试复用幂等键（网络抖动不建两个任务）
      agentMutationRef.current ??= randomUuid();
      const task = await createStudentAiTaskApi({
        attemptId,
        questionId: question.questionId,
        question: AGENT_PROMPT,
        channel: status.channelDefault,
        materials: { annotation: false, draft: false, formalInk: false },
        mutationId: agentMutationRef.current,
        purpose: "rubric_opinion",
      });
      setLocalPendingTask(task.id);
      void client.invalidateQueries({
        queryKey: ["student", "ai-status", attemptId],
      });
      void client.invalidateQueries({
        queryKey: ["student", "ai-tasks", attemptId],
      });
      void client.invalidateQueries({ queryKey: studentAiQueueSummaryKey });
      invalidate();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "发起判卷失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="本题量表评价"
      className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 text-sm"
      data-slot="rubric-review"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">量表评价</p>
        <p role="status" className="text-xs text-muted-foreground">
          {effective === null
            ? "还没有评价——先按量表给自己打个分"
            : `生效 ${rubricTotalOf(effective)} / ${max}${
                review.final !== null
                  ? `（裁定：${DECISION_LABEL[review.final.decision]}）`
                  : "（自评，待裁定）"
              }`}
        </p>
      </div>

      <table className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1 pr-2 font-normal">评价项</th>
            <th className="w-16 py-1 text-center font-normal">我的</th>
            <th className="w-16 py-1 text-center font-normal">Agent</th>
            <th className="w-16 py-1 text-center font-normal">裁定</th>
          </tr>
        </thead>
        <tbody>
          {rubric.items.map((item) => {
            const differs = disagreements.has(item.id);
            return (
              <tr
                key={item.id}
                data-disagreement={differs ? "true" : undefined}
                className={`border-t border-border/50 ${differs ? "bg-amber-50 dark:bg-amber-950/30" : ""}`}
              >
                <td className="py-1.5 pr-2">
                  <span className="font-medium">{item.title}</span>
                  {item.desc !== undefined && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {item.desc}
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-center">
                  {levelCell(ratingOf(review.self, item.id))}
                </td>
                <td className="py-1.5 text-center">
                  {levelCell(ratingOf(review.agent, item.id))}
                </td>
                <td className="py-1.5 text-center">
                  {levelCell(ratingOf(review.final, item.id))}
                </td>
              </tr>
            );
          })}
          <tr className="border-t border-border/50 text-xs text-muted-foreground">
            <td className="py-1 pr-2">合计（满分 {max}）</td>
            <td className="py-1 text-center">
              {review.self === null ? "—" : rubricTotalOf(review.self.ratings)}
            </td>
            <td className="py-1 text-center">
              {review.agent === null
                ? "—"
                : rubricTotalOf(review.agent.ratings)}
            </td>
            <td className="py-1 text-center">
              {review.final === null
                ? "—"
                : rubricTotalOf(review.final.ratings)}
            </td>
          </tr>
        </tbody>
      </table>
      {disagreements.size > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          高亮行是你和 Agent 评得不一样的项，看一眼依据再裁定。
        </p>
      )}

      <AssessmentNote label="我的依据" record={review.self} />
      <AssessmentNote label="Agent 依据" record={review.agent} />
      {review.final !== null && review.final.note !== "" && (
        <p className="text-xs text-muted-foreground">
          裁定备注：{review.final.note}
        </p>
      )}

      {panel === "self" && (
        <RubricRatingForm
          rubric={rubric}
          initial={review.self?.ratings ?? null}
          initialNote={review.self?.note ?? ""}
          submitLabel="保存自评"
          busy={busy}
          onSubmit={(ratings, note) => void saveSelf(ratings, note)}
          onCancel={() => setPanel("none")}
        />
      )}
      {panel === "custom" && (
        <RubricRatingForm
          rubric={rubric}
          initial={effective}
          submitLabel="保存裁定"
          busy={busy}
          onSubmit={(ratings, note) => void saveFinal("custom", ratings, note)}
          onCancel={() => setPanel("none")}
        />
      )}

      {panel === "none" && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="min-h-11"
            variant={review.self === null ? "default" : "outline"}
            disabled={busy}
            onClick={() => setPanel("self")}
          >
            {review.self === null ? "按量表自评" : "修改自评"}
          </Button>
          {review.agent === null &&
            (pendingTask !== null ? (
              <span
                role="status"
                className="inline-flex min-h-11 items-center text-xs text-muted-foreground"
              >
                Agent 判卷中…回信后自动显示
              </span>
            ) : (
              <Button
                size="sm"
                className="min-h-11"
                variant="outline"
                disabled={busy}
                onClick={() => void requestAgent()}
              >
                请 Agent 判卷
              </Button>
            ))}
          {review.self !== null && (
            <Button
              size="sm"
              className="min-h-11"
              variant="ghost"
              disabled={busy || decisionAlreadyApplied(review, "self")}
              onClick={() => void saveFinal("self")}
            >
              保留我的
            </Button>
          )}
          {review.agent !== null && (
            <Button
              size="sm"
              className="min-h-11"
              variant="ghost"
              disabled={busy || decisionAlreadyApplied(review, "agent")}
              onClick={() => void saveFinal("agent")}
            >
              采纳 Agent
            </Button>
          )}
          {(review.self !== null || review.agent !== null) && (
            <Button
              size="sm"
              className="min-h-11"
              variant="ghost"
              disabled={busy}
              onClick={() => setPanel("custom")}
            >
              自行改写
            </Button>
          )}
        </div>
      )}
      {busy && <p className="text-xs text-muted-foreground">正在处理…</p>}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
