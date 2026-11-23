import type { AttemptSubmitRequest } from "@tutor/contract";
import { eq, max } from "drizzle-orm";
import type { openLearningRuntime } from "learning-kernel";
import { z } from "zod";
import { attemptEventReceipts } from "../db/attempt-time-schema.ts";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  attempts,
  type ResponseRow,
  responses,
} from "../db/schema.ts";
import { sealResponseTimeWithin } from "./attempt-time-seal.ts";
import {
  recordConfirmedSubmit,
  submissionActivityOf,
} from "./event-service.ts";
import { kernelConfirmationTicketFor } from "./kernel-assignment-confirmation-ticket.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import { submittedTimePatchOf } from "./submission-time.ts";

type Runtime = ReturnType<typeof openLearningRuntime>;
type ChangeCounts = ReturnType<
  Runtime["recoverChoiceConfirmation"]
>["choiceDraftChangeCounts"];

const activitySealRequestSchema = z.object({
  activitySeal: z
    .object({
      receivedThroughSeq: z.int().nonnegative(),
      responses: z.array(
        z.object({
          responseId: z.string(),
          activeSec: z.int().nonnegative().nullable(),
          changeCount: z.int().nonnegative(),
        }),
      ),
    })
    .optional(),
});

export function kernelActivitySealOf(request: unknown) {
  const parsed = activitySealRequestSchema.safeParse(request);
  if (!parsed.success) kernelAttemptUnavailable();
  return parsed.data.activitySeal;
}

export function captureKernelConfirmationRequest(
  db: Db,
  attemptId: string,
  request: AttemptSubmitRequest,
) {
  const { activeSecByQuestion, eventChangeCountByQuestion } =
    submissionActivityOf(db, attemptId);
  const lastReceipt = db
    .select({ seq: max(attemptEventReceipts.seq) })
    .from(attemptEventReceipts)
    .where(eq(attemptEventReceipts.attemptId, attemptId))
    .get();
  return {
    ...request,
    activitySeal: {
      receivedThroughSeq: lastReceipt?.seq ?? 0,
      responses: request.revisions.map(
        ({ questionId, questionRevisionId }) => ({
          responseId: questionRevisionId,
          ...submittedTimePatchOf(activeSecByQuestion, questionId),
          changeCount: eventChangeCountByQuestion[questionId] ?? 0,
        }),
      ),
    },
  };
}

export function projectKernelConfirmedActivity(
  db: Db,
  attempt: Attempt,
  operationId: string,
  confirmedAt: string,
  rows: readonly ResponseRow[],
  counts: ChangeCounts,
): ResponseRow[] {
  let seal: ReturnType<typeof kernelActivitySealOf>;
  if (attempt.status === "draft") {
    const ticket = kernelConfirmationTicketFor(db, attempt.id);
    if (ticket?.operationId !== operationId) kernelAttemptUnavailable();
    seal = kernelActivitySealOf(ticket.request);
  }
  const recorded = new Map(seal?.responses.map((row) => [row.responseId, row]));
  if (
    seal &&
    (recorded.size !== rows.length || rows.some(({ id }) => !recorded.has(id)))
  )
    kernelAttemptUnavailable();

  const savedChanges = new Map(
    counts.map(({ questionId, changeCount }) => [questionId, changeCount]),
  );
  const projected = rows.map((row) => {
    const activity = recorded.get(row.id);
    return {
      ...row,
      activeSec: activity ? activity.activeSec : row.activeSec,
      changeCount: Math.max(
        activity?.changeCount ?? row.changeCount,
        savedChanges.get(row.questionId) ?? 0,
      ),
    };
  });
  if (seal) {
    sealResponseTimeWithin(
      db,
      attempt.id,
      rows.map(({ id }) => id),
      confirmedAt,
      seal.receivedThroughSeq,
    );
    for (const { id, activeSec, changeCount } of projected) {
      db.update(responses)
        .set({ activeSec, changeCount })
        .where(eq(responses.id, id))
        .run();
    }
    recordConfirmedSubmit(db, attempt, confirmedAt);
  }
  return projected;
}

export function projectKernelDraftActivity(
  db: Db,
  attempt: Attempt,
  runtime: Runtime,
): Attempt {
  if (attempt.status !== "draft") return attempt;
  const times = runtime.readChoiceDraftActivity(
    { role: "student", id: attempt.studentId },
    attempt.id,
  );
  if (times === undefined) return attempt;
  const { firstChangedAt, lastChangedAt } = times;
  const activatedAt =
    firstChangedAt !== null &&
    (attempt.activatedAt === null || firstChangedAt < attempt.activatedAt)
      ? firstChangedAt
      : attempt.activatedAt;
  const previousActivity = attempt.lastActivityAt ?? attempt.startedAt;
  const lastActivityAt =
    lastChangedAt === null
      ? attempt.lastActivityAt
      : lastChangedAt > previousActivity
        ? lastChangedAt
        : previousActivity;
  if (
    activatedAt === attempt.activatedAt &&
    lastActivityAt === attempt.lastActivityAt
  )
    return attempt;
  db.update(attempts)
    .set({ activatedAt, lastActivityAt })
    .where(eq(attempts.id, attempt.id))
    .run();
  return { ...attempt, activatedAt, lastActivityAt };
}
