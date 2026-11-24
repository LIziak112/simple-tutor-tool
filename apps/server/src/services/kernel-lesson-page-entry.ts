import { randomUUID } from "node:crypto";
import {
  attemptPhaseOf,
  isRecordableAttempt,
  type LessonRestartRequest,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireUsableAttempt } from "./attempt-access.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import {
  kernelLessonForRestart,
  openKernelLesson,
  pendingKernelLesson,
  resumeKernelLessonOpening,
} from "./kernel-lesson-opening.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery.ts";
import { lessonKernelBinding } from "./kernel-question-delivery-binding.ts";

type KernelLessonOptions = { dataDir: string; enabled: boolean };
type PageScope = Parameters<typeof openKernelLesson>[2];

export function openKernelLessonFromPage(
  db: Db,
  kernel: KernelLessonOptions,
  scope: PageScope,
  hasProof: boolean,
) {
  const pending = pendingKernelLesson(db, scope);
  if (pending) {
    if (pending.courseId !== scope.courseId)
      throw new HttpError(403, "FORBIDDEN", "原作答不属于当前课程");
    return resumeKernelLessonOpening(db, kernel.dataDir, pending);
  }
  if (kernel.enabled && hasProof)
    return openKernelLesson(
      db,
      kernel.dataDir,
      scope,
      1,
      "open:lesson:" + randomUUID(),
    );
  return undefined;
}

export function restartBoundKernelLesson(
  db: Db,
  kernel: KernelLessonOptions,
  scope: PageScope,
  existing: readonly Attempt[],
  request: LessonRestartRequest | undefined,
  hasProof: boolean,
) {
  const latest = existing[0];
  if (
    !(latest && lessonKernelBinding(db, latest.id)) &&
    !pendingKernelLesson(db, scope)
  )
    return undefined;
  const operation = request
    ? "restart:lesson:" + scope.studentId + ":" + request.operationId
    : "restart:lesson:" + randomUUID();
  const replay = request && kernelLessonForRestart(db, scope, operation);
  if (replay) {
    const previous = db
      .select({ id: attempts.id })
      .from(attempts)
      .where(
        and(
          eq(attempts.studentId, scope.studentId),
          eq(attempts.lectureId, scope.lectureId),
          eq(attempts.sourceType, "lesson"),
          eq(attempts.attemptNo, replay.attemptNo - 1),
        ),
      )
      .get();
    if (!request || previous?.id !== request.expectedAttemptId)
      throw new HttpError(
        409,
        "OPERATION_CONFLICT",
        "此操作已绑定其他讲练轮次",
      );
    return resumeKernelLessonOpening(db, kernel.dataDir, replay);
  }
  if (!latest || !kernel.enabled || !hasProof)
    throw new HttpError(
      409,
      "LESSON_RESTART_STALE",
      "当前不能新开内核讲练，请继续原作答",
    );
  if (request && latest.id !== request.expectedAttemptId) {
    if (
      attemptPhaseOf(latest) === "opened" &&
      existing.find(isRecordableAttempt)?.id === request.expectedAttemptId
    )
      return latest;
    throw new HttpError(
      409,
      "LESSON_RESTART_STALE",
      "讲练已在其他页面重新开始，请刷新后确认",
    );
  }
  const previous = readQuestionDeliveryFacts(
    db,
    kernel.dataDir,
    requireUsableAttempt(db, scope.studentId, latest.id),
  );
  if (!previous) kernelAttemptUnavailable();
  const opened = openKernelLesson(
    db,
    kernel.dataDir,
    scope,
    latest.attemptNo + 1,
    operation,
    previous.attempt,
  );
  if (!opened)
    throw new HttpError(
      422,
      "M04_PRACTICE_INELIGIBLE",
      "新版本不满足内核讲练的开卷条件",
    );
  return opened;
}
