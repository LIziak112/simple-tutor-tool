import {
  type AttemptAnswerSaveRequest,
  attemptAnswerConflictCurrentSchema,
  attemptAnswerSaveDataSchema,
  choiceStudentAnswerSchema,
  type StudentAnswer,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import {
  ChoiceDraftConflict,
  LearningError,
  type openLearningRuntime,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts, responses } from "../db/schema.ts";
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
import { isKernelAttempt } from "./kernel-assignment-routing.ts";
import {
  kernelAttemptUnavailable,
  withBoundKernelActivity,
} from "./kernel-assignment-runtime.ts";
import { snapshotOfRow } from "./snapshot.ts";

type Runtime = ReturnType<typeof openLearningRuntime>;
type DraftProof = Pick<
  AttemptAnswerSaveRequest,
  "baseRevision" | "mutationId" | "expectedFrozenAt" | "questionRevisionId"
>;

function projectDraftActivity(
  db: Db,
  attempt: Attempt,
  runtime: Runtime,
): Attempt {
  if (attempt.status !== "draft") return attempt;
  const times = runtime.readChoiceDraftActivity(
    { role: "student", id: attempt.studentId },
    attempt.id,
  );
  if (times === undefined) return attempt;
  const { firstChangedAt, lastChangedAt } = times;
  const activatedAt =
    firstChangedAt !== null &&
    (attempt.activatedAt === null || firstChangedAt < attempt.activatedAt)
      ? firstChangedAt
      : attempt.activatedAt;
  const previousActivity = attempt.lastActivityAt ?? attempt.startedAt;
  const lastActivityAt =
    lastChangedAt === null
      ? attempt.lastActivityAt
      : lastChangedAt > previousActivity
        ? lastChangedAt
        : previousActivity;
  if (
    activatedAt === attempt.activatedAt &&
    lastActivityAt === attempt.lastActivityAt
  )
    return attempt;
  db.update(attempts)
    .set({ activatedAt, lastActivityAt })
    .where(eq(attempts.id, attempt.id))
    .run();
  return { ...attempt, activatedAt, lastActivityAt };
}

function alreadySubmitted(): never {
  throw new HttpError(
    409,
    "ALREADY_SUBMITTED",
    "这份练习已交卷，不能再修改答案",
  );
}

function choiceAnswerOf(choice: string) {
  const parsed = choiceStudentAnswerSchema.safeParse({
    kind: "choice",
    index: Number(choice),
  });
  if (!parsed.success || String(parsed.data.index) !== choice)
    kernelAttemptUnavailable();
  return parsed.data;
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
          draft: choice === null ? null : choiceAnswerOf(choice),
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
          projectDraftActivity(db, attempt, runtime);
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
  if (!isKernelAttempt(db, requireOwnAttempt(db, studentId, attemptId)))
    return undefined;
  return db.$client
    .transaction(() => {
      const attempt = requireUsableAttempt(db, studentId, attemptId);
      return withBoundKernelActivity(
        db,
        dataDir,
        attempt,
        (runtime, activity) => {
          if (attempt.status === "draft" && activity.status !== "active")
            kernelAttemptUnavailable();
          const projected = projectDraftActivity(db, attempt, runtime);
          const heads =
            ("choiceDrafts" in activity ? activity.choiceDrafts : undefined) ??
            [];
          const now = new Date();
          const etag = draftEtag(db, projected, now, heads);
          if (etag !== null && etag === ifNoneMatch)
            return { etag, detail: null };
          const detail = detailOfAuthorizedAttempt(db, projected, now);
          if (!("drafts" in detail)) return { etag, detail };

          const questions = new Map(
            detail.units.flatMap(({ questions }) =>
              questions.map((question) => [question.id, question] as const),
            ),
          );
          const drafts: [string, ReturnType<typeof choiceAnswerOf>][] = [];
          const draftRevisions = new Map(
            [...questions.keys()].map((id) => [id, 0]),
          );
          for (const draft of heads) {
            const question = questions.get(draft.questionId);
            const answer = choiceAnswerOf(draft.choice);
            if (
              draft.slotId !== "answers" ||
              !question ||
              question.questionVersion !== draft.questionVersion ||
              question.options?.[answer.index] === undefined ||
              draftRevisions.get(draft.questionId) !== 0
            )
              kernelAttemptUnavailable();
            drafts.push([draft.questionId, answer]);
            draftRevisions.set(draft.questionId, draft.revision);
          }
          return {
            etag,
            detail: {
              ...detail,
              drafts: Object.fromEntries(drafts),
              draftRevisions: Object.fromEntries(draftRevisions),
            },
          };
        },
      );
    })
    .immediate();
}
