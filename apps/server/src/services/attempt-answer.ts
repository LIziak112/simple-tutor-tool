import {
  type AttemptAnswerSaveData,
  type AttemptAnswerSaveRequest,
  attemptAnswerConflictCurrentSchema,
  attemptAnswerSaveDataSchema,
  type StudentAnswer,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { responses } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  assertRowNotSubmitted,
  buildAttemptQuestionWhere,
  questionNotFound,
  requireAttemptQuestion,
  requireUsableAttempt,
} from "./attempt-access.ts";
import {
  assertAttemptWriteProof,
  assertAttemptWriteVersion,
  touchAttemptActivity,
} from "./attempt-activity";
import { assertFrozenAnswerShape } from "./attempt-question-projection.ts";
import { assertAttemptNotTimedOut } from "./attempt-timing";
import { answerOf, snapshotOfRow } from "./snapshot";

export function saveDraftAnswer(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  answer: StudentAnswer,
  options: Pick<
    AttemptAnswerSaveRequest,
    "baseRevision" | "mutationId" | "questionRevisionId" | "expectedFrozenAt"
  > = {},
): AttemptAnswerSaveData {
  return db.transaction((tx) => {
    const attempt = requireUsableAttempt(db, studentId, attemptId);
    if (attempt.status !== "draft") {
      throw new HttpError(
        409,
        "ALREADY_SUBMITTED",
        "这份练习已交卷，不能再修改答案",
      );
    }
    const existing = tx
      .select({
        id: responses.id,
        attemptId: responses.attemptId,
        questionId: responses.questionId,
        questionSnapshotJson: responses.questionSnapshotJson,
        unitId: responses.unitId,
        submittedAt: responses.submittedAt,
        changeCount: responses.changeCount,
        answerJson: responses.answerJson,
        answerRevision: responses.answerRevision,
        answerMutationId: responses.answerMutationId,
      })
      .from(responses)
      .where(buildAttemptQuestionWhere(attemptId, questionId))
      .get();
    if (existing === undefined) throw questionNotFound();
    assertAttemptWriteProof(
      attempt,
      options,
      options.questionRevisionId,
      existing.id,
    );
    if (existing.submittedAt !== null)
      throw new HttpError(
        409,
        "QUESTION_ALREADY_SUBMITTED",
        "这道题已经提交过了，不能再修改答案",
      );
    const encoded = JSON.stringify(answer);
    const conflict = () =>
      new HttpError(
        409,
        "ANSWER_REVISION_CONFLICT",
        "本题答案在另一设备已更新，请选择保留当前设备版本或采用云端版本",
        {
          _current: attemptAnswerConflictCurrentSchema.parse({
            revision: existing.answerRevision,
            draft: answerOf(existing.answerJson),
          }),
        },
      );
    if (
      options.mutationId !== undefined &&
      existing.answerMutationId === options.mutationId
    ) {
      if (encoded !== existing.answerJson) throw conflict();
      return attemptAnswerSaveDataSchema.parse({
        questionId,
        changeCount: existing.changeCount,
        revision: existing.answerRevision,
      });
    }
    // 模块 2：宽限结束后只允许重放既有回执。
    assertAttemptNotTimedOut(attempt);
    const snapshot = snapshotOfRow(existing);
    if (snapshot === null) throw questionNotFound();
    assertFrozenAnswerShape(db, existing, snapshot, answer);
    if (
      options.baseRevision === undefined &&
      existing.answerMutationId !== null
    )
      throw conflict();
    // 内容相同即收敛，不要求用户裁决，也不重复计数；接管后阻止旧客户端盲写。
    if (options.baseRevision !== undefined && encoded === existing.answerJson) {
      tx.update(responses)
        .set({ answerMutationId: options.mutationId })
        .where(eq(responses.id, existing.id))
        .run();
      return attemptAnswerSaveDataSchema.parse({
        questionId,
        changeCount: existing.changeCount,
        revision: existing.answerRevision,
      });
    }
    if (
      options.baseRevision !== undefined &&
      options.baseRevision !== existing.answerRevision
    )
      throw conflict();
    const nextCount = existing.changeCount + 1;
    const nextRevision = existing.answerRevision + 1;
    tx.update(responses)
      .set({
        answerJson: encoded,
        changeCount: nextCount,
        answerRevision: nextRevision,
        ...(options.mutationId === undefined
          ? {}
          : { answerMutationId: options.mutationId }),
      })
      .where(eq(responses.id, existing.id))
      .run();
    if (encoded !== existing.answerJson)
      touchAttemptActivity(tx, attemptId, new Date().toISOString());
    return attemptAnswerSaveDataSchema.parse({
      questionId,
      changeCount: nextCount,
      revision: nextRevision,
    });
  });
}

/**
 * 标注/取消「不会」（#6980-4）：仅 draft 可改（交卷后 409 ALREADY_SUBMITTED
 * ——「做题时标了不会」是入错题本的事实，交卷后不能再追加）；flag=null 取消。
 * 守卫与 saveDraftAnswer 同口径（requireUsableAttempt + 成员校验）。标志不是
 * 作答内容：请求/回执契约只有标志位，无泄露面（泄露测试见
 * routes/student-flags.test.ts）。
 */
export function setStudentFlag(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  flag: "unsure" | null,
): { questionId: string; studentFlag: string | null } {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.status !== "draft") {
    throw new HttpError(
      409,
      "ALREADY_SUBMITTED",
      "这份练习已交卷，不能再改标记",
    );
  }
  requireAttemptQuestion(db, attempt, questionId);
  // 行级锁（#6980-4 审查 P1-3）：单题已提交（逐题反馈/讲练看解析）后，
  // 「做题时标了不会」的事实已随提交落定，不能事后追加或取消——否则蒙对
  // 后可摘标记逃逸错题本。与 saveDraftAnswer / saveInk 同一守卫口径
  assertRowNotSubmitted(db, attemptId, questionId, "修改「不会」标记");
  db.transaction((tx) => {
    assertAttemptWriteVersion(tx, attempt);
    const old = tx
      .select({ flag: responses.studentFlag })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, questionId),
        ),
      )
      .get();
    if (old?.flag === flag) return;
    tx.update(responses)
      .set({ studentFlag: flag })
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, questionId),
        ),
      )
      .run();
    if (flag !== null)
      touchAttemptActivity(tx, attemptId, new Date().toISOString());
  });
  return { questionId, studentFlag: flag };
}
