import type { LearningPackResponse } from "@tutor/contract";
import type { Attempt, ResponseRow } from "../db/schema";
import {
  answerOf,
  effectiveVerdictOfRow,
  selfReviewRecordOf,
} from "./attempt-service";
import type { PackCore } from "./export-service";
export function responseBaseOf(
  core: PackCore,
  attempt: Attempt,
  row: ResponseRow,
  no: number,
): LearningPackResponse {
  const inkFile = core.inkEntryByAttemptQuestion.get(
    `${attempt.id}:${row.questionId}`,
  );
  const effectiveSourceOfRow = effectiveVerdictOfRow(row)?.source;
  return {
    attemptId: attempt.id,
    studentId: attempt.studentId,
    questionId: row.questionId,
    no,
    time: core.timeProjection.responseTime.get(row.id),
    answerText: core.answerTextOf(attempt.id, row, answerOf(row.answerJson)),
    autoCorrect: row.autoCorrect,
    finalCorrect: row.finalCorrect,
    // 判定来源（两线收敛接线：v2 来源标注改走 QM 有效判定单一出处）
    ...(effectiveSourceOfRow !== undefined
      ? { reviewSource: effectiveSourceOfRow }
      : {}),
    teacherMark:
      row.teacherMark === "correct" || row.teacherMark === "wrong"
        ? row.teacherMark
        : null,
    teacherComment: row.teacherComment,
    // QM-12：自评记录与行策略（教师面数据包——判定来源可见，与教师详情同形）
    selfReview: selfReviewRecordOf(row),
    gradingPolicy: row.gradingPolicy,
    ...(inkFile !== undefined ? { inkFile } : {}),
  };
}
