import { mkdtempDisposableSync } from "node:fs";
import { join } from "node:path";
import {
  attemptSubmitRequestSchema,
  BACKUP_KERNEL_DATABASE,
} from "@tutor/contract";
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { openLearningRuntime } from "learning-kernel";
import { z } from "zod";
import * as schema from "../db/schema.ts";
import { ZipReadError } from "../lib/zip-read.ts";
import {
  createOwnClassChoiceEvaluator,
  type OwnClassChoiceEvaluationScope,
} from "./attempt-choice-evaluation.ts";

const kernelRefreezePublicationSchema = z.object({
  practice: z.object({ id: z.string(), version: z.number().int().positive() }),
});

export function hasBackupTable(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

interface Binding {
  readonly id: string;
  readonly studentId: string;
  readonly assignmentId: string;
  readonly practiceVersion: number;
  readonly startedAt: string;
  readonly stepId: string;
  readonly status: string;
}

interface Confirmation {
  readonly operationId: string;
  readonly stepId: string;
  readonly practiceVersion: number;
  readonly request: string;
}

interface Refreeze {
  readonly operationId: string;
  readonly stepId: string;
  readonly expectedPracticeVersion: number;
  readonly practiceVersion: number;
  readonly publication: string;
}

export function verifyBackupBindings(
  product: Database.Database,
  kernel: Database.Database,
  directory: string,
): void {
  if (!hasBackupTable(product, "kernel_attempt_bindings")) return;
  const bindings = product
    .prepare<[], Binding>(`
    SELECT b.attempt_id AS id, b.assignment_id AS assignmentId,
      b.practice_version AS practiceVersion, b.step_attempt_id AS stepId,
      a.student_id AS studentId, a.started_at AS startedAt, a.status
    FROM kernel_attempt_bindings b LEFT JOIN attempts a ON a.id = b.attempt_id
  `)
    .all();
  const confirmations = hasBackupTable(product, "kernel_attempt_confirmations")
    ? product.prepare<[string], Confirmation>(`
      SELECT operation_id AS operationId, step_attempt_id AS stepId,
        practice_version AS practiceVersion, request_json AS request
      FROM kernel_attempt_confirmations WHERE attempt_id = ?
    `)
    : undefined;
  const refreezes = hasBackupTable(product, "kernel_attempt_refreezes")
    ? product.prepare<[string], Refreeze>(`
      SELECT operation_id AS operationId, step_attempt_id AS stepId,
        expected_practice_version AS expectedPracticeVersion, practice_version AS practiceVersion,
        publication_json AS publication
      FROM kernel_attempt_refreezes WHERE attempt_id = ?
    `)
    : undefined;
  const space = mkdtempDisposableSync(join(directory, "tutor-verify-kernel-"));
  try {
    const databasePath = join(space.path, BACKUP_KERNEL_DATABASE);
    // 公开的恢复调用可能执行迁移或补齐确认。只在验证副本中调用，原始截面保持不动。
    kernel.prepare("VACUUM INTO ?").run(databasePath);
    const productDb = drizzle(product, { schema });
    let scope: OwnClassChoiceEvaluationScope | undefined;
    let operation: string | undefined;
    const runtime = openLearningRuntime({
      databasePath,
      choiceEvaluators: [createOwnClassChoiceEvaluator(productDb, () => scope)],
      authorizeConfirmationRecovery: (request) =>
        scope !== undefined &&
        request.studentId === scope.studentId &&
        request.activityId === scope.attemptId &&
        request.stepAttemptId === scope.stepAttemptId &&
        request.operationId === operation,
    });
    try {
      for (const binding of bindings) {
        const actor = { role: "student", id: binding.studentId } as const;
        const activity = runtime.read(actor, binding.id);
        const activityVersion =
          "practiceVersion" in activity ? activity.practiceVersion : undefined;
        if (
          activity.activityId !== binding.id ||
          !("startedAt" in activity) ||
          activity.startedAt !== binding.startedAt ||
          !("stepAttemptId" in activity)
        ) {
          throw new ZipReadError("主库和内核库中的作答归属不一致");
        }
        if (
          activity.stepAttemptId !== binding.stepId ||
          (activityVersion !== undefined &&
            activityVersion !== binding.practiceVersion)
        ) {
          const ticket = refreezes?.get(binding.id);
          if (
            !ticket ||
            binding.status !== "draft" ||
            activity.status !== "active" ||
            ticket.stepId !== binding.stepId ||
            ticket.expectedPracticeVersion !== binding.practiceVersion ||
            ticket.practiceVersion !== activityVersion
          ) {
            throw new ZipReadError("主库和内核库中的作答版本不一致");
          }
          const publication = kernelRefreezePublicationSchema.parse(
            JSON.parse(ticket.publication),
          );
          if (
            publication.practice.id !== binding.assignmentId ||
            publication.practice.version !== ticket.practiceVersion
          ) {
            throw new ZipReadError("主库的重冻意图与作答归属不一致");
          }
          const replay = runtime.replacePreparedActivityVersion(
            actor,
            binding.id,
            {
              protocolVersion: 1,
              operationId: ticket.operationId,
              stepAttemptId: binding.stepId,
              expectedPracticeVersion: binding.practiceVersion,
              practiceVersion: ticket.practiceVersion,
            },
          );
          if (
            replay.activityId !== binding.id ||
            replay.stepAttemptId !== activity.stepAttemptId ||
            replay.startedAt !== binding.startedAt ||
            replay.practiceVersion !== activityVersion
          ) {
            throw new ZipReadError("内核无法重放已换版回执");
          }
        }

        if (activity.status !== "completed") {
          if (binding.status === "submitted" || binding.status === "graded") {
            throw new ZipReadError("主库已交卷但内核作答未确认");
          }
          if (activityVersion === undefined) {
            // 旧 start 活动不在公开 read 中显示版本，使用相同开卷键核对旧回执。
            const replay = runtime.start(actor, {
              protocolVersion: 1,
              operationId: `open:${binding.assignmentId}`,
              practiceId: binding.assignmentId,
              practiceVersion: binding.practiceVersion,
            });
            if (
              replay.activityId !== binding.id ||
              replay.stepAttemptId !== binding.stepId ||
              replay.startedAt !== binding.startedAt
            ) {
              throw new ZipReadError("内核的旧开卷回执与主库不一致");
            }
          }
          continue;
        }
        const ticket = confirmations?.get(binding.id);
        if (
          !ticket ||
          ticket.stepId !== binding.stepId ||
          ticket.practiceVersion !== binding.practiceVersion
        ) {
          throw new ZipReadError("内核已确认作答缺少对应的宿主交卷意图");
        }
        const request = attemptSubmitRequestSchema.parse(
          JSON.parse(ticket.request),
        );
        scope = {
          attemptId: binding.id,
          assignmentId: binding.assignmentId,
          studentId: binding.studentId,
          stepAttemptId: binding.stepId,
          practiceVersion: binding.practiceVersion,
          slotId: "answers",
          questionRevisions: new Map(
            request.revisions.map(({ questionId, questionRevisionId }) => [
              questionId,
              questionRevisionId,
            ]),
          ),
        };
        operation = ticket.operationId;
        const recovered = runtime.recoverChoiceConfirmation(actor, binding.id, {
          protocolVersion: 1,
          stepAttemptId: ticket.stepId,
          operationId: ticket.operationId,
        });
        if (
          recovered.practice.id !== binding.assignmentId ||
          recovered.practice.version !== binding.practiceVersion ||
          recovered.receipt.stepAttemptId !== binding.stepId ||
          recovered.receipt.slotId !== scope.slotId
        ) {
          throw new ZipReadError("内核回执的作答归属或版本不一致");
        }
      }
    } finally {
      runtime.close();
    }
  } finally {
    space.remove();
  }
}
