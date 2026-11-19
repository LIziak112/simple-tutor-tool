import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  LearningError,
  openLearningRuntime,
  type StudentActivity,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import type { Attempt } from "../db/schema.ts";
import { kernelAttemptBindings } from "../db/schema-kernel-assignments.ts";
import { HttpError } from "../lib/http-error.ts";
import { createOwnClassChoiceEvaluator } from "./attempt-choice-evaluation.ts";

export function kernelAttemptUnavailable(): never {
  throw new HttpError(
    503,
    "KERNEL_ATTEMPT_UNAVAILABLE",
    "暂时无法读取内核作答，请稍后重试",
  );
}

type Runtime = ReturnType<typeof openLearningRuntime>;

export function withKernelRuntime<T>(
  db: Db,
  dataDir: string,
  allowCreate: boolean,
  run: (runtime: Runtime) => T,
): T {
  const databasePath = kernelDatabasePath(dataDir);
  if (!allowCreate && !existsSync(databasePath)) kernelAttemptUnavailable();
  try {
    const runtime = openLearningRuntime({
      databasePath,
      choiceEvaluators: [createOwnClassChoiceEvaluator(db, () => undefined)],
    });
    try {
      return run(runtime);
    } finally {
      runtime.close();
    }
  } catch (error) {
    if (error instanceof LearningError) kernelAttemptUnavailable();
    throw error;
  }
}

export function withBoundKernelActivity<T>(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  run: (
    runtime: Runtime,
    activity: StudentActivity,
    stepAttemptId: string,
  ) => T,
): T {
  const binding = db
    .select()
    .from(kernelAttemptBindings)
    .where(eq(kernelAttemptBindings.attemptId, attempt.id))
    .get();
  if (!binding || binding.assignmentId !== attempt.assignmentId)
    kernelAttemptUnavailable();

  return withKernelRuntime(db, dataDir, false, (runtime) => {
    const activity = runtime.read(
      { role: "student", id: attempt.studentId },
      attempt.id,
    );
    if (
      activity.activityId !== attempt.id ||
      !("stepAttemptId" in activity) ||
      activity.stepAttemptId !== binding.stepAttemptId ||
      !("startedAt" in activity) ||
      activity.startedAt !== attempt.startedAt
    )
      kernelAttemptUnavailable();
    return run(runtime, activity, binding.stepAttemptId);
  });
}

function kernelDatabasePath(dataDir: string): string {
  return join(dataDir, "learning-kernel.sqlite");
}

export function ensureKernelRuntimeStorage(
  db: Db,
  dataDir: string,
  allowCreate: boolean,
): void {
  if (!existsSync(kernelDatabasePath(dataDir)))
    withKernelRuntime(db, dataDir, allowCreate, () => undefined);
}
