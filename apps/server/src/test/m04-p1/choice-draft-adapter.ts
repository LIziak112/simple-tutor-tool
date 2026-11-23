import {
  attemptAnswerConflictCurrentSchema,
  attemptAnswerSaveDataSchema,
} from "@tutor/contract";
import type { openLearningRuntime, StudentPrincipal } from "learning-kernel";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import type { Attempt } from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { questionNotFound } from "../../services/attempt-access.ts";
import { assertAttemptWriteProof } from "../../services/attempt-activity.ts";
import type { saveDraftAnswer } from "../../services/attempt-answer.ts";
import { attemptResponseRows } from "../../services/attempt-freeze.ts";
import { assertFrozenAnswerShape } from "../../services/attempt-question-projection.ts";
import { snapshotOfRow } from "../../services/snapshot.ts";

export type TrialSaveChoiceDraft = ReturnType<
  typeof openLearningRuntime
>["saveChoiceDraft"];

const draftConflictSchema = z.object({
  status: z.literal(409),
  code: z.enum(["OPERATION_CONFLICT", "ANSWER_REVISION_CONFLICT"]),
  current: z
    .object({ revision: z.int(), choice: z.string().nullable() })
    .optional(),
});
export type DraftConflict = z.infer<typeof draftConflictSchema>;
const closedDraftSchema = z.object({
  status: z.literal(409),
  code: z.literal("ALREADY_SUBMITTED"),
});
const closedDraft = () =>
  new HttpError(409, "ALREADY_SUBMITTED", "这份练习已交卷，不能再修改答案");

export function createTrialChoiceDraftSaver(
  saveChoiceDraft: TrialSaveChoiceDraft,
  boundActivity: (
    db: Db,
    studentId: string,
    attemptId: string,
  ) => { attempt: Attempt; stepAttemptId: string },
  options: {
    versionedOnly?: boolean;
    isClosed?: (principal: StudentPrincipal, activityId: string) => boolean;
    onOperationConflict?: (error: DraftConflict) => void;
  } = {},
): typeof saveDraftAnswer {
  return (db, studentId, attemptId, questionId, answer, proof = {}) => {
    const { attempt, stepAttemptId } = boundActivity(db, studentId, attemptId);
    const principal = { role: "student", id: studentId } as const;
    if (
      attempt.status !== "draft" ||
      options.isClosed?.(principal, attemptId)
    ) {
      throw closedDraft();
    }
    const row = attemptResponseRows(db, attemptId).find(
      (row) => row.questionId === questionId,
    );
    if (row === undefined) throw questionNotFound();
    assertAttemptWriteProof(attempt, proof, proof.questionRevisionId, row.id);
    const snapshot = snapshotOfRow(row);
    if (snapshot === null) throw questionNotFound();
    assertFrozenAnswerShape(db, row, snapshot, answer);
    const { baseRevision, mutationId } = proof;
    const hasRevision = baseRevision !== undefined;
    if (
      answer.kind !== "choice" ||
      hasRevision !== (mutationId !== undefined) ||
      (options.versionedOnly && !hasRevision)
    ) {
      throw new HttpError(400, "VALIDATION_ERROR", "须提供单选答案及保存凭据");
    }
    try {
      return attemptAnswerSaveDataSchema.parse(
        saveChoiceDraft(principal, attemptId, {
          protocolVersion: 1,
          stepAttemptId,
          slotId: "answers",
          questionId,
          questionVersion: row.questionVersion,
          choice: String(answer.index),
          ...(baseRevision !== undefined && mutationId !== undefined
            ? { operationId: mutationId, baseRevision }
            : {}),
        }),
      );
    } catch (error) {
      if (closedDraftSchema.safeParse(error).success) {
        throw closedDraft();
      }
      const parsed = draftConflictSchema.safeParse(error);
      if (!parsed.success) throw error;
      const { code, current } = parsed.data;
      if (code === "OPERATION_CONFLICT")
        options.onOperationConflict?.(parsed.data);
      // 内核随异常提供同一事务内读取的云端稿。
      const details = current
        ? {
            _current: attemptAnswerConflictCurrentSchema.parse({
              revision: current.revision,
              draft:
                current.choice === null
                  ? null
                  : { kind: "choice", index: Number(current.choice) },
            }),
          }
        : undefined;
      throw new HttpError(
        409,
        current ? "ANSWER_REVISION_CONFLICT" : code,
        "本题答案保存发生冲突",
        details,
      );
    }
  };
}
