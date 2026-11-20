import { type MarkResponseData, markResponseDataSchema } from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import {
  type AuthorizeQuestionDeliveryReview,
  LearningError,
  type VerdictReceipt,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  type ResponseRow,
  responses,
  students,
  teachers,
} from "../db/schema.ts";
import { kernelResponseMarks } from "../db/schema-kernel-question-delivery.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  attemptFinalOutcomeOf,
  needsTeacherMark,
} from "./attempt-final-outcome.ts";
import {
  type KernelRuntime,
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import type { DeliveryTicket } from "./kernel-question-delivery-ticket.ts";

export type MarkIntent = typeof kernelResponseMarks.$inferSelect;

type VerdictFacts = { attempt: Attempt; rows: ResponseRow[] };
type ReviewScope = Parameters<AuthorizeQuestionDeliveryReview>[0];

const readVerdicts = (
  runtime: KernelRuntime,
  reviewerId: string,
  activityId: string,
  key: Parameters<KernelRuntime["readQuestionDeliveryReview"]>[2],
) =>
  runtime.readQuestionDeliveryReview(
    { role: "reviewer", id: reviewerId },
    activityId,
    key,
    "verdicts",
  );
type DeliveryReview = ReturnType<typeof readVerdicts>;
type QuestionVerdict = DeliveryReview["questions"][number];

export type ReviewedQuestion = {
  submissionId: string;
  targetId: string;
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

export function subjectOf(verdict: QuestionVerdict) {
  return verdict.status === "judged" &&
    verdict.effective.source === "teacherReview"
    ? verdict.effective
    : undefined;
}

function verdictFor(review: DeliveryReview, row: ResponseRow) {
  const verdict = review.questions.find(
    (item) => item.questionId === row.questionId,
  );
  if (!verdict || verdict.questionVersion !== row.questionVersion)
    kernelAttemptUnavailable();
  return verdict;
}

/** 已核验票据与宿主响应的归属并持有主库写锁。评语只保存在宿主。 */
export function projectDeliveryVerdicts(
  db: Db,
  dataDir: string,
  facts: VerdictFacts,
  practiceId: string,
  tickets: readonly DeliveryTicket[],
  newIntent?: MarkIntent,
) {
  const { attempt } = facts;
  const owner = db
    .select({ teacherId: students.teacherId, disabledAt: teachers.disabledAt })
    .from(students)
    .innerJoin(teachers, eq(teachers.id, students.teacherId))
    .where(eq(students.id, attempt.studentId))
    .get();
  if (!owner?.teacherId) kernelAttemptUnavailable();
  const ownerId = owner.teacherId;
  let active: DeliveryTicket | undefined;
  const matchesScope = (scope: ReviewScope, reviewerId: string) =>
    active !== undefined &&
    scope.reviewerId === reviewerId &&
    scope.studentId === attempt.studentId &&
    scope.activityId === attempt.id &&
    scope.stepAttemptId === active.stepAttemptId &&
    scope.operationId === active.operationId &&
    scope.submissionId === active.receiptId &&
    scope.slotId === active.slotId;
  let permitted:
    | {
        teacherId: string;
        row: ResponseRow;
        command: NonNullable<MarkIntent["command"]>;
      }
    | undefined;
  return withKernelRuntime(
    db,
    dataDir,
    false,
    (runtime) => {
      const keyOf = (ticket: DeliveryTicket) => ({
        protocolVersion: 1 as const,
        stepAttemptId: ticket.stepAttemptId,
        operationId: ticket.operationId,
      });
      const read = (ticket: DeliveryTicket) => {
        const review = readVerdicts(
          runtime,
          ownerId,
          attempt.id,
          keyOf(ticket),
        );
        if (
          review.receipt.id !== ticket.receiptId ||
          review.receipt.stepAttemptId !== ticket.stepAttemptId ||
          review.receipt.slotId !== ticket.slotId ||
          review.practice.id !== practiceId ||
          review.practice.version !== ticket.practiceVersion ||
          review.confirmation.source !== ticket.intent.source ||
          review.questions.length !== ticket.intent.selectedQuestionIds.length
        )
          kernelAttemptUnavailable();
        return review;
      };
      const write = (
        ticket: DeliveryTicket,
        row: ResponseRow,
        intent: MarkIntent,
        review: DeliveryReview,
        replay: boolean,
      ) => {
        const { command } = intent;
        if (
          !command ||
          row.id !== intent.responseId ||
          intent.attemptId !== attempt.id ||
          command.operationId !== intent.operationId ||
          command.expectedRevision !== intent.baseRevision ||
          command.submissionId !== review.receipt.id ||
          command.targetId !== review.targetId ||
          command.questionId !== row.questionId ||
          (command.action === "override"
            ? intent.mark !== (command.correct ? "correct" : "wrong")
            : intent.mark !== null)
        )
          kernelAttemptUnavailable();
        const { revision } = verdictFor(review, row);
        if (
          replay
            ? revision !== intent.baseRevision + 1
            : revision !== intent.baseRevision
        )
          kernelAttemptUnavailable();
        if (
          !replay &&
          (intent.teacherId !== owner.teacherId || owner.disabledAt !== null)
        )
          throw new HttpError(403, "FORBIDDEN", "已无权批改这份作答");
        permitted = { teacherId: intent.teacherId, row, command };
        try {
          return runtime.writeQuestionDeliveryVerdict(
            { role: "reviewer", id: intent.teacherId },
            attempt.id,
            keyOf(ticket),
            command,
          );
        } catch (error) {
          if (
            !replay &&
            error instanceof LearningError &&
            (error.code === "VERDICT_CONFLICT" ||
              error.code === "OPERATION_CONFLICT")
          )
            throw new HttpError(
              409,
              error.code,
              "批改状态已更新，请刷新后重试",
            );
          throw error;
        } finally {
          permitted = undefined;
        }
      };

      const history = db
        .select()
        .from(kernelResponseMarks)
        .where(eq(kernelResponseMarks.attemptId, attempt.id))
        .all();
      const latest = new Map<string, MarkResponseData>();
      const pending = new Map<string, MarkIntent>();
      for (const intent of history) {
        if (!intent.result) {
          pending.set(intent.responseId, intent);
          continue;
        }
        const result = markResponseDataSchema.parse(intent.result);
        if (
          result.eventId &&
          (result.revision ?? 0) >
            (latest.get(intent.responseId)?.revision ?? 0)
        )
          latest.set(intent.responseId, result);
      }

      const accepted: { intent: MarkIntent; receipt: VerdictReceipt }[] = [];
      const reviews = new Map<string, ReviewedQuestion>();
      const byQuestion = new Map(
        facts.rows.map((row) => [row.questionId, row]),
      );
      const project = (
        ticket: DeliveryTicket,
        row: ResponseRow,
        review: DeliveryReview,
        newReceipt?: VerdictReceipt,
      ) => {
        const question = verdictFor(review, row);
        reviews.set(row.questionId, {
          submissionId: review.receipt.id,
          targetId: review.targetId,
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
          const receipt =
            newReceipt ?? write(ticket, row, intent, review, true);
          if (
            !receipt ||
            receipt.revision !== question.revision ||
            receipt.questionId !== row.questionId ||
            receipt.submissionId !== review.receipt.id ||
            receipt.targetId !== review.targetId ||
            (intent.mark === null
              ? subject !== undefined
              : subject?.id !== receipt.id)
          )
            kernelAttemptUnavailable();
          accepted.push({ intent, receipt });
          comment = intent.comment;
        } else if (
          (previous?.teacherMark != null && subject?.id !== previous.eventId) ||
          (previous?.teacherMark == null && subject !== undefined)
        )
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
          finalCorrect:
            question.status === "judged" ? question.effective.correct : null,
        };
      };
      let foundTarget = false;
      for (const ticket of tickets) {
        active = ticket;
        const selected = ticket.intent.selectedQuestionIds.map((id) => {
          const row = byQuestion.get(id);
          if (!row || reviews.has(id)) kernelAttemptUnavailable();
          return row;
        });
        let review = read(ticket);
        const target = selected.find((row) => row.id === newIntent?.responseId);
        let receipt: VerdictReceipt | undefined;
        if (newIntent && target) {
          foundTarget = true;
          if (verdictFor(review, target).revision === newIntent.baseRevision) {
            receipt = write(ticket, target, newIntent, review, false);
            review = read(ticket);
          }
        }
        for (const row of selected)
          byQuestion.set(
            row.questionId,
            project(
              ticket,
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
      for (const { intent, receipt } of accepted) {
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
          .where(
            and(responseMarkKey(intent), isNull(kernelResponseMarks.result)),
          )
          .run();
        if (saved.changes !== 1) kernelAttemptUnavailable();
      }
      return projected;
    },
    {
      authorizeQuestionDeliveryReview: (scope) => matchesScope(scope, ownerId),
      authorizeQuestionDeliveryVerdict: (scope) =>
        permitted !== undefined &&
        matchesScope(scope, permitted.teacherId) &&
        scope.targetId === permitted.command.targetId &&
        scope.questionId === permitted.row.questionId &&
        scope.questionVersion === permitted.row.questionVersion &&
        scope.action === permitted.command.action,
    },
  );
}
