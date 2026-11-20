import { createHash } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { Assignment } from "../db/schema.ts";
import { kernelAssignmentVersions } from "../db/schema-kernel-assignments.ts";
import { kernelLessonOpenings } from "../db/schema-kernel-question-delivery.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { insertFrozenResponse } from "./attempt-freeze.ts";
import type {
  KernelOpeningDraft,
  loadKernelAssignmentQuestions,
} from "./kernel-assignment-input.ts";
import { kernelAssignmentPublication } from "./kernel-assignment-publication.ts";
import { ensureKernelRuntimeStorage } from "./kernel-assignment-runtime.ts";
import type { Tx } from "./question-sync.ts";

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
  const canInitialize =
    !tx
      .select({ assignmentId: kernelAssignmentVersions.assignmentId })
      .from(kernelAssignmentVersions)
      .limit(1)
      .get() &&
    !tx
      .select({ id: kernelLessonOpenings.operationId })
      .from(kernelLessonOpenings)
      .limit(1)
      .get();
  ensureKernelRuntimeStorage(db, dataDir, canInitialize);
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
