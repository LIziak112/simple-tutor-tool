import { and, eq, isNull } from "drizzle-orm";
import type { StudentActivity } from "learning-kernel";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts } from "../db/schema.ts";
import { kernelAttemptBindings } from "../db/schema-kernel-assignments.ts";
import {
  kernelCourseOpenings,
  kernelLessonOpenings,
  kernelWrongOpenings,
} from "../db/schema-kernel-question-delivery.ts";
import { attemptResponseRows } from "./attempt-freeze.ts";
import { attemptTeacherId } from "./attempt-question-set.ts";
import { matchesKernelMaterialInputs } from "./kernel-assignment-publication.ts";
import {
  frozenKernelContextOf,
  type KernelRuntime,
  kernelAttemptUnavailable,
} from "./kernel-assignment-runtime.ts";
import { deliverySlotId } from "./kernel-question-delivery-publication.ts";
import { snapshotOfRow } from "./snapshot.ts";

export const wrongOpeningOperation = (id: string) => `open:wrong:${id}`;
export const wrongOpeningPractice = (id: string) => `wrong:${id}`;
export const wrongOpeningVersion = 1;

export const boundWrongAttemptId = (db: Db) =>
  db
    .select({ id: kernelWrongOpenings.attemptId })
    .from(kernelWrongOpenings)
    .where(eq(kernelWrongOpenings.attemptId, attempts.id));

export function wrongKernelBinding(db: Pick<Db, "select">, attemptId: string) {
  return db
    .select({
      id: kernelWrongOpenings.id,
      studentId: kernelWrongOpenings.studentId,
      teacherId: kernelWrongOpenings.teacherId,
      attemptNo: kernelWrongOpenings.attemptNo,
      stepAttemptId: kernelWrongOpenings.stepAttemptId,
    })
    .from(kernelWrongOpenings)
    .where(eq(kernelWrongOpenings.attemptId, attemptId))
    .get();
}

export function questionDeliveryRestrictions(db: Db, attempt: Attempt) {
  const course =
    attempt.sourceType === "course" &&
    courseKernelBinding(db, attempt.id) !== undefined;
  const wrong =
    attempt.sourceType === "wrong" &&
    wrongKernelBinding(db, attempt.id) !== undefined;
  return {
    fixedWhole: wrong || (course && attempt.timeLimitSec !== null),
    noPartialSettlement: course || wrong,
  };
}

export function lessonKernelBinding(db: Pick<Db, "select">, attemptId: string) {
  return db
    .select()
    .from(kernelLessonOpenings)
    .where(eq(kernelLessonOpenings.attemptId, attemptId))
    .get();
}

export function courseKernelBinding(db: Pick<Db, "select">, attemptId: string) {
  return db
    .select({
      courseId: kernelCourseOpenings.courseId,
      unitId: kernelCourseOpenings.unitId,
      studentId: kernelCourseOpenings.studentId,
      attemptNo: kernelCourseOpenings.attemptNo,
      practiceId: kernelCourseOpenings.practiceId,
      practiceVersion: kernelCourseOpenings.practiceVersion,
      stepAttemptId: kernelCourseOpenings.stepAttemptId,
      teacherId: kernelCourseOpenings.teacherId,
      pendingWorkflow: kernelCourseOpenings.pendingWorkflow,
    })
    .from(kernelCourseOpenings)
    .where(eq(kernelCourseOpenings.attemptId, attemptId))
    .get();
}

export function pendingKernelCourseOpening(
  db: Pick<Db, "select">,
  {
    studentId,
    courseId,
    unitId,
  }: Pick<Attempt, "studentId" | "courseId" | "unitId">,
) {
  if (courseId === null || unitId === null) return undefined;
  return db
    .select()
    .from(kernelCourseOpenings)
    .where(
      and(
        eq(kernelCourseOpenings.studentId, studentId),
        eq(kernelCourseOpenings.courseId, courseId),
        eq(kernelCourseOpenings.unitId, unitId),
        isNull(kernelCourseOpenings.attemptId),
      ),
    )
    .get();
}

export function questionDeliveryBinding(db: Db, attempt: Attempt) {
  if (attempt.sourceType === "course") {
    const binding = courseKernelBinding(db, attempt.id);
    if (!binding) return undefined;
    if (
      binding.courseId !== attempt.courseId ||
      binding.unitId !== attempt.unitId ||
      binding.studentId !== attempt.studentId ||
      binding.attemptNo !== attempt.attemptNo ||
      binding.teacherId !== attemptTeacherId(db, attempt) ||
      (attempt.feedbackMode !== "after_attempt" &&
        (attempt.feedbackMode !== "per_question" ||
          attempt.timeLimitSec !== null)) ||
      !binding.stepAttemptId
    )
      kernelAttemptUnavailable();
    return {
      practiceId: binding.practiceId,
      practiceVersion: binding.practiceVersion,
      stepAttemptId: binding.stepAttemptId,
      teacherId: binding.teacherId,
      course: { courseId: binding.courseId, unitId: binding.unitId },
    };
  }
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
      teacherId: binding.teacherId,
    };
  }
  if (attempt.sourceType === "wrong") {
    const binding = wrongKernelBinding(db, attempt.id);
    if (!binding) return undefined;
    if (
      binding.studentId !== attempt.studentId ||
      binding.teacherId !== attemptTeacherId(db, attempt) ||
      binding.attemptNo !== attempt.attemptNo ||
      attempt.assignmentId !== null ||
      attempt.courseId !== null ||
      attempt.unitId !== null ||
      attempt.lectureId !== null ||
      attempt.practiceWorkflowVersion !== 1 ||
      attempt.feedbackMode !== "after_attempt" ||
      attempt.timeLimitSec !== null ||
      !binding.stepAttemptId
    )
      kernelAttemptUnavailable();
    return {
      practiceId: wrongOpeningPractice(binding.id),
      practiceVersion: wrongOpeningVersion,
      stepAttemptId: binding.stepAttemptId,
      teacherId: binding.teacherId,
      wrong: true as const,
    };
  }
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
  db: Db,
  runtime: KernelRuntime,
  attempt: Attempt,
  binding: QuestionDeliveryBinding,
): QuestionDeliveryActivity | undefined {
  const activity = runtime.read(
    { role: "student", id: attempt.studentId },
    attempt.id,
  );
  if (!("questionDeliveries" in activity)) {
    if (binding.lectureId || binding.course || binding.wrong)
      kernelAttemptUnavailable();
    return undefined;
  }
  if (
    activity.activityId !== attempt.id ||
    activity.stepAttemptId !== binding.stepAttemptId ||
    activity.practiceVersion !== binding.practiceVersion ||
    activity.startedAt !== attempt.startedAt ||
    (deliveryPolicy(activity).mode === "perQuestion") !==
      (binding.lectureId !== undefined ||
        (binding.course !== undefined &&
          attempt.feedbackMode === "per_question"))
  )
    kernelAttemptUnavailable();
  if (binding.teacherId !== undefined) {
    const rows = attemptResponseRows(db, attempt.id);
    if (binding.course || binding.wrong) {
      const input = activity.inputs.questions;
      if (
        input?.from !== "questions" ||
        input.questions.length !== rows.length ||
        rows.some(
          (row, index) =>
            input.questions[index]?.id !== row.questionId ||
            input.questions[index]?.version !== row.questionVersion,
        )
      )
        kernelAttemptUnavailable();
    }
    const questions = rows.map((row) => {
      const question = snapshotOfRow(row);
      if (!question) kernelAttemptUnavailable();
      return question;
    });
    if (
      !matchesKernelMaterialInputs(
        activity,
        binding.teacherId,
        frozenKernelContextOf(db, attempt.id),
        questions,
      )
    )
      kernelAttemptUnavailable();
  }
  return activity;
}
