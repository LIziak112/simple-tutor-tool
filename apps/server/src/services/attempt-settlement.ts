import { createHash, randomUUID } from "node:crypto";
import { attemptSettlementSchema } from "@tutor/contract";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attemptSettlements, attempts, responses } from "../db/schema.ts";
import { recordedActiveSecTotal } from "./submission-time.ts";

type SettlementTx = Pick<Db, "select" | "insert" | "update">;

/** 只能在取得写锁的完成事务内调用；历史回填复用同一成员和 NULL/0 口径。 */
export function writeFinalSettlementWithin(
  tx: SettlementTx,
  attemptId: string,
) {
  const attempt = tx
    .select({ status: attempts.status, submittedAt: attempts.submittedAt })
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  if (!attempt || attempt.status === "draft" || attempt.submittedAt === null)
    throw new Error("结算需要真实整卷完成事实");
  const remaining = tx
    .select({
      id: responses.id,
      answerRevision: responses.answerRevision,
      submittedAt: responses.submittedAt,
      activeSec: responses.activeSec,
    })
    .from(responses)
    .where(
      and(eq(responses.attemptId, attemptId), isNull(responses.settlementSeq)),
    )
    .orderBy(asc(responses.id))
    .all();
  const previous = tx
    .select()
    .from(attemptSettlements)
    .where(
      and(
        eq(attemptSettlements.attemptId, attemptId),
        eq(attemptSettlements.kind, "final"),
      ),
    )
    .get();
  if (previous) {
    if (remaining.length > 0) throw new Error("已完成结算仍有未归属行");
    const { seq, kind, createdAt, questionCount, activeSec } = previous;
    return attemptSettlementSchema.parse({
      seq,
      kind,
      createdAt,
      questionCount,
      activeSec,
    });
  }
  const seq = tx
    .select({ next: sql<number>`coalesce(max(${attemptSettlements.seq}),0)+1` })
    .from(attemptSettlements)
    .where(eq(attemptSettlements.attemptId, attemptId))
    .get()?.next;
  const fact = attemptSettlementSchema.parse({
    seq,
    kind: "final",
    createdAt: attempt.submittedAt,
    questionCount: remaining.length,
    activeSec: recordedActiveSecTotal(remaining),
  });
  tx.insert(attemptSettlements)
    .values({
      ...fact,
      id: randomUUID(),
      attemptId,
      // 旧接口无结算幂等键，服务端键只表示唯一 final；不改变 HTTP 重复交卷409。
      mutationId: "server-final-v1",
      requestDigest: createHash("sha256")
        .update(JSON.stringify(["server-final-v1", attemptId, remaining]))
        .digest("hex"),
    })
    .run();
  const assigned = tx
    .update(responses)
    .set({ settlementSeq: fact.seq })
    .where(
      and(eq(responses.attemptId, attemptId), isNull(responses.settlementSeq)),
    )
    .run().changes;
  if (assigned !== remaining.length) throw new Error("结算成员集合已变化");
  return fact;
}
