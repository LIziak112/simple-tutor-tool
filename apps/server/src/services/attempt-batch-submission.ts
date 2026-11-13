import { randomUUID } from "node:crypto";
import {
  ATTEMPT_BATCH_SUBMISSION_TTL_MS,
  ATTEMPT_SUBMIT_MAX_QUESTIONS,
  type AttemptBatchSubmissionBatch,
  type AttemptSubmitRequest,
  attemptBatchSubmissionBatchSchema,
} from "@tutor/contract";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  attemptBatchSubmissions,
  attemptSubmissionBatches,
  responses,
} from "../db/schema.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  attemptResponseRows,
  requireOwnAttempt,
  requireUsableAttempt,
  submitAttempt,
} from "./attempt-service.ts";
import { revisionStale } from "./attempt-submit-revisions.ts";
import { snapshotOfRow } from "./snapshot.ts";

function requireDraft(db: Db, studentId: string, attemptId: string) {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.status !== "draft") {
    throw new HttpError(409, "ALREADY_SUBMITTED", "这份练习已经交过卷了");
  }
  return attempt;
}

function expired(): HttpError {
  return new HttpError(
    409,
    "SUBMIT_BATCH_EXPIRED",
    "交卷暂存已失效，请重新确认交卷",
  );
}

function requireSession(
  db: Db,
  attemptId: string,
  submissionId: string,
  now: Date,
) {
  const session = db
    .select()
    .from(attemptBatchSubmissions)
    .where(
      and(
        eq(attemptBatchSubmissions.id, submissionId),
        eq(attemptBatchSubmissions.attemptId, attemptId),
      ),
    )
    .get();
  if (session === undefined || session.expiresAt <= now.toISOString())
    throw expired();
  return session;
}

export function purgeExpiredAttemptBatchSubmissions(db: Db, now = new Date()) {
  return db
    .delete(attemptBatchSubmissions)
    .where(lte(attemptBatchSubmissions.expiresAt, now.toISOString()))
    .run();
}

export function startAttemptBatchSubmission(
  db: Db,
  studentId: string,
  attemptId: string,
  batchCount: number,
  now = new Date(),
) {
  return db.transaction(
    (tx) => {
      requireDraft(db, studentId, attemptId);
      const questionCount = attemptResponseRows(db, attemptId).filter(
        (row) => snapshotOfRow(row) !== null,
      ).length;
      if (
        questionCount <= ATTEMPT_SUBMIT_MAX_QUESTIONS ||
        batchCount !== Math.ceil(questionCount / ATTEMPT_SUBMIT_MAX_QUESTIONS)
      ) {
        throw new HttpError(
          400,
          "SUBMIT_BATCH_COUNT_INVALID",
          "分批数量与本卷题数不符，请刷新后重试",
        );
      }
      const submissionId = randomUUID();
      const expiresAt = new Date(
        now.getTime() + ATTEMPT_BATCH_SUBMISSION_TTL_MS,
      ).toISOString();
      tx.delete(attemptBatchSubmissions)
        .where(eq(attemptBatchSubmissions.attemptId, attemptId))
        .run();
      tx.insert(attemptBatchSubmissions)
        .values({ id: submissionId, attemptId, batchCount, expiresAt })
        .run();
      return { submissionId, expiresAt };
    },
    { behavior: "immediate" },
  );
}

export function stageAttemptSubmissionBatch(
  db: Db,
  studentId: string,
  attemptId: string,
  submissionId: string,
  batch: AttemptBatchSubmissionBatch,
  now = new Date(),
) {
  return db.transaction(
    (tx) => {
      requireDraft(db, studentId, attemptId);
      const session = requireSession(db, attemptId, submissionId, now);
      const { batchIndex } = batch;
      if (
        batchIndex >= session.batchCount ||
        (batchIndex < session.batchCount - 1 &&
          batch.revisions.length !== ATTEMPT_SUBMIT_MAX_QUESTIONS)
      ) {
        throw new HttpError(
          400,
          "SUBMIT_BATCH_COUNT_INVALID",
          "分批编号或题数有误，请重新确认交卷",
        );
      }
      const payloadJson = canonicalJsonOf(batch);
      const previous = tx
        .select({ payloadJson: attemptSubmissionBatches.payloadJson })
        .from(attemptSubmissionBatches)
        .where(
          and(
            eq(attemptSubmissionBatches.submissionId, submissionId),
            eq(attemptSubmissionBatches.batchIndex, batchIndex),
          ),
        )
        .get();
      if (previous !== undefined) {
        if (previous.payloadJson !== payloadJson) {
          throw new HttpError(
            409,
            "SUBMIT_BATCH_CONFLICT",
            "同一批次的内容已变化，请重新确认交卷",
          );
        }
        return { batchIndex };
      }
      const questionIds = new Set(
        batch.revisions.map((revision) => revision.questionId),
      );
      if (questionIds.size !== batch.revisions.length) throw revisionStale();
      const actualRows = tx
        .select({ id: responses.id, questionId: responses.questionId })
        .from(responses)
        .where(
          and(
            eq(responses.attemptId, attemptId),
            inArray(responses.questionId, [...questionIds]),
          ),
        )
        .all();
      const rowIdByQuestion = new Map(
        actualRows.map((row) => [row.questionId, row.id]),
      );
      if (
        batch.revisions.some(
          (item) =>
            rowIdByQuestion.get(item.questionId) !== item.questionRevisionId,
        )
      )
        throw revisionStale();
      const evidenceIds = new Set(
        batch.evidence.map((evidence) => evidence.questionId),
      );
      if (
        evidenceIds.size !== batch.evidence.length ||
        [...evidenceIds].some((id) => !questionIds.has(id))
      ) {
        throw new HttpError(
          409,
          "NOTE_EVIDENCE_MISMATCH",
          "本批原稿声明与题目不符，请重新确认交卷",
        );
      }
      tx.insert(attemptSubmissionBatches)
        .values({ submissionId, batchIndex, payloadJson })
        .run();
      return { batchIndex };
    },
    { behavior: "immediate" },
  );
}

export function finishAttemptBatchSubmission(
  db: Db,
  studentId: string,
  attemptId: string,
  submissionId: string,
  confirmedSavedAnswers: true | undefined,
  now = new Date(),
) {
  return db.transaction(
    (tx) => {
      requireDraft(db, studentId, attemptId);
      const session = requireSession(db, attemptId, submissionId, now);
      const batches = tx
        .select()
        .from(attemptSubmissionBatches)
        .where(eq(attemptSubmissionBatches.submissionId, submissionId))
        .orderBy(asc(attemptSubmissionBatches.batchIndex))
        .all();
      if (batches.length !== session.batchCount)
        throw new HttpError(
          409,
          "SUBMIT_BATCH_INCOMPLETE",
          "还有题目尚未上传，请重试交卷",
        );
      const payloads = batches.map(({ payloadJson }) =>
        attemptBatchSubmissionBatchSchema.parse(JSON.parse(payloadJson)),
      );
      const request: AttemptSubmitRequest = {
        revisions: payloads.flatMap((batch) => batch.revisions),
        evidence: payloads.flatMap((batch) => batch.evidence),
        confirmedSavedAnswers,
      };
      const result = submitAttempt(db, studentId, attemptId, now, request);
      tx.delete(attemptBatchSubmissions)
        .where(eq(attemptBatchSubmissions.id, submissionId))
        .run();
      return result;
    },
    { behavior: "immediate" },
  );
}

export function cancelAttemptBatchSubmission(
  db: Db,
  studentId: string,
  attemptId: string,
  submissionId: string,
) {
  requireOwnAttempt(db, studentId, attemptId);
  db.delete(attemptBatchSubmissions)
    .where(
      and(
        eq(attemptBatchSubmissions.id, submissionId),
        eq(attemptBatchSubmissions.attemptId, attemptId),
      ),
    )
    .run();
}
