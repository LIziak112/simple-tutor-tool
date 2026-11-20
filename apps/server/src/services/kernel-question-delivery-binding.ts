import { eq } from "drizzle-orm";
import type { StudentActivity } from "learning-kernel";
import type { Db } from "../db/client.ts";
import type { Attempt } from "../db/schema.ts";
import { kernelAttemptBindings } from "../db/schema-kernel-assignments.ts";
import { kernelLessonOpenings } from "../db/schema-kernel-question-delivery.ts";
import {
  type KernelRuntime,
  kernelAttemptUnavailable,
} from "./kernel-assignment-runtime.ts";
import { deliverySlotId } from "./kernel-question-delivery-publication.ts";

export function lessonKernelBinding(db: Pick<Db, "select">, attemptId: string) {
  return db
    .select()
    .from(kernelLessonOpenings)
    .where(eq(kernelLessonOpenings.attemptId, attemptId))
    .get();
}

export function questionDeliveryBinding(db: Db, attempt: Attempt) {
  if (attempt.sourceType === "lesson") {
    const binding = lessonKernelBinding(db, attempt.id);
    if (!binding) return undefined;
    if (
      binding.lectureId !== attempt.lectureId ||
      binding.studentId !== attempt.studentId ||
      binding.courseId !== attempt.courseId ||
      binding.attemptNo !== attempt.attemptNo ||
      binding.unitId !== attempt.unitId ||
      !binding.stepAttemptId
    )
      kernelAttemptUnavailable();
    return {
      practiceId: binding.practiceId,
      practiceVersion: binding.practiceVersion,
      stepAttemptId: binding.stepAttemptId,
      lectureId: binding.lectureId,
    };
  }
  if (attempt.sourceType !== "assignment") return undefined;
  const binding = db
    .select()
    .from(kernelAttemptBindings)
    .where(eq(kernelAttemptBindings.attemptId, attempt.id))
    .get();
  if (!binding) return undefined;
  if (binding.assignmentId !== attempt.assignmentId) kernelAttemptUnavailable();
  return {
    practiceId: binding.assignmentId,
    practiceVersion: binding.practiceVersion,
    stepAttemptId: binding.stepAttemptId,
  };
}

export type QuestionDeliveryBinding = NonNullable<
  ReturnType<typeof questionDeliveryBinding>
>;
export type QuestionDeliveryActivity = Extract<
  StudentActivity,
  { questionDeliveries: unknown }
>;

export function deliveryPolicy(activity: QuestionDeliveryActivity) {
  const slot = activity.step.submit?.slots[deliverySlotId];
  if (slot?.type !== "questionDelivery") kernelAttemptUnavailable();
  return slot.delivery;
}

export function readBoundQuestionDelivery(
  runtime: KernelRuntime,
  attempt: Attempt,
  binding: QuestionDeliveryBinding,
): QuestionDeliveryActivity | undefined {
  const activity = runtime.read(
    { role: "student", id: attempt.studentId },
    attempt.id,
  );
  if (!("questionDeliveries" in activity)) {
    if (binding.lectureId) kernelAttemptUnavailable();
    return undefined;
  }
  if (
    activity.activityId !== attempt.id ||
    activity.stepAttemptId !== binding.stepAttemptId ||
    activity.practiceVersion !== binding.practiceVersion ||
    activity.startedAt !== attempt.startedAt ||
    (deliveryPolicy(activity).mode === "perQuestion") !==
      (binding.lectureId !== undefined)
  )
    kernelAttemptUnavailable();
  return activity;
}
