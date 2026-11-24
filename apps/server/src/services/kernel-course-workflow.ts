import {
  type PracticeWorkflowUpdateRequest,
  practiceWorkflowUpdateRequestSchema,
} from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import type {
  PreparedActivityVersionInput,
  PublicationInput,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts } from "../db/schema.ts";
import { kernelCourseOpenings } from "../db/schema-kernel-question-delivery.ts";
import { pendingKernelRefreeze } from "./kernel-assignment-refreeze-guard.ts";
import {
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import {
  courseKernelBinding,
  questionDeliveryBinding,
  readBoundQuestionDelivery,
} from "./kernel-question-delivery-binding.ts";
import { deliverySlotId } from "./kernel-question-delivery-publication.ts";
import { removePendingTicket } from "./kernel-question-delivery-staging.ts";
import { deliveryTickets } from "./kernel-question-delivery-ticket.ts";

function workflowPublication(
  frozen: PublicationInput,
  practiceVersion: number,
  mode: PracticeWorkflowUpdateRequest["feedbackMode"],
): PublicationInput {
  const { practice } = frozen;
  if (
    !("questions" in practice) ||
    !practice.questions ||
    practice.steps.length !== 1
  )
    kernelAttemptUnavailable();
  const [step] = practice.steps;
  const slot = step?.submit?.slots[deliverySlotId];
  if (!step?.submit || slot?.type !== "questionDelivery")
    kernelAttemptUnavailable();
  return {
    ...frozen,
    practice: {
      ...practice,
      version: practiceVersion,
      steps: [
        {
          ...step,
          submit: {
            ...step.submit,
            slots: {
              ...step.submit.slots,
              [deliverySlotId]: {
                ...slot,
                delivery:
                  mode === "after_attempt"
                    ? { mode: "whole" }
                    : {
                        mode: "perQuestion",
                        questionSlots: Object.fromEntries(
                          practice.questions.map(({ id }, index) => [
                            id,
                            `question-${index + 1}`,
                          ]),
                        ),
                      },
              },
            },
          },
        },
      ],
    },
  };
}

export function reserveKernelCourseWorkflow(
  db: Db,
  attempt: Attempt,
  request: PracticeWorkflowUpdateRequest,
) {
  if (pendingKernelRefreeze(db, attempt.id)) kernelAttemptUnavailable();
  const reserved = db
    .update(kernelCourseOpenings)
    .set({ pendingWorkflow: request })
    .where(
      and(
        eq(kernelCourseOpenings.attemptId, attempt.id),
        isNull(kernelCourseOpenings.pendingWorkflow),
      ),
    )
    .returning({ id: kernelCourseOpenings.attemptId })
    .get();
  if (!reserved) kernelAttemptUnavailable();
}

/** 调用方持有产品写锁；只有重新校验过课程权限的 PATCH 可以启动新换版。 */
export function resolveKernelCourseWorkflow(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  execute = false,
): Attempt {
  if (
    attempt.sourceType !== "course" ||
    !courseKernelBinding(db, attempt.id)?.pendingWorkflow
  )
    return attempt;
  const key = eq(kernelCourseOpenings.attemptId, attempt.id);
  const opening = db.select().from(kernelCourseOpenings).where(key).get();
  const binding = questionDeliveryBinding(db, attempt);
  if (
    !opening?.pendingWorkflow ||
    !binding?.course ||
    pendingKernelRefreeze(db, attempt.id)
  )
    kernelAttemptUnavailable();
  const request = practiceWorkflowUpdateRequestSchema.parse(
    opening.pendingWorkflow,
  );
  if (
    request.workflowRevision !== attempt.workflowRevision ||
    request.feedbackMode === attempt.feedbackMode ||
    opening.publication.practice.id !== binding.practiceId ||
    opening.publication.practice.version !== binding.practiceVersion
  )
    kernelAttemptUnavailable();
  const nextAttempt = {
    ...attempt,
    feedbackMode: request.feedbackMode,
    workflowRevision: request.workflowRevision + 1,
  };
  const practiceVersion = binding.practiceVersion + 1;
  const publication = workflowPublication(
    opening.publication,
    practiceVersion,
    request.feedbackMode,
  );
  const actor = { role: "student", id: attempt.studentId } as const;
  return withKernelRuntime(db, dataDir, false, (runtime) => {
    const view = runtime.read(actor, attempt.id);
    if (!("questionDeliveries" in view)) kernelAttemptUnavailable();
    const unchanged =
      view.practiceVersion === binding.practiceVersion &&
      view.stepAttemptId === binding.stepAttemptId;
    if (unchanged) {
      if (!execute) {
        if (view.questionDeliveries.length > 0)
          db.update(kernelCourseOpenings)
            .set({ pendingWorkflow: null })
            .where(key)
            .run();
        return attempt;
      }
      if (
        !readBoundQuestionDelivery(db, runtime, attempt, binding) ||
        view.status !== "active" ||
        view.questionDeliveries.length > 0
      )
        kernelAttemptUnavailable();
      runtime.publish(publication);
    } else if (
      view.practiceVersion !== practiceVersion ||
      view.stepAttemptId === binding.stepAttemptId ||
      view.status !== "active" ||
      view.questionDeliveries.length > 0
    ) {
      kernelAttemptUnavailable();
    }
    // 读侧已经看到目标版；旧步骤和旧版本只能重放同一命令的回执。
    const input = {
      protocolVersion: 1,
      operationId: `workflow:${attempt.id}:${request.workflowRevision}`,
      stepAttemptId: binding.stepAttemptId,
      expectedPracticeVersion: binding.practiceVersion,
      practiceVersion,
      ...(view.questionDeliveryDrafts.length > 0 && {
        intent: "questionDeliveryMode",
      }),
    } satisfies PreparedActivityVersionInput;
    const receipt = runtime.replacePreparedActivityVersion(
      actor,
      attempt.id,
      input,
    );
    const replacement = {
      practiceVersion,
      stepAttemptId: receipt.stepAttemptId,
    };
    if (
      receipt.activityId !== attempt.id ||
      receipt.startedAt !== attempt.startedAt ||
      receipt.practiceVersion !== practiceVersion ||
      receipt.stepAttemptId === binding.stepAttemptId ||
      !readBoundQuestionDelivery(db, runtime, nextAttempt, {
        ...binding,
        ...replacement,
      })
    )
      kernelAttemptUnavailable();
    for (const ticket of deliveryTickets(db, attempt.id))
      removePendingTicket(db, ticket);
    const fresh = db
      .update(attempts)
      .set({
        feedbackMode: nextAttempt.feedbackMode,
        workflowRevision: nextAttempt.workflowRevision,
      })
      .where(
        and(
          eq(attempts.id, attempt.id),
          eq(attempts.workflowRevision, request.workflowRevision),
        ),
      )
      .returning()
      .get();
    if (!fresh) kernelAttemptUnavailable();
    db.update(kernelCourseOpenings)
      .set({ ...replacement, publication, pendingWorkflow: null })
      .where(key)
      .run();
    return fresh;
  });
}
