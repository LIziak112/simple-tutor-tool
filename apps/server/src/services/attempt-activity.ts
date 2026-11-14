import type { AttemptWriteProof } from "@tutor/contract";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, attempts } from "../db/schema";
import { HttpError } from "../lib/http-error.ts";

/** 请求到达前发生的重冻，必须由实际渲染/本机正文携带的身份证明。 */
export function assertAttemptWriteProof(
  attempt: Pick<
    Attempt,
    "frozenAt" | "startedAt" | "legacyUnverified" | "status"
  >,
  proof: AttemptWriteProof | undefined,
  questionRevisionId?: string,
  frozenQuestionRevisionId?: string,
): void {
  if (
    questionRevisionId !== undefined &&
    questionRevisionId !== frozenQuestionRevisionId
  )
    throw new HttpError(
      409,
      "QUESTION_REVISION_STALE",
      "题目版本已变化，请保留本机草稿并刷新练习",
    );
  if (proof?.expectedFrozenAt !== undefined) {
    if (proof.expectedFrozenAt !== attempt.frozenAt)
      throw new HttpError(
        409,
        "ATTEMPT_SNAPSHOT_CHANGED",
        "本机稿对应的题目版本已变化，请保留原稿并刷新练习",
      );
    return;
  }
  if (questionRevisionId !== undefined) return;
  if (
    attempt.status === "draft" &&
    !attempt.legacyUnverified &&
    attempt.frozenAt !== null &&
    attempt.frozenAt !== attempt.startedAt
  )
    throw new HttpError(
      409,
      "ATTEMPT_SNAPSHOT_CHANGED",
      "当前页面缺少原稿版本凭据，请保留本机稿并刷新练习",
    );
}

/** 文件校验/落盘在事务外时，取得写锁后再核对原冻结版本，关闭重冻竞态。 */
export function assertAttemptWriteVersion(
  db: Pick<Db, "select">,
  expected: Pick<Attempt, "id" | "frozenAt" | "status">,
): void {
  const fresh = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, expected.id))
    .get();
  if (!fresh) throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  if (fresh.abandonedAt !== null)
    throw new HttpError(409, "ATTEMPT_ABANDONED", "这份作答已作废");
  if (fresh.frozenAt !== expected.frozenAt)
    throw new HttpError(
      409,
      "ATTEMPT_SNAPSHOT_CHANGED",
      "题目冻结版本已变化，请保留本机草稿并刷新练习",
    );
  if (expected.status === "draft" && fresh.status !== "draft")
    throw new HttpError(409, "ALREADY_SUBMITTED", "本题已提交，不能再修改原稿");
}

/** 仅在作答有效写入的同一事务中调用；失败与幂等重放不得更新时间。 */
export function touchAttemptActivity(
  db: Pick<Db, "update">,
  attemptId: string,
  now: string,
): boolean {
  return (
    db
      .update(attempts)
      .set({
        activatedAt: sql`coalesce(${attempts.activatedAt}, ${now})`,
        lastActivityAt: sql`max(coalesce(${attempts.lastActivityAt}, ${attempts.startedAt}), ${now})`,
      })
      .where(
        and(
          eq(attempts.id, attemptId),
          eq(attempts.status, "draft"),
          isNull(attempts.abandonedAt),
        ),
      )
      .run().changes > 0
  );
}
