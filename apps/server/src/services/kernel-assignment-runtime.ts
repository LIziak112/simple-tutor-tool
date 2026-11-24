import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AttemptContextSnapshotEntry,
  attemptContextSnapshotEntrySchema,
  choiceStudentAnswerSchema,
  type Question,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import {
  LearningError,
  openLearningRuntime,
  type ResponseValue,
  type StudentActivity,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import type { Attempt } from "../db/schema.ts";
import { kernelAttemptBindings } from "../db/schema-kernel-assignments.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireAssignmentRow } from "./attempt-access.ts";
import {
  createOwnClassEvaluators,
  type OwnClassChoiceEvaluationScope,
} from "./attempt-choice-evaluation.ts";
import { attemptResponseRows } from "./attempt-freeze.ts";
import { matchesKernelMaterialInputs } from "./kernel-assignment-publication.ts";
import {
  ownClassJudgeAnswerRule,
  ownClassMatchingAnswerRule,
  ownClassOrderingAnswerRule,
  ownClassResponseAnswerRule,
} from "./kernel-question-delivery-values.ts";
import { listAttemptContextSnapshots } from "./material-repository.ts";
import { jsonOf, snapshotOfRow } from "./snapshot.ts";

export function frozenKernelContextOf(db: Db, attemptId: string) {
  return listAttemptContextSnapshots(db, attemptId).map((row) => {
    const entry = attemptContextSnapshotEntrySchema.safeParse({
      kind: row.kind,
      sourceId: row.sourceId,
      sourceVersion: row.sourceVersion,
      snapshot: jsonOf(row.snapshotJson),
    });
    if (!entry.success) kernelAttemptUnavailable();
    return entry.data;
  });
}

export function verifyKernelMaterialContext(
  db: Db,
  activity: StudentActivity,
  assignmentId: string,
  frozen: {
    context?: readonly AttemptContextSnapshotEntry[] | undefined;
    responses: readonly {
      question: Pick<Question, "id" | "materialRefs">;
    }[];
  },
): void {
  if (
    !matchesKernelMaterialInputs(
      activity,
      requireAssignmentRow(db, assignmentId).teacherId,
      frozen.context ?? [],
      frozen.responses.map(({ question }) => question),
    )
  )
    kernelAttemptUnavailable();
}

export function verifyStoredKernelMaterialContext(
  db: Db,
  activity: StudentActivity,
  attempt: Attempt,
): void {
  if (!attempt.assignmentId) kernelAttemptUnavailable();
  const responses = attemptResponseRows(db, attempt.id).map((row) => {
    const question = snapshotOfRow(row);
    if (!question) kernelAttemptUnavailable();
    return { question };
  });
  verifyKernelMaterialContext(db, activity, attempt.assignmentId, {
    context: frozenKernelContextOf(db, attempt.id),
    responses,
  });
}

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

export function judgeAnswerOf(value: ResponseValue | null) {
  if (value === null) return null;
  // 判断题原值只会是布尔或字符串；内核读面类型更宽，越界即视为读取不一致。
  if (typeof value !== "boolean" && typeof value !== "string")
    kernelAttemptUnavailable();
  return { kind: "judge" as const, value };
}

export function isJudgeActivity(activity: StudentActivity): boolean {
  return (
    "submit" in activity.step &&
    activity.step.submit.slots.answers?.type === "oneResponsePerQuestion"
  );
}

export type KernelRuntime = ReturnType<typeof openLearningRuntime> & {
  /** 执行该次确认的待评任务；评估器拒绝时抛出宿主原错误，其余未完成按暂不可用。 */
  evaluateSubmission(submissionId: string): void;
};
export type KernelAttemptBinding = typeof kernelAttemptBindings.$inferSelect;

type ConfirmationHooks = Pick<
  Parameters<typeof openLearningRuntime>[0],
  | "verifyOriginal"
  | "authorizeConfirmationRecovery"
  | "authorizeChoiceDraftAmendment"
  | "authorizeChoiceSnapshotRevision"
  | "authorizeReview"
  | "hasChoiceSnapshotEvidence"
> & { evaluateScope?: () => OwnClassChoiceEvaluationScope | undefined };

export function withKernelRuntime<T>(
  db: Db,
  dataDir: string,
  allowCreate: boolean,
  run: (runtime: KernelRuntime) => T,
  hooks: ConfirmationHooks = {},
): T {
  const databasePath = kernelDatabasePath(dataDir);
  if (!allowCreate && !existsSync(databasePath)) kernelAttemptUnavailable();
  try {
    const { evaluateScope, ...authorization } = hooks;
    const getScope = evaluateScope ?? (() => undefined);
    // 内核把评估器异常收成重试计数；保留宿主原错误以便调用方照旧拒绝。
    let rejection: unknown;
    const evaluators = createOwnClassEvaluators(db, getScope).map(
      (evaluator) => ({
        ...evaluator,
        evaluate: (input: Parameters<typeof evaluator.evaluate>[0]) => {
          try {
            return evaluator.evaluate(input);
          } catch (error) {
            rejection = error;
            throw error;
          }
        },
      }),
    );
    const opened = openLearningRuntime({
      ...authorization,
      databasePath,
      evaluators,
      questionAnswerRules: [
        ownClassJudgeAnswerRule,
        ownClassMatchingAnswerRule,
        ownClassOrderingAnswerRule,
        ownClassResponseAnswerRule,
      ],
    });
    const runtime: KernelRuntime = Object.assign(opened, {
      evaluateSubmission(submissionId: string) {
        rejection = undefined;
        const summary = opened.evaluatePending({ submissionId });
        if (summary.retrying + summary.failed + summary.deferred === 0) return;
        if (rejection instanceof HttpError) throw rejection;
        kernelAttemptUnavailable();
      },
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
    runtime: KernelRuntime,
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
  if (!binding) kernelAttemptUnavailable();

  return withKernelRuntime(
    db,
    dataDir,
    false,
    (runtime) =>
      run(
        runtime,
        readBoundKernelActivity(runtime, attempt, binding),
        binding.stepAttemptId,
        binding.practiceVersion,
      ),
    hooks,
  );
}

/** 调用方已核实作答归属。单卷与列表使用同一绑定判定。 */
export function readBoundKernelActivity(
  runtime: KernelRuntime,
  attempt: Attempt,
  binding: KernelAttemptBinding,
) {
  if (
    binding.attemptId !== attempt.id ||
    binding.assignmentId !== attempt.assignmentId
  )
    kernelAttemptUnavailable();

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

  return activity;
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

/** 内核恢复只读；仍待评时在当前评分范围内执行该次确认的评估后重读。 */
export function recoverEvaluated<R extends { receipt: { id: string } }>(
  runtime: KernelRuntime,
  recover: () => R,
  statusOf: (recovered: R) => string | undefined,
): R {
  const recovered = recover();
  if (statusOf(recovered) !== "pending") return recovered;
  runtime.evaluateSubmission(recovered.receipt.id);
  return recover();
}

/** 已确认卷的自动判定须已执行完毕；待评或失败按暂不可用。 */
export function requireEvaluated<E extends { status: string }>(
  evaluation: E | undefined,
): Extract<E, { status: "evaluated" }> {
  if (evaluation?.status !== "evaluated") kernelAttemptUnavailable();
  return evaluation as Extract<E, { status: "evaluated" }>;
}
