import { mkdtempDisposableSync } from "node:fs";
import { join } from "node:path";
import {
  attemptSubmitRequestSchema,
  BACKUP_KERNEL_DATABASE,
} from "@tutor/contract";
import { choiceAmendmentIntentSchema } from "@tutor/contract/choice-amendment-intent";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { LearningError, verifyActivityBindings } from "learning-kernel";
import { z } from "zod";
import { createDb, type Db } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { attempts, responseEditAudits, responses } from "../db/schema.ts";
import {
  kernelAssignmentOpenings,
  kernelAttemptBindings,
  kernelAttemptConfirmations,
  kernelAttemptRefreezes,
  kernelChoiceAmendments,
} from "../db/schema-kernel-assignments.ts";
import { ZipReadError } from "../lib/zip-read.ts";
import { withKernelConfirmationReader } from "./kernel-assignment-confirmation-recovery.ts";
import {
  kernelOpeningDraftSchema,
  kernelRefreezeDraftSchema,
} from "./kernel-assignment-input.ts";
import {
  verifyKernelMaterialContext,
  verifyStoredKernelMaterialContext,
} from "./kernel-assignment-runtime.ts";
import { recoverKernelChoiceAmendment } from "./kernel-choice-amendments.ts";

const publicationIdentitySchema = z.object({
  practice: z.object({ id: z.string(), version: z.number().int().positive() }),
});

type AmendmentClaims = NonNullable<
  Parameters<typeof verifyActivityBindings>[1]["teacherAmendments"]
>;

function completedAmendmentClaims(db: Db): AmendmentClaims["completed"] {
  return db
    .select({
      kind: responseEditAudits.kind,
      activityId: kernelAttemptBindings.attemptId,
      studentId: attempts.studentId,
      stepAttemptId: kernelAttemptBindings.stepAttemptId,
      questionId: responses.questionId,
      reviewerId: responseEditAudits.teacherId,
      operationId: responseEditAudits.id,
      revision: responseEditAudits.answerRevision,
    })
    .from(responseEditAudits)
    .innerJoin(responses, eq(responses.id, responseEditAudits.responseId))
    .innerJoin(
      kernelAttemptBindings,
      eq(kernelAttemptBindings.attemptId, responses.attemptId),
    )
    .innerJoin(attempts, eq(attempts.id, kernelAttemptBindings.attemptId))
    .all()
    .map((audit) => ({ ...audit, slotId: "answers" }));
}

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
    .all()
    .map(({ attempt, binding, confirmation, refreeze }) => {
      if (!attempt || attempt.assignmentId !== binding.assignmentId) {
        throw new ZipReadError("主库中的作答归属不一致");
      }
      return { attempt, binding, confirmation, refreeze };
    });
  const openings = db.select().from(kernelAssignmentOpenings).all();
  const pendingAmendments = db
    .select({ ticket: kernelChoiceAmendments, studentId: attempts.studentId })
    .from(kernelChoiceAmendments)
    .leftJoin(attempts, eq(attempts.id, kernelChoiceAmendments.attemptId))
    .all();
  try {
    verifyActivityBindings(join(directory, BACKUP_KERNEL_DATABASE), {
      protocolVersion: 1,
      bindings: bindings.map(({ attempt, binding }) => ({
        activityId: binding.attemptId,
        studentId: attempt.studentId,
        operationId: `open:${binding.assignmentId}`,
      })),
      openingIntents: openings.map(({ studentId, assignmentId }) => ({
        studentId,
        operationId: `open:${assignmentId}`,
      })),
      teacherAmendments: {
        completed: completedAmendmentClaims(db),
        pending: pendingAmendments.map(({ ticket, studentId }) => {
          const intent = choiceAmendmentIntentSchema.parse(ticket.intent);
          if (studentId === null)
            throw new ZipReadError("备份中的教师草稿勘误缺少作答归属");
          return {
            kind: intent.kind,
            activityId: ticket.attemptId,
            studentId,
            stepAttemptId: intent.stepAttemptId,
            slotId: "answers",
            questionId: intent.questionId,
            reviewerId: ticket.teacherId,
            operationId: ticket.operationId,
            revision: intent.baseRevision + 1,
          };
        }),
      },
    });
  } catch (error) {
    if (
      error instanceof LearningError &&
      error.code === "ACTIVITY_BINDINGS_MISMATCH"
    ) {
      throw new ZipReadError("主库的开卷记录与内核实际作答不一致");
    }
    if (
      error instanceof LearningError &&
      error.code === "TEACHER_AMENDMENTS_MISMATCH"
    ) {
      throw new ZipReadError("主库的教师草稿勘误与内核审计不一致");
    }
    throw error;
  }
  for (const { ticket } of pendingAmendments) {
    try {
      recoverKernelChoiceAmendment(db, directory, ticket.attemptId);
    } catch {
      throw new ZipReadError("备份中的答案勘误意图与内核作答不一致");
    }
  }

  const evidenceCount = db.$client.prepare<[string], { count: number }>(
    "SELECT COUNT(*) AS count FROM submission_evidence WHERE attempt_id = ?",
  );

  withKernelConfirmationReader(db, directory, (runtime, recover) => {
    for (const opening of openings) {
      const publication = publicationIdentitySchema.parse(opening.publication);
      if (
        publication.practice.id !== opening.assignmentId ||
        publication.practice.version !== opening.practiceVersion
      ) {
        throw new ZipReadError("备份中的开卷意图与练习版本不一致");
      }
      const draft = kernelOpeningDraftSchema.parse(opening.draft);
      const actor = { role: "student", id: opening.studentId } as const;
      runtime.publish(opening.publication);
      const start = draft.prepared ? runtime.prepare : runtime.start;
      const receipt = start(actor, {
        protocolVersion: 1,
        operationId: `open:${opening.assignmentId}`,
        practiceId: opening.assignmentId,
        practiceVersion: opening.practiceVersion,
      });
      const activity = runtime.read(actor, receipt.activityId);
      try {
        verifyKernelMaterialContext(db, activity, opening.assignmentId, draft);
      } catch {
        throw new ZipReadError("备份中的开卷意图与内核材料不一致");
      }
      if (
        activity.status !== "active" ||
        runtime.readChoiceDraftActivity(actor, receipt.activityId) !== undefined
      ) {
        throw new ZipReadError("仍待开卷的作答已在内核产生学习记录");
      }
    }
    for (const { attempt, binding, confirmation, refreeze } of bindings) {
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
        const publication = publicationIdentitySchema.parse(
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
        try {
          verifyKernelMaterialContext(
            db,
            activity,
            binding.assignmentId,
            kernelRefreezeDraftSchema.parse(refreeze.responses),
          );
        } catch {
          throw new ZipReadError("备份中的重冻意图与内核材料不一致");
        }
      } else {
        try {
          verifyStoredKernelMaterialContext(db, activity, attempt);
        } catch {
          throw new ZipReadError("主库的冻结上下文与内核材料不一致");
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
