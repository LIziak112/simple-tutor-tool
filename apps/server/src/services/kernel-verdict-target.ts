import { eq } from "drizzle-orm";
import { LearningError, type ReviewAccess } from "learning-kernel";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  type ResponseRow,
  students,
  teachers,
} from "../db/schema.ts";
import type { kernelResponseMarks } from "../db/schema-kernel-question-delivery.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  type KernelRuntime,
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import type { DeliveryTicket } from "./kernel-question-delivery-ticket.ts";

export type MarkIntent = typeof kernelResponseMarks.$inferSelect;

type Mode = "verdicts" | "choiceConfirmation";
// 宿主目标模式对应内核交付形态；评阅授权须两者一致。
const deliveryOf = {
  verdicts: "questionDelivery",
  choiceConfirmation: "choiceConfirmation",
} as const satisfies Record<Mode, ReviewAccess["delivery"]>;
export type VerdictTarget = Pick<
  DeliveryTicket,
  "stepAttemptId" | "operationId" | "slotId" | "practiceVersion"
> & {
  receiptId: string;
  questionIds: readonly string[];
} & (
    | { mode: "verdicts"; source: DeliveryTicket["intent"]["source"] }
    | { mode: "choiceConfirmation"; originalTeacherId: string }
  );

const keyOf = ({ stepAttemptId, operationId }: VerdictTarget) => ({
  protocolVersion: 1 as const,
  stepAttemptId,
  operationId,
});

function readReview(
  runtime: KernelRuntime,
  attempt: Attempt,
  practiceId: string,
  target: VerdictTarget,
  reviewerId: string,
) {
  const reviewer = { role: "reviewer", id: reviewerId } as const;
  const key = keyOf(target);
  const review =
    target.mode === "choiceConfirmation"
      ? runtime.readQuestionDeliveryReview(
          reviewer,
          attempt.id,
          key,
          "choiceConfirmation",
        )
      : runtime.readQuestionDeliveryReview(
          reviewer,
          attempt.id,
          key,
          "verdicts",
        );
  if (
    review.receipt.id !== target.receiptId ||
    review.receipt.stepAttemptId !== target.stepAttemptId ||
    review.receipt.slotId !== target.slotId ||
    review.practice.id !== practiceId ||
    review.practice.version !== target.practiceVersion ||
    review.questions.length !== target.questionIds.length ||
    (target.mode === "verdicts" &&
      (!("source" in review.confirmation) ||
        review.confirmation.source !== target.source))
  )
    kernelAttemptUnavailable();
  return review;
}

export type VerdictReview = ReturnType<typeof readReview>;

export function verdictFor(review: VerdictReview, row: ResponseRow) {
  const verdict = review.questions.find(
    (item) => item.questionId === row.questionId,
  );
  if (!verdict || verdict.questionVersion !== row.questionVersion)
    kernelAttemptUnavailable();
  return verdict;
}

export type TargetReviewer = {
  reviewerId: string;
  canMark: boolean;
  read: () => VerdictReview;
  write: (
    row: ResponseRow,
    intent: MarkIntent,
    review: VerdictReview,
    replay: boolean,
  ) => ReturnType<KernelRuntime["writeQuestionDeliveryVerdict"]>;
};

/** 仅对已经核验的原确认位置授权；重取已接受操作仍校验原批改教师。 */
export function withVerdictTargets<T>(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  practiceId: string,
  run: (open: (target: VerdictTarget) => TargetReviewer) => T,
) {
  const owner = db
    .select({ teacherId: students.teacherId, disabledAt: teachers.disabledAt })
    .from(students)
    .innerJoin(teachers, eq(teachers.id, students.teacherId))
    .where(eq(students.id, attempt.studentId))
    .get();
  let active: { target: VerdictTarget; reviewerId: string } | undefined;
  let permitted:
    | {
        teacherId: string;
        row: ResponseRow;
        command: NonNullable<MarkIntent["command"]>;
      }
    | undefined;
  const matches = (scope: ReviewAccess, reviewerId: string) =>
    active !== undefined &&
    deliveryOf[active.target.mode] === scope.delivery &&
    scope.reviewerId === reviewerId &&
    scope.studentId === attempt.studentId &&
    scope.activityId === attempt.id &&
    scope.stepAttemptId === active.target.stepAttemptId &&
    scope.operationId === active.target.operationId &&
    scope.submissionId === active.target.receiptId &&
    scope.slotId === active.target.slotId;
  const mayRead = (scope: ReviewAccess) =>
    active !== undefined && matches(scope, active.reviewerId);
  const mayWrite = (
    scope: Extract<ReviewAccess, { purpose: "reviseVerdict" }>,
  ) =>
    permitted !== undefined &&
    matches(scope, permitted.teacherId) &&
    scope.targetId === permitted.command.targetId &&
    scope.questionId === permitted.row.questionId &&
    scope.questionVersion === permitted.row.questionVersion &&
    scope.action === permitted.command.action;
  return withKernelRuntime(
    db,
    dataDir,
    false,
    (runtime) =>
      run((target) => {
        const reviewerId =
          target.mode === "choiceConfirmation"
            ? target.originalTeacherId
            : owner?.teacherId;
        if (!reviewerId) kernelAttemptUnavailable();
        active = { target, reviewerId };
        const canMark =
          reviewerId === owner?.teacherId && owner?.disabledAt === null;
        return {
          reviewerId,
          canMark,
          read: () =>
            readReview(runtime, attempt, practiceId, target, reviewerId),
          write(row, intent, review, replay) {
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
              verdictFor(review, row).revision !==
                intent.baseRevision + (replay ? 1 : 0) ||
              (target.mode === "choiceConfirmation" &&
                intent.teacherId !== reviewerId) ||
              (command.action === "override"
                ? intent.mark !== (command.correct ? "correct" : "wrong")
                : intent.mark !== null)
            )
              kernelAttemptUnavailable();
            if (!replay && (!canMark || intent.teacherId !== reviewerId))
              throw new HttpError(403, "FORBIDDEN", "已无权批改这份作答");
            const reviewer = {
              role: "reviewer",
              id: intent.teacherId,
            } as const;
            const key = keyOf(target);
            permitted = { teacherId: intent.teacherId, row, command };
            try {
              return target.mode === "choiceConfirmation"
                ? runtime.writeQuestionDeliveryVerdict(
                    reviewer,
                    attempt.id,
                    key,
                    command,
                    target.mode,
                  )
                : runtime.writeQuestionDeliveryVerdict(
                    reviewer,
                    attempt.id,
                    key,
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
          },
        };
      }),
    {
      authorizeReview: (access) =>
        access.purpose === "readReview" ? mayRead(access) : mayWrite(access),
    },
  );
}
