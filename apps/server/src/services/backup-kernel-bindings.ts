import { mkdtempDisposableSync } from "node:fs";
import { join } from "node:path";
import {
  attemptSubmitRequestSchema,
  BACKUP_KERNEL_DATABASE,
} from "@tutor/contract";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { attempts } from "../db/schema.ts";
import {
  kernelAttemptBindings,
  kernelAttemptConfirmations,
  kernelAttemptRefreezes,
} from "../db/schema-kernel-assignments.ts";
import { ZipReadError } from "../lib/zip-read.ts";
import { withKernelConfirmationReader } from "./kernel-assignment-confirmation-recovery.ts";

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

function verifyProjection(db: Db, directory: string): void {
  const bindings = db
    .select({
      binding: kernelAttemptBindings,
      attempt: attempts,
      confirmation: kernelAttemptConfirmations,
      refreeze: kernelAttemptRefreezes,
    })
    .from(kernelAttemptBindings)
    .leftJoin(attempts, eq(attempts.id, kernelAttemptBindings.attemptId))
    .leftJoin(
      kernelAttemptConfirmations,
      eq(kernelAttemptConfirmations.attemptId, kernelAttemptBindings.attemptId),
    )
    .leftJoin(
      kernelAttemptRefreezes,
      eq(kernelAttemptRefreezes.attemptId, kernelAttemptBindings.attemptId),
    )
    .all();
  const evidenceCount = db.$client.prepare<[string], { count: number }>(
    "SELECT COUNT(*) AS count FROM submission_evidence WHERE attempt_id = ?",
  );

  withKernelConfirmationReader(db, directory, (runtime, recover) => {
    for (const { attempt, binding, confirmation, refreeze } of bindings) {
      if (!attempt || attempt.assignmentId !== binding.assignmentId) {
        throw new ZipReadError("主库中的作答归属不一致");
      }
      const actor = { role: "student", id: attempt.studentId } as const;
      const activity = runtime.read(actor, attempt.id);
      const activityVersion =
        "practiceVersion" in activity ? activity.practiceVersion : undefined;
      if (
        activity.activityId !== attempt.id ||
        !("startedAt" in activity) ||
        activity.startedAt !== attempt.startedAt ||
        !("stepAttemptId" in activity)
      ) {
        throw new ZipReadError("主库和内核库中的作答归属不一致");
      }
      if (
        activity.stepAttemptId !== binding.stepAttemptId ||
        (activityVersion !== undefined &&
          activityVersion !== binding.practiceVersion)
      ) {
        if (
          !refreeze ||
          attempt.status !== "draft" ||
          activity.status !== "active" ||
          refreeze.stepAttemptId !== binding.stepAttemptId ||
          refreeze.expectedPracticeVersion !== binding.practiceVersion ||
          refreeze.practiceVersion !== activityVersion
        ) {
          throw new ZipReadError("主库和内核库中的作答版本不一致");
        }
        const publication = kernelRefreezePublicationSchema.parse(
          refreeze.publication,
        );
        if (
          publication.practice.id !== binding.assignmentId ||
          publication.practice.version !== refreeze.practiceVersion
        ) {
          throw new ZipReadError("主库的重冻意图与作答归属不一致");
        }
        const replay = runtime.replacePreparedActivityVersion(
          actor,
          attempt.id,
          {
            protocolVersion: 1,
            operationId: refreeze.operationId,
            stepAttemptId: binding.stepAttemptId,
            expectedPracticeVersion: binding.practiceVersion,
            practiceVersion: refreeze.practiceVersion,
          },
        );
        if (
          replay.activityId !== attempt.id ||
          replay.stepAttemptId !== activity.stepAttemptId ||
          replay.startedAt !== attempt.startedAt ||
          replay.practiceVersion !== activityVersion
        ) {
          throw new ZipReadError("内核无法重放已换版回执");
        }
      }

      if (activity.status !== "completed") {
        if (attempt.status === "submitted" || attempt.status === "graded") {
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
            replay.activityId !== attempt.id ||
            replay.stepAttemptId !== binding.stepAttemptId ||
            replay.startedAt !== attempt.startedAt
          ) {
            throw new ZipReadError("内核的旧开卷回执与主库不一致");
          }
        }
        continue;
      }
      if (!confirmation)
        throw new ZipReadError("内核已确认作答缺少对应的宿主交卷意图");

      const request = attemptSubmitRequestSchema.parse(confirmation.request);
      const before = evidenceCount.get(attempt.id)?.count;
      try {
        recover(attempt, binding, { ...confirmation, request });
      } catch {
        throw new ZipReadError("备份中的内核交卷回执与宿主投影不一致");
      }
      // 正式读取可为待投影草稿重建整组索引。已结算卷的索引须在归档前就完整。
      if (
        attempt.status !== "draft" &&
        evidenceCount.get(attempt.id)?.count !== before
      ) {
        throw new ZipReadError("备份中的已结算作答缺少正式原稿索引");
      }
    }
  });
}

export function verifyBackupBindings(
  product: Database.Database,
  kernel: Database.Database,
  directory: string,
  verifyOriginals: (copy: Database.Database) => void,
): void {
  if (!hasBackupTable(product, "kernel_attempt_bindings")) return;
  using space = mkdtempDisposableSync(join(directory, "tutor-verify-kernel-"));
  const productPath = join(space.path, "product-copy.sqlite");
  // 正式恢复可能补写结算与原稿索引。只在双库副本中执行，保留归档的原始截面。
  product.prepare("VACUUM INTO ?").run(productPath);
  kernel.prepare("VACUUM INTO ?").run(join(space.path, BACKUP_KERNEL_DATABASE));
  const copy = createDb(productPath);
  try {
    // 历史归档的主库同样需要当前读路径所依赖的表。迁移仅发生在核验副本。
    runMigrations(copy);
    verifyProjection(copy, space.path);
    verifyOriginals(copy.$client);
  } finally {
    copy.$client.close();
  }
}
