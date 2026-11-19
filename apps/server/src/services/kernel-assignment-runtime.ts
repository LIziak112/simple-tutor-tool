import { existsSync } from "node:fs";
import { join } from "node:path";
import { LearningError, openLearningRuntime } from "learning-kernel";
import type { Db } from "../db/client.ts";
import { HttpError } from "../lib/http-error.ts";
import { createOwnClassChoiceEvaluator } from "./attempt-choice-evaluation.ts";

export function kernelAttemptUnavailable(): never {
  throw new HttpError(
    503,
    "KERNEL_ATTEMPT_UNAVAILABLE",
    "暂时无法读取内核作答，请稍后重试",
  );
}

export function withKernelRuntime<T>(
  db: Db,
  dataDir: string,
  allowCreate: boolean,
  run: (runtime: ReturnType<typeof openLearningRuntime>) => T,
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
