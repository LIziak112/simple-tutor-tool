import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { Attempt } from "../db/schema.ts";
import { kernelAttemptConfirmations } from "../db/schema-kernel-assignments.ts";
import {
  type KernelAttemptBinding,
  kernelAttemptUnavailable,
  withBoundKernelActivity,
} from "./kernel-assignment-runtime.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery.ts";

export type KernelConfirmationTicket =
  typeof kernelAttemptConfirmations.$inferSelect;

export function kernelConfirmationTicketFor(
  db: Pick<Db, "select">,
  attemptId: string,
): KernelConfirmationTicket | undefined {
  return db
    .select()
    .from(kernelAttemptConfirmations)
    .where(eq(kernelAttemptConfirmations.attemptId, attemptId))
    .get();
}

type ConfirmationBinding = Pick<
  KernelAttemptBinding,
  "stepAttemptId" | "practiceVersion"
>;

export function assertConfirmationBinding(
  expected: ConfirmationBinding,
  binding: ConfirmationBinding,
): void {
  if (
    expected.stepAttemptId !== binding.stepAttemptId ||
    expected.practiceVersion !== binding.practiceVersion
  )
    kernelAttemptUnavailable();
}

/** 调用方持有宿主写锁。交卷前必先落持久预留，且确认也要取得同一把锁。 */
export function submissionLocked(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  questionId?: string,
): boolean {
  const delivery = readQuestionDeliveryFacts(db, dataDir, attempt);
  if (delivery)
    return (
      delivery.attempt.status !== "draft" ||
      delivery.rows.some(
        (row) => row.questionId === questionId && row.submittedAt !== null,
      )
    );
  const ticket = kernelConfirmationTicketFor(db, attempt.id);
  if (ticket === undefined) return false;
  return withBoundKernelActivity(
    db,
    dataDir,
    attempt,
    (_runtime, activity, stepAttemptId, practiceVersion) => {
      assertConfirmationBinding(ticket, { stepAttemptId, practiceVersion });
      if (activity.status === "completed") return true;
      if (activity.status === "active") return false;
      return kernelAttemptUnavailable();
    },
  );
}
