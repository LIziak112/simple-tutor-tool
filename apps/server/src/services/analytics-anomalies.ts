import type {
  AnalyticsAnomalyQuestion,
  AnalyticsQuestionRow,
} from "@tutor/contract";
import type { Attempt } from "../db/schema";
import type { AnalyticsContext } from "./analytics-context";
import { timeSeconds } from "./analytics-time";
import { snapshotOfRow } from "./snapshot";

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
// ---------- 用时异常题（D6） ----------

/**
 * 学生的用时异常题：activeSec > 该题中位数 2 倍（slow）或 hintsUsed ≥ 2
 * （hints）；中位数取 ctx.domainMedianByQuestion（域内全部已交作答口径，见
 * buildContext 注释）。按提交时间倒序。
 */
export function buildAnomalies(
  ctx: AnalyticsContext,
  scoped: readonly Attempt[],
): AnalyticsAnomalyQuestion[] {
  const out: AnalyticsAnomalyQuestion[] = [];
  for (const attempt of scoped) {
    for (const response of ctx.responsesByAttempt.get(attempt.id) ?? []) {
      const medianSec =
        ctx.domainMedianByQuestion.get(response.questionId) ?? null;
      const time = ctx.times.responseTime.get(response.id);
      const timeSec = timeSeconds(time);
      const timeMedianSec = ctx.times.median(response.questionId, time);
      const reasons: Array<"slow" | "hints"> = [];
      if (
        timeSec !== null &&
        timeMedianSec !== null &&
        timeSec > 2 * timeMedianSec
      ) {
        reasons.push("slow");
      }
      if (response.hintsUsed >= 2) reasons.push("hints");
      if (reasons.length === 0) continue;
      const snapshot = snapshotOfRow(response);
      const meta = ctx.questionMeta.get(response.questionId);
      out.push({
        attemptId: attempt.id,
        questionId: response.questionId,
        stemMd: snapshot?.stemMd ?? meta?.stemMd ?? "",
        type:
          snapshot?.type ??
          (meta?.type as AnalyticsQuestionRow["type"] | undefined) ??
          "fill",
        difficulty: snapshot?.difficulty ?? meta?.difficulty ?? 2,
        knowledge:
          snapshot?.knowledge ??
          ctx.knowledgeFallback.get(response.questionId) ??
          [],
        time,
        timeMedianSec,
        activeSec: response.activeSec,
        medianSec,
        multipleOfMedian:
          timeSec !== null && timeMedianSec !== null && timeMedianSec > 0
            ? round2(timeSec / timeMedianSec)
            : null,
        hintsUsed: response.hintsUsed,
        reasons,
        submittedAt: attempt.submittedAt ?? "",
      });
    }
  }
  return out.sort(
    (a, b) =>
      b.submittedAt.localeCompare(a.submittedAt) ||
      a.questionId.localeCompare(b.questionId),
  );
}
