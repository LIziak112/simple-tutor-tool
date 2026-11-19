import { existsSync } from "node:fs";
import { join } from "node:path";
import { choiceStudentAnswerSchema } from "@tutor/contract";
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
import {
  createOwnClassChoiceEvaluator,
  type OwnClassChoiceEvaluationScope,
} from "./attempt-choice-evaluation.ts";

export function kernelAttemptUnavailable(): never {
  throw new HttpError(
    503,
    "KERNEL_ATTEMPT_UNAVAILABLE",
    "暂时无法读取内核作答，请稍后重试",
  );
}

export function ownClassChoiceAnswerOf(choice: string) {
  const parsed = choiceStudentAnswerSchema.safeParse({
    kind: "choice",
    index: Number(choice),
  });
  if (!parsed.success || String(parsed.data.index) !== choice)
    kernelAttemptUnavailable();
  return parsed.data;
}

type Runtime = ReturnType<typeof openLearningRuntime>;
type ConfirmationHooks = Pick<
  Parameters<typeof openLearningRuntime>[0],
  "verifyOriginal" | "authorizeConfirmationRecovery"
> & { evaluateScope?: OwnClassChoiceEvaluationScope };

export function withKernelRuntime<T>(
  db: Db,
  dataDir: string,
  allowCreate: boolean,
  run: (runtime: Runtime) => T,
  hooks: ConfirmationHooks = {},
): T {
  const databasePath = kernelDatabasePath(dataDir);
  if (!allowCreate && !existsSync(databasePath)) kernelAttemptUnavailable();
  try {
    const { evaluateScope, ...authorization } = hooks;
    const runtime = openLearningRuntime({
      ...authorization,
      databasePath,
      choiceEvaluators: [
        createOwnClassChoiceEvaluator(db, () => evaluateScope),
      ],
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
    practiceVersion: number,
  ) => T,
  hooks?: ConfirmationHooks,
): T {
  const binding = db
    .select()
    .from(kernelAttemptBindings)
    .where(eq(kernelAttemptBindings.attemptId, attempt.id))
    .get();
  if (!binding || binding.assignmentId !== attempt.assignmentId)
    kernelAttemptUnavailable();

  return withKernelRuntime(
    db,
    dataDir,
    false,
    (runtime) => {
      const activity = runtime.read(
        { role: "student", id: attempt.studentId },
        attempt.id,
      );
      if (
        activity.activityId !== attempt.id ||
        !("stepAttemptId" in activity) ||
        activity.stepAttemptId !== binding.stepAttemptId ||
        ("practiceVersion" in activity &&
          activity.practiceVersion !== undefined &&
          activity.practiceVersion !== binding.practiceVersion) ||
        !("startedAt" in activity) ||
        activity.startedAt !== attempt.startedAt
      )
        kernelAttemptUnavailable();
      return run(
        runtime,
        activity,
        binding.stepAttemptId,
        binding.practiceVersion,
      );
    },
    hooks,
  );
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
