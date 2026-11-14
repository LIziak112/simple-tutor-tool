import { effectiveVerdictOf } from "./self-review.ts";
/** 已授权结果的显示裁决；不判分、不从答案推测对错。 */
export interface ReviewVerdictInput {
  answered: boolean;
  teacherMark: "correct" | "wrong" | null;
  selfReviewVerdict: "correct" | "wrong" | null;
  autoCorrect: boolean | null;
  finalCorrect: boolean | null;
  gradingPolicy?: "auto" | "reference_self" | "manual_only" | null | undefined;
}
export interface ReviewVerdictDisplay {
  verdict: boolean | null;
  source: "teacher" | "self" | "auto" | null;
  pendingLabel?: string;
  correctLabel?: string;
  wrongLabel?: string;
  notDone?: boolean;
}
export function reviewVerdictOf(q: ReviewVerdictInput): ReviewVerdictDisplay {
  const effective = effectiveVerdictOf(
    q.autoCorrect,
    q.teacherMark,
    q.selfReviewVerdict === null ? null : { verdict: q.selfReviewVerdict },
  );
  if (effective?.source === "teacher")
    return { verdict: effective.value, source: effective.source };
  if (q.selfReviewVerdict !== null)
    return {
      verdict: q.selfReviewVerdict === "correct",
      source: "self",
      correctLabel: "自评正确",
      wrongLabel: "自评错误",
    };
  if (q.gradingPolicy === "reference_self")
    return { verdict: null, source: null, pendingLabel: "已完成、待自评" };
  const verdict = q.finalCorrect ?? effective?.value ?? null;
  return {
    verdict,
    source: verdict === null ? null : "auto",
    ...(verdict === false && !q.answered ? { notDone: true } : {}),
  };
}

/** 只圈本轮服务端已判定候选，保持错题重练现有门槛。 */
export function reviewRetrainableOf(
  q: ReviewVerdictInput & { studentFlag?: "unsure" | null | undefined },
): boolean {
  if (q.finalCorrect === null && q.selfReviewVerdict === null) return false;
  if (q.studentFlag === "unsure") return true;
  return (
    reviewVerdictOf(q).verdict === false &&
    (q.answered || q.teacherMark !== null || q.selfReviewVerdict !== null)
  );
}
