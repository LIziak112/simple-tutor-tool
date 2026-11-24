import { createHash, randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { Assignment, Attempt } from "../db/schema.ts";
import {
  kernelAssignmentVersions,
  kernelAttemptRefreezes,
} from "../db/schema-kernel-assignments.ts";
import {
  kernelCourseOpenings,
  kernelLessonOpenings,
  kernelWrongOpenings,
} from "../db/schema-kernel-question-delivery.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { attemptResponseRows, insertFrozenResponse } from "./attempt-freeze.ts";
import type {
  KernelOpeningDraft,
  loadKernelAssignmentQuestions,
} from "./kernel-assignment-input.ts";
import { kernelAssignmentPublication } from "./kernel-assignment-publication.ts";
import {
  ensureKernelRuntimeStorage,
  frozenKernelContextOf,
  kernelAttemptUnavailable,
} from "./kernel-assignment-runtime.ts";
import type { Tx } from "./question-sync.ts";

export function canInitializeKernelStorage(tx: Pick<Db, "select">): boolean {
  return !(
    tx
      .select({ id: kernelAssignmentVersions.assignmentId })
      .from(kernelAssignmentVersions)
      .limit(1)
      .get() ||
    tx
      .select({ id: kernelLessonOpenings.operationId })
      .from(kernelLessonOpenings)
      .limit(1)
      .get() ||
    tx
      .select({ id: kernelCourseOpenings.operationId })
      .from(kernelCourseOpenings)
      .limit(1)
      .get() ||
    tx
      .select({ id: kernelWrongOpenings.id })
      .from(kernelWrongOpenings)
      .limit(1)
      .get()
  );
}

export function reserveKernelAssignmentVersion(
  db: Db,
  tx: Tx,
  dataDir: string,
  assignment: Assignment,
  definition: ReturnType<typeof loadKernelAssignmentQuestions>,
) {
  const { responses } = definition;
  const assignmentId = assignment.id;
  const publication = kernelAssignmentPublication(assignment, 1, definition);
  const fingerprint = createHash("sha256")
    .update(
      canonicalJsonOf({
        publication,
        ...(definition.context.length > 0 && { context: definition.context }),
        frozen: responses.map(({ question, unitId, questionVersion }) => ({
          id: question.id,
          unitId,
          version: questionVersion,
        })),
      }),
    )
    .digest("hex");
  const known = tx
    .select()
    .from(kernelAssignmentVersions)
    .where(
      and(
        eq(kernelAssignmentVersions.assignmentId, assignmentId),
        eq(kernelAssignmentVersions.fingerprint, fingerprint),
      ),
    )
    .get();
  const latest = known
    ? undefined
    : tx
        .select({ version: max(kernelAssignmentVersions.practiceVersion) })
        .from(kernelAssignmentVersions)
        .where(eq(kernelAssignmentVersions.assignmentId, assignmentId))
        .get();
  const practiceVersion = known?.practiceVersion ?? (latest?.version ?? 0) + 1;
  ensureKernelRuntimeStorage(db, dataDir, canInitializeKernelStorage(tx));
  if (!known)
    tx.insert(kernelAssignmentVersions)
      .values({ assignmentId, practiceVersion, fingerprint })
      .run();
  return {
    practiceVersion,
    publication:
      practiceVersion === 1
        ? publication
        : kernelAssignmentPublication(assignment, practiceVersion, definition),
  };
}

type RefreezeTicket = typeof kernelAttemptRefreezes.$inferSelect;

export function sameKernelFrozenDefinition(
  db: Db,
  attempt: Attempt,
  definition: Pick<KernelOpeningDraft, "context" | "responses">,
): boolean {
  const current = attemptResponseRows(db, attempt.id);
  return (
    canonicalJsonOf(
      frozenKernelContextOf(db, attempt.id).map(canonicalJsonOf).sort(),
    ) ===
      canonicalJsonOf((definition.context ?? []).map(canonicalJsonOf).sort()) &&
    current.length === definition.responses.length &&
    current.every((row, index) => {
      const next = definition.responses[index];
      return (
        row.questionId === next?.question.id &&
        row.questionVersion === next.questionVersion &&
        row.unitId === next.unitId
      );
    })
  );
}

export function writeKernelRefreezeIntent(
  tx: Tx,
  attempt: Attempt,
  binding: Pick<
    RefreezeTicket,
    | "expectedPracticeVersion"
    | "stepAttemptId"
    | "practiceVersion"
    | "publication"
  >,
  frozen: Pick<KernelOpeningDraft, "context" | "responses">,
) {
  if (binding.practiceVersion === binding.expectedPracticeVersion)
    kernelAttemptUnavailable();
  const frozenAt = new Date(
    Math.max(Date.now(), Date.parse(attempt.frozenAt ?? attempt.startedAt) + 1),
  ).toISOString();
  tx.insert(kernelAttemptRefreezes)
    .values({
      attemptId: attempt.id,
      operationId: `refreeze:${randomUUID()}`,
      frozenAt,
      ...binding,
      responses: frozen.context?.length
        ? { responses: frozen.responses, context: frozen.context }
        : frozen.responses,
    })
    .run();
}

export function insertKernelFrozenResponses(
  tx: Tx,
  attemptId: string,
  responses: KernelOpeningDraft["responses"],
) {
  for (const { question, questionVersion, unitId, gradingPolicy } of responses)
    insertFrozenResponse(tx, {
      attemptId,
      questionId: question.id,
      questionVersion,
      unitId,
      gradingPolicy,
      questionSnapshotJson: JSON.stringify(question),
    });
}
