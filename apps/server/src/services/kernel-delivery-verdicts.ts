import { type MarkResponseData, markResponseDataSchema } from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import type { VerdictReceipt } from "learning-kernel";
import type { Db } from "../db/client.ts";
import { type Attempt, type ResponseRow, responses } from "../db/schema.ts";
import { kernelResponseMarks } from "../db/schema-kernel-question-delivery.ts";
import {
  attemptFinalOutcomeOf,
  needsTeacherMark,
} from "./attempt-final-outcome.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import {
  type MarkIntent,
  type TargetReviewer,
  type VerdictReview,
  type VerdictTarget,
  verdictFor,
  withVerdictTargets,
} from "./kernel-verdict-target.ts";

type VerdictFacts = { attempt: Attempt; rows: ResponseRow[] };
type QuestionVerdict = VerdictReview["questions"][number];

export type ReviewedQuestion = {
  submissionId: string;
  targetId: string;
  reviewerId: string;
  canMark: boolean;
  verdict: QuestionVerdict;
};

export function responseMarkKey({
  attemptId,
  teacherId,
  operationId,
}: Pick<MarkIntent, "attemptId" | "teacherId" | "operationId">) {
  return and(
    eq(kernelResponseMarks.attemptId, attemptId),
    eq(kernelResponseMarks.teacherId, teacherId),
    eq(kernelResponseMarks.operationId, operationId),
  );
}

export function responseMarkResult(
  facts: VerdictFacts,
  row: ResponseRow,
  revision: number,
  eventId?: string,
): MarkResponseData {
  return markResponseDataSchema.parse({
    responseId: row.id,
    questionId: row.questionId,
    attemptId: facts.attempt.id,
    teacherMark: row.teacherMark,
    teacherComment: row.teacherComment,
    finalCorrect: row.finalCorrect,
    attemptStatus: facts.attempt.status === "graded" ? "graded" : "submitted",
    scoreFinal: facts.attempt.scoreFinal,
    pendingCount: facts.rows.filter(
      (row) =>
        (facts.attempt.status !== "draft" || row.submittedAt !== null) &&
        needsTeacherMark(row),
    ).length,
    revision,
    ...(eventId === undefined ? {} : { eventId }),
  });
}

/** 已判题的生效判定；宿主发布声明了 gradingBasis，缺失即读面不一致。 */
export function effectiveOf(verdict: QuestionVerdict) {
  if (verdict.status !== "judged") return undefined;
  if (!verdict.effective) kernelAttemptUnavailable();
  return verdict.effective;
}

export function subjectOf(verdict: QuestionVerdict) {
  const effective = effectiveOf(verdict);
  return effective?.source === "teacherReview" ? effective : undefined;
}

/** 调用方已核验确认归属并持有主库写锁。评语只保存在宿主。 */
export function projectKernelVerdicts(
  db: Db,
  dataDir: string,
  facts: VerdictFacts,
  practiceId: string,
  targets: readonly VerdictTarget[],
  newIntent?: MarkIntent,
) {
  const { attempt } = facts;
  return withVerdictTargets(db, dataDir, attempt, practiceId, (open) => {
    const history = db
      .select()
      .from(kernelResponseMarks)
      .where(eq(kernelResponseMarks.attemptId, attempt.id))
      .all();
    const latest = new Map<string, MarkResponseData>();
    const pending = new Map<string, MarkIntent>();
    const accepted: { intent: MarkIntent; result: MarkResponseData }[] = [];
    for (const intent of history) {
      if (!intent.result) {
        pending.set(intent.responseId, intent);
        continue;
      }
      const result = markResponseDataSchema.parse(intent.result);
      if (!result.eventId) continue;
      accepted.push({ intent, result });
      if (
        (result.revision ?? 0) > (latest.get(intent.responseId)?.revision ?? 0)
      )
        latest.set(intent.responseId, result);
    }
    // 统一撤销：按修订重放已接受的改判，撤销只撤当前生效的一条，回落到上一条仍有效的教师判定。
    const active = new Map<string, string[]>();
    for (const { intent, result } of accepted.toSorted(
      (a, b) => (a.result.revision ?? 0) - (b.result.revision ?? 0),
    )) {
      const stack = active.get(intent.responseId) ?? [];
      if (intent.command?.action === "withdraw") {
        if (stack.at(-1) !== intent.command.withdrawId)
          kernelAttemptUnavailable();
        stack.pop();
      } else if (result.eventId) stack.push(result.eventId);
      active.set(intent.responseId, stack);
    }
    const activeTeacherMark = (responseId: string) =>
      active.get(responseId)?.at(-1);

    const written: { intent: MarkIntent; receipt: VerdictReceipt }[] = [];
    const reviews = new Map<string, ReviewedQuestion>();
    const byQuestion = new Map(facts.rows.map((row) => [row.questionId, row]));
    const project = (
      reviewer: TargetReviewer,
      row: ResponseRow,
      review: VerdictReview,
      newReceipt?: VerdictReceipt,
    ) => {
      const question = verdictFor(review, row);
      reviews.set(row.questionId, {
        submissionId: review.receipt.id,
        targetId: review.targetId,
        reviewerId: reviewer.reviewerId,
        canMark: reviewer.canMark,
        verdict: question,
      });
      const subject = subjectOf(question);
      const automatic = question.automatic?.valid
        ? question.automatic.correct
        : null;
      const previous = latest.get(row.id);
      const previousRevision = previous?.revision ?? 0;
      let comment = row.teacherComment;
      if (question.revision !== previousRevision) {
        const intent = pending.get(row.id);
        if (!intent?.command || intent.baseRevision !== previousRevision)
          kernelAttemptUnavailable();
        // 只有已经推进过该修订的操作可重取，读取不执行尚未接受的批改。
        const receipt = newReceipt ?? reviewer.write(row, intent, review, true);
        if (
          !receipt ||
          receipt.revision !== question.revision ||
          receipt.questionId !== row.questionId ||
          receipt.submissionId !== review.receipt.id ||
          receipt.targetId !== review.targetId ||
          (intent.command.action === "withdraw"
            ? intent.command.withdrawId !== activeTeacherMark(row.id) ||
              subject?.id !== active.get(row.id)?.slice(0, -1).at(-1)
            : subject?.id !== receipt.id)
        )
          kernelAttemptUnavailable();
        written.push({ intent, receipt });
        comment = intent.comment;
      } else if (subject?.id !== activeTeacherMark(row.id))
        kernelAttemptUnavailable();
      if (
        automatic !== row.autoCorrect ||
        question.status === "pendingEvaluation"
      )
        kernelAttemptUnavailable();
      return {
        ...row,
        teacherMark: subject ? (subject.correct ? "correct" : "wrong") : null,
        teacherComment: comment,
        finalCorrect: effectiveOf(question)?.correct ?? null,
      };
    };
    let foundTarget = false;
    for (const scope of targets) {
      const reviewer = open(scope);
      const selected = scope.questionIds.map((id) => {
        const row = byQuestion.get(id);
        if (!row || reviews.has(id)) kernelAttemptUnavailable();
        return row;
      });
      let review = reviewer.read();
      const target = selected.find((row) => row.id === newIntent?.responseId);
      let receipt: VerdictReceipt | undefined;
      if (newIntent && target) {
        foundTarget = true;
        if (verdictFor(review, target).revision === newIntent.baseRevision) {
          receipt = reviewer.write(target, newIntent, review, false);
          review = reviewer.read();
        }
      }
      for (const row of selected)
        byQuestion.set(
          row.questionId,
          project(
            reviewer,
            row,
            review,
            target?.id === row.id ? receipt : undefined,
          ),
        );
    }
    if (newIntent && !foundTarget) kernelAttemptUnavailable();
    const rows = [...byQuestion.values()];
    const projected = {
      rows,
      reviews,
      attempt:
        attempt.status === "draft"
          ? attempt
          : {
              ...attempt,
              ...attemptFinalOutcomeOf(rows, { finalized: true }),
            },
    };
    for (const { intent, receipt } of written) {
      const row = rows.find(({ id }) => id === intent.responseId);
      if (!row) kernelAttemptUnavailable();
      db.update(responses)
        .set({ teacherComment: intent.comment })
        .where(eq(responses.id, row.id))
        .run();
      const result = responseMarkResult(
        projected,
        row,
        receipt.revision,
        receipt.id,
      );
      const saved = db
        .update(kernelResponseMarks)
        .set({ result })
        .where(and(responseMarkKey(intent), isNull(kernelResponseMarks.result)))
        .run();
      if (saved.changes !== 1) kernelAttemptUnavailable();
    }
    return projected;
  });
}
