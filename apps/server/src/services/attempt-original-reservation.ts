import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { submissionEvidence } from "../db/schema.ts";
import { attemptOriginalReservations } from "../db/schema-attempt-original-reservations.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertRowNotSubmitted,
  requireAttemptQuestion,
  requireUsableAttempt,
} from "./attempt-access.ts";
import { buildSingleQuestionEvidence } from "./attempt-submit-evidence.ts";
import { readNoteVersionDoc } from "./note-service.ts";

type Selection = { questionId: string; versionId: string; revision: number };
type ReservedOriginal = Selection & { hash: string };
type Operation = { attemptId: string; operationId: string };
type Intent = Operation & {
  studentId: string;
  originals: readonly Selection[];
};
type Outcome = "projected" | "aborted";

function reservationScope(operation: Operation) {
  return and(
    eq(attemptOriginalReservations.attemptId, operation.attemptId),
    eq(attemptOriginalReservations.operationId, operation.operationId),
  );
}

function operationRows(db: Pick<Db, "select">, operation: Operation) {
  return db
    .select()
    .from(attemptOriginalReservations)
    .where(reservationScope(operation))
    .orderBy(attemptOriginalReservations.questionId)
    .all();
}

function reservationConflict() {
  return new HttpError(
    409,
    "NOTE_EVIDENCE_MISMATCH",
    "原稿预留与本次交卷操作不一致",
  );
}

/**
 * 仅登记有不可变版本的原稿。空集合无保护记录；整份交卷的答案和其他证据
 * 声明仍由权威交卷操作绑定。预留不会写入提交状态、成绩或正式原稿。
 */
export function reserveSubmissionOriginals(
  db: Db,
  dataDir: string,
  intent: Intent,
): ReservedOriginal[] {
  return db.transaction(
    (tx) => {
      const { studentId, attemptId, operationId, originals } = intent;
      const attempt = requireUsableAttempt(db, studentId, attemptId);
      const byQuestion = new Map(
        originals.map((original) => [original.questionId, original]),
      );
      if (byQuestion.size !== originals.length) throw reservationConflict();

      const existing = operationRows(tx, intent);
      if (existing.length > 0) {
        if (
          existing.length !== originals.length ||
          existing.some((row) => {
            const wanted = byQuestion.get(row.questionId);
            return (
              row.state === "aborted" ||
              wanted?.versionId !== row.versionId ||
              wanted.revision !== row.revision
            );
          })
        )
          throw reservationConflict();
        return existing.map(({ questionId, versionId, revision, hash }) => ({
          questionId,
          versionId,
          revision,
          hash,
        }));
      }

      if (originals.length === 0) return [];
      if (attempt.sourceType !== "assignment") throw reservationConflict();
      if (attempt.status !== "draft") {
        throw new HttpError(409, "ALREADY_SUBMITTED", "这份练习已经交过卷了");
      }

      const rows = originals.map((selection) => {
        requireAttemptQuestion(db, attempt, selection.questionId);
        assertRowNotSubmitted(db, attemptId, selection.questionId, "预留原稿");
        buildSingleQuestionEvidence(tx, attemptId, selection.questionId, {
          ...selection,
          state: "frozen",
        });
        const { rowHash, recomputedHash } = readNoteVersionDoc(
          db,
          dataDir,
          selection.versionId,
        );
        if (rowHash !== recomputedHash) {
          throw new HttpError(
            500,
            "NOTE_BODY_UNREADABLE",
            "笔记正文文件损坏，请联系老师处理",
          );
        }
        return {
          ...selection,
          operationId,
          attemptId,
          hash: rowHash,
          pendingVersionId: selection.versionId,
          state: "pending" as const,
        };
      });
      tx.insert(attemptOriginalReservations).values(rows).run();
      return operationRows(tx, intent).map(
        ({ questionId, versionId, revision, hash }) => ({
          questionId,
          versionId,
          revision,
          hash,
        }),
      );
    },
    { behavior: "immediate" },
  );
}

/**
 * 仅供可信服务端确认流程使用。结果未知时继续保留，明确终止才能传 aborted。
 * 投影时只采用同卷同题的正式版本引用，校验与解除在同一事务内。
 */
export function settleSubmissionOriginalReservation(
  db: Pick<Db, "transaction">,
  operation: Operation,
  outcome: Outcome,
): void {
  if (outcome !== "projected" && outcome !== "aborted") {
    throw reservationConflict();
  }
  db.transaction(
    (tx) => {
      const rows = operationRows(tx, operation);
      if (rows.length === 0 || rows.every(({ state }) => state === outcome))
        return;
      if (rows.some(({ state }) => state !== "pending"))
        throw reservationConflict();

      if (outcome === "projected") {
        const formal = tx
          .select({
            questionId: submissionEvidence.questionId,
            versionId: submissionEvidence.versionId,
          })
          .from(submissionEvidence)
          .where(
            and(
              eq(submissionEvidence.attemptId, operation.attemptId),
              eq(submissionEvidence.state, "frozen"),
            ),
          )
          .all();
        const byQuestion = new Map(
          formal.map(({ questionId, versionId }) => [questionId, versionId]),
        );
        if (
          rows.some(
            ({ questionId, versionId }) =>
              byQuestion.get(questionId) !== versionId,
          )
        ) {
          throw reservationConflict();
        }
      }

      tx.update(attemptOriginalReservations)
        .set({ state: outcome, pendingVersionId: null })
        .where(reservationScope(operation))
        .run();
    },
    { behavior: "immediate" },
  );
}
