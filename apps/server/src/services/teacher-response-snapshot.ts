import { isDeepStrictEqual } from "node:util";
import {
  gradingPolicyOf,
  type Question,
  questionEvidenceBindings,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { annotationBases, ink, notes, type ResponseRow } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";

export function assertTeacherDraftSnapshot(
  row: ResponseRow,
  original: Question,
  snapshot: Question,
) {
  if (
    snapshot.id !== row.questionId ||
    snapshot.type !== original.type ||
    !isDeepStrictEqual(
      snapshot.materialRefs ?? [],
      original.materialRefs ?? [],
    ) ||
    (snapshot.answers !== undefined &&
      snapshot.answers.kind !==
        questionEvidenceBindings[snapshot.type].answerKind) ||
    (row.gradingPolicy !== null &&
      gradingPolicyOf(snapshot) !== row.gradingPolicy)
  ) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "题号、题型、材料引用与冻结判分策略须保持一致",
    );
  }
}

export function hasTeacherDraftSnapshotEvidence(
  db: Pick<Db, "select">,
  row: ResponseRow,
): boolean {
  return (
    row.answerJson !== null ||
    row.hintsUsed > 0 ||
    [ink, notes, annotationBases].some(
      (table) =>
        db
          .select({ id: table.id })
          .from(table)
          .where(
            and(
              eq(table.attemptId, row.attemptId),
              eq(table.questionId, row.questionId),
            ),
          )
          .get() !== undefined,
    )
  );
}

export function responseEvidenceExists(): HttpError {
  return new HttpError(
    409,
    "RESPONSE_EVIDENCE_EXISTS",
    "本题已留存作答材料，不能覆盖原题面",
  );
}
