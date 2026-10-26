import { createHash } from "node:crypto";
import {
  hasReferenceAnswer,
  isSelfReviewQuestion,
  type SelfReviewData,
  type SelfReviewRequest,
} from "@tutor/contract";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts, responses } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { finalScoreOf, requireUsableAttempt } from "./attempt-service.ts";
import { questionReviewReadable } from "./review-access.ts";
import { effectiveCorrect, selfReviewStateOf } from "./review-state.ts";
import { snapshotOfRow } from "./snapshot.ts";

/** 事务内重查当前授权和版本；只返回判断声明，不返回答案、解析或教师私注。 */
export function saveSelfReview(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  request: SelfReviewRequest,
  now: Date | string = new Date(),
): SelfReviewData {
  return db.transaction(() => {
    const attempt = requireUsableAttempt(db, studentId, attemptId);
    const row = db
      .select()
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, questionId),
        ),
      )
      .get();
    const snapshot = row ? snapshotOfRow(row) : null;
    if (!row || !snapshot)
      throw new HttpError(404, "QUESTION_NOT_FOUND", "题目不存在");
    if (
      (attempt.status === "draft" && row.submittedAt === null) ||
      !questionReviewReadable(db, attempt, row, now) ||
      !isSelfReviewQuestion(snapshot) ||
      !hasReferenceAnswer(snapshot)
    ) {
      throw new HttpError(
        409,
        "SELF_REVIEW_UNAVAILABLE",
        "本题尚未提交或参考答案尚不可用，不能自评",
      );
    }
    if (row.teacherMark !== null)
      throw new HttpError(
        409,
        "SELF_REVIEW_TEACHER_MARKED",
        "老师已批改本题，请刷新查看教师判定",
      );
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          mark: request.mark,
          baseRevision: request.baseRevision,
        }),
      )
      .digest("hex");
    if (row.reviewMutationId === request.mutationId) {
      if (row.reviewMutationHash !== hash)
        throw new HttpError(
          409,
          "SELF_REVIEW_MUTATION_CONFLICT",
          "同一自评请求不能改变内容",
        );
      return {
        review: selfReviewStateOf(row, snapshot),
        finalCorrect: row.finalCorrect,
      };
    }
    if (row.reviewRevision !== request.baseRevision)
      throw new HttpError(
        409,
        "SELF_REVIEW_REVISION_CONFLICT",
        "本题评判已更新，请刷新后重新选择",
      );
    const updated = {
      ...row,
      selfCorrect: request.mark,
      reviewEligible: true,
      reviewRevision: row.reviewRevision + 1,
      reviewMutationId: request.mutationId,
      reviewMutationHash: hash,
      reviewedAt: new Date(now).toISOString(),
    };
    updated.finalCorrect = effectiveCorrect(updated);
    const saved = db
      .update(responses)
      .set({
        selfCorrect: updated.selfCorrect,
        reviewEligible: true,
        reviewRevision: updated.reviewRevision,
        reviewMutationId: updated.reviewMutationId,
        reviewMutationHash: hash,
        reviewedAt: updated.reviewedAt,
        finalCorrect: updated.finalCorrect,
      })
      .where(
        and(
          eq(responses.id, row.id),
          eq(responses.reviewRevision, request.baseRevision),
        ),
      )
      .run();
    if (saved.changes !== 1)
      throw new HttpError(
        409,
        "SELF_REVIEW_REVISION_CONFLICT",
        "本题评判已更新，请刷新后重试",
      );
    // 单题自评不结束进行中的整卷；已交卷才更新整卷完成态。
    if (attempt.status !== "draft") {
      const judged = db
        .select({ finalCorrect: responses.finalCorrect })
        .from(responses)
        .where(
          and(
            eq(responses.attemptId, attemptId),
            isNotNull(responses.questionSnapshotJson),
          ),
        )
        .all();
      db.update(attempts)
        .set(finalScoreOf(judged.map((item) => item.finalCorrect)))
        .where(eq(attempts.id, attemptId))
        .run();
    }
    return {
      review: selfReviewStateOf(updated, snapshot),
      finalCorrect: updated.finalCorrect,
    };
  });
}
