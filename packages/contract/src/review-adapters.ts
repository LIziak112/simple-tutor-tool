import type { AttemptResultQuestion, AttemptResultUnit } from "./attempt.ts";
import type { AttemptActivity } from "./attempt-activity.ts";
import type { ReviewQuestionFact } from "./review-facts.ts";
import { reviewRetrainableOf, reviewVerdictOf } from "./review-verdict.ts";
import type { TeacherAttemptDetailQuestion } from "./teacher-attempt-api.ts";
/** 学生与教师的已授权投影适配到同一事实；不读取答案内容、不重新判分。 */
export function studentReviewFact(
  q: AttemptResultQuestion,
  unit: Pick<AttemptResultUnit, "id" | "title">,
  released: boolean,
  activity?: AttemptActivity,
): ReviewQuestionFact {
  const verdict = reviewVerdictOf({
    ...q,
    selfReviewVerdict: q.selfReview?.record?.verdict ?? null,
  });
  return {
    questionId: q.questionId,
    questionRevisionId: q.questionRevisionId ?? null,
    unit: { id: unit.id, title: unit.title },
    settlementSeq: q.settlementSeq ?? null,
    type: q.snapshot.type,
    knowledge: q.snapshot.knowledge,
    materialIds: q.materialIds ?? [
      ...new Set(
        (q.publicQuestion?.materialRefs ?? q.snapshot.materialRefs ?? []).map(
          (r) => r.material,
        ),
      ),
    ],
    retrainable:
      released &&
      reviewRetrainableOf({
        ...q,
        selfReviewVerdict: q.selfReview?.record?.verdict ?? null,
      }),
    answered: q.answered,
    verdict: released ? verdict.verdict : null,
    judgmentSource: released ? verdict.source : null,
    gradingPolicy: released ? (q.gradingPolicy ?? null) : null,
    rubricReview: released ? (q.rubricReview ?? null) : null,
    activeSec:
      q.activeSec !== undefined
        ? q.activeSec
        : (activity?.byQuestion[q.questionId]?.activeSec ?? null),
    changeCount: q.changeCount ?? null,
    hintsUsed: q.hintsUsed ?? q.hintsOpened.length,
    studentFlag: q.studentFlag,
    hasHandwriting: q.hasHandwriting ?? null,
    hasScratch: q.hasScratch ?? null,
    memoSequences: q.memoSequences ?? null,
  };
}
export function teacherReviewFact(
  q: TeacherAttemptDetailQuestion,
  released: boolean,
): ReviewQuestionFact {
  const verdict = reviewVerdictOf({
    ...q,
    selfReviewVerdict: q.selfReview?.verdict ?? null,
  });
  return {
    retrainable:
      released &&
      reviewRetrainableOf({
        ...q,
        selfReviewVerdict: q.selfReview?.verdict ?? null,
      }),
    questionId: q.questionId,
    questionRevisionId: q.responseId,
    unit: { id: q.unitId, title: q.unitTitle },
    settlementSeq: q.settlementSeq ?? null,
    type: q.type,
    knowledge: q.knowledge,
    materialIds: q.materialIds ?? [
      ...new Set((q.publicQuestion?.materialRefs ?? []).map((r) => r.material)),
    ],
    answered: q.answered,
    verdict: released ? verdict.verdict : null,
    judgmentSource: released ? verdict.source : null,
    gradingPolicy: released ? (q.gradingPolicy ?? null) : null,
    rubricReview: released ? (q.rubricReview ?? null) : null,
    activeSec: q.activeSec,
    changeCount: q.changeCount,
    hintsUsed: q.hintsUsed,
    studentFlag: q.studentFlag,
    hasHandwriting: q.ink?.hasStrokes ?? false,
    hasScratch: q.hasScratch ?? null,
    memoSequences: q.memoSequences ?? null,
  };
}
