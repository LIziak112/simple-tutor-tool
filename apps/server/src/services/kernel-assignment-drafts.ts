import {
  type AttemptAnswerSaveRequest,
  attemptAnswerConflictCurrentSchema,
  attemptAnswerSaveDataSchema,
  choiceStudentAnswerSchema,
  type StudentAnswer,
} from "@tutor/contract";
import {
  ChoiceDraftConflict,
  LearningError,
  type openLearningRuntime,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import { type Attempt, responses } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  buildAttemptQuestionWhere,
  questionNotFound,
  requireOwnAttempt,
  requireUsableAttempt,
} from "./attempt-access.ts";
import { assertAttemptWriteProof } from "./attempt-activity.ts";
import { saveDraftAnswer } from "./attempt-answer.ts";
import { detailOfAuthorizedAttempt } from "./attempt-detail.ts";
import {
  type ConditionalAttemptDetail,
  draftEtag,
} from "./attempt-detail-cache.ts";
import { assertAttemptNotTimedOut, attemptTimingOf } from "./attempt-timing.ts";
import { projectKernelDraftActivity } from "./kernel-assignment-activity.ts";
import { readKernelConfirmationResult } from "./kernel-assignment-confirmation.ts";
import { kernelDraftRowsOf } from "./kernel-assignment-facts.ts";
import { resolveKernelRefreezeForRead } from "./kernel-assignment-refreeze.ts";
import { isKernelAttempt } from "./kernel-assignment-routing.ts";
import {
  kernelAttemptUnavailable,
  ownClassChoiceAnswerOf,
  withBoundKernelActivity,
} from "./kernel-assignment-runtime.ts";
import { recoverKernelChoiceSnapshot } from "./kernel-choice-amendments.ts";
import { answerOf, snapshotOfRow } from "./snapshot.ts";

type Runtime = ReturnType<typeof openLearningRuntime>;
type DraftProof = Pick<
  AttemptAnswerSaveRequest,
  "baseRevision" | "mutationId" | "expectedFrozenAt" | "questionRevisionId"
>;

function alreadySubmitted(): never {
  throw new HttpError(
    409,
    "ALREADY_SUBMITTED",
    "这份练习已交卷，不能再修改答案",
  );
}

function invalidAnswer(): never {
  throw new HttpError(400, "VALIDATION_ERROR", "答案结构不合法");
}

function throwDraftError(
  error: unknown,
  attempt: Attempt,
  authorizedAt: Date,
): never {
  if (error instanceof ChoiceDraftConflict) {
    const { choice, revision } = error.current;
    throw new HttpError(
      409,
      "ANSWER_REVISION_CONFLICT",
      "本题答案在另一设备已更新，请选择保留当前设备版本或采用云端版本",
      {
        _current: attemptAnswerConflictCurrentSchema.parse({
          revision,
          draft: choice === null ? null : ownClassChoiceAnswerOf(choice),
        }),
      },
    );
  }
  if (error instanceof LearningError) {
    switch (error.code) {
      case "ALREADY_SUBMITTED":
        return alreadySubmitted();
      case "DRAFT_REPLAY_REQUIRED":
        assertAttemptNotTimedOut(attempt, authorizedAt);
        break;
      case "INVALID_CHOICE":
        return invalidAnswer();
      case "QUESTION_REVISION_STALE":
        throw new HttpError(
          409,
          "QUESTION_REVISION_STALE",
          "题目版本已变化，请保留本机草稿并刷新练习",
        );
    }
  }
  throw error;
}

export function saveAssignmentDraftAnswer(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
  answer: StudentAnswer,
  proof: DraftProof = {},
) {
  if (!isKernelAttempt(db, requireOwnAttempt(db, studentId, attemptId)))
    return saveDraftAnswer(db, studentId, attemptId, questionId, answer, proof);

  // 与同产品库的开卷、撤销及完成串行。内核独占答案写入，跨库中断后按内核时刻补投影。
  return db.$client
    .transaction(() => {
      const attempt = requireUsableAttempt(db, studentId, attemptId);
      if (attempt.status !== "draft") alreadySubmitted();
      recoverKernelChoiceSnapshot(db, dataDir, attempt.id);
      return withBoundKernelActivity(
        db,
        dataDir,
        attempt,
        (runtime, activity, stepAttemptId) => {
          if (activity.status === "completed") alreadySubmitted();
          const row = db
            .select()
            .from(responses)
            .where(buildAttemptQuestionWhere(attemptId, questionId))
            .get();
          if (row === undefined) throw questionNotFound();
          assertAttemptWriteProof(
            attempt,
            proof,
            proof.questionRevisionId,
            row.id,
          );
          if (row.submittedAt !== null)
            throw new HttpError(
              409,
              "QUESTION_ALREADY_SUBMITTED",
              "这道题已经提交过了，不能再修改答案",
            );
          if (snapshotOfRow(row)?.id !== questionId) throw questionNotFound();
          const choice = choiceStudentAnswerSchema.safeParse(answer);
          if (!choice.success) invalidAnswer();
          const authorizedAt = new Date();
          const mode =
            attemptTimingOf(attempt, authorizedAt)?.phase === "locked"
              ? "replayLatestOnly"
              : "save";
          const { mutationId, baseRevision } = proof;
          let receipt: ReturnType<Runtime["saveCurrentChoiceDraft"]>;
          try {
            receipt = runtime.saveCurrentChoiceDraft(
              { role: "student", id: studentId },
              attemptId,
              {
                protocolVersion: 1,
                stepAttemptId,
                slotId: "answers",
                questionId,
                questionVersion: row.questionVersion,
                choice: String(choice.data.index),
                ...(mutationId === undefined || baseRevision === undefined
                  ? {}
                  : { operationId: mutationId, baseRevision }),
              },
              mode,
            );
          } catch (error) {
            throwDraftError(error, attempt, authorizedAt);
          }
          projectKernelDraftActivity(db, attempt, runtime);
          return attemptAnswerSaveDataSchema.parse(receipt);
        },
      );
    })
    .immediate();
}

export function readKernelAssignmentDetail(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  ifNoneMatch: string | undefined,
): ConditionalAttemptDetail | undefined {
  const ownAttempt = requireOwnAttempt(db, studentId, attemptId);
  if (!isKernelAttempt(db, ownAttempt)) return undefined;
  resolveKernelRefreezeForRead(db, dataDir, ownAttempt);
  return db.$client
    .transaction(() => {
      const attempt = requireUsableAttempt(db, studentId, attemptId);
      const now = new Date();
      const confirmed = readKernelConfirmationResult(db, dataDir, attempt, now);
      if (confirmed !== undefined) return { etag: null, detail: confirmed };
      if (attempt.status !== "draft") kernelAttemptUnavailable();
      return withBoundKernelActivity(
        db,
        dataDir,
        attempt,
        (runtime, activity) => {
          if (activity.status !== "active") kernelAttemptUnavailable();
          const projected = projectKernelDraftActivity(db, attempt, runtime);
          const heads =
            ("choiceDrafts" in activity ? activity.choiceDrafts : undefined) ??
            [];

          const etag = draftEtag(db, projected, now, heads);
          if (etag !== null && etag === ifNoneMatch)
            return { etag, detail: null };
          const detail = detailOfAuthorizedAttempt(db, projected, now);
          if (!("drafts" in detail)) kernelAttemptUnavailable();

          const rows = kernelDraftRowsOf(db, projected, activity);
          const drafts = rows.flatMap(({ questionId, answerJson }) => {
            const answer = answerOf(answerJson);
            return answer === null ? [] : [[questionId, answer] as const];
          });
          return {
            etag,
            detail: {
              ...detail,
              drafts: Object.fromEntries(drafts),
              draftRevisions: Object.fromEntries(
                rows.map(({ questionId, answerRevision }) => [
                  questionId,
                  answerRevision,
                ]),
              ),
            },
          };
        },
      );
    })
    .immediate();
}
