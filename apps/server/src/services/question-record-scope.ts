import type { Db } from "../db/client.ts";
import type { Attempt, ResponseRow } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireOwnAttempt, requireUsableAttempt } from "./attempt-access.ts";
import { frozenRowsInDisplayOrder } from "./attempt-rows.ts";
import { readKernelAttemptFacts } from "./kernel-assignment-facts.ts";
import { resolveKernelRefreezeForRead } from "./kernel-assignment-refreeze.ts";
import {
  hasKernelAssignmentTables,
  isKernelAttempt,
} from "./kernel-assignment-routing.ts";
import { requireTeacherAttempt } from "./teacher-attempt-service.ts";

export type QuestionRecordPrincipal = {
  readonly kind: "student" | "teacher";
  readonly id: string;
};
export interface QuestionRecordScope {
  readonly role: QuestionRecordPrincipal["kind"];
  attempt: Attempt;
  row: ResponseRow;
  no: number;
  kernelConfirmed: boolean;
}

/** 学习记录和单题包在同一角色授权及冻结题视图中读取。 */
export function withQuestionRecordScope<T>(
  db: Db,
  dataDir: string,
  principal: QuestionRecordPrincipal,
  attemptId: string,
  questionId: string,
  read: (scope: QuestionRecordScope) => T,
): T {
  const ownedAttempt = () =>
    principal.kind === "teacher"
      ? requireTeacherAttempt(db, principal.id, attemptId).attempt
      : requireOwnAttempt(db, principal.id, attemptId);
  const initial = ownedAttempt();
  const authorizedAttempt = (attempt: Attempt) =>
    principal.kind === "student"
      ? requireUsableAttempt(db, principal.id, attemptId)
      : attempt;

  function select(attempt: Attempt, rows?: readonly ResponseRow[]) {
    let no = 0;
    for (const { row } of frozenRowsInDisplayOrder(db, attempt, rows)) {
      if (row.questionSnapshotJson !== null) no++;
      if (row.questionId === questionId) {
        return read({
          role: principal.kind,
          attempt,
          row,
          no,
          kernelConfirmed: rows !== undefined && attempt.status !== "draft",
        });
      }
    }
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在或不属于这次练习",
    );
  }
  if (!hasKernelAssignmentTables(db) || !isKernelAttempt(db, initial))
    return select(authorizedAttempt(initial));

  return db.$client
    .transaction(() => {
      const owned = ownedAttempt();
      resolveKernelRefreezeForRead(db, dataDir, owned);
      const { attempt, rows } = readKernelAttemptFacts(
        db,
        dataDir,
        authorizedAttempt(ownedAttempt()),
      );
      return select(attempt, rows);
    })
    .immediate();
}
