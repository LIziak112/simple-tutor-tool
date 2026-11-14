import { attemptSettlementProgressSchema } from "@tutor/contract";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Attempt, attemptSettlements } from "../db/schema.ts";
import { frozenRowsInDisplayOrder } from "./attempt-rows.ts";
export function studentSettlementProgress(db: Db, attempt: Attempt) {
  const rows = frozenRowsInDisplayOrder(db, attempt).map((entry) => entry.row);
  const settlements = db
    .select({
      seq: attemptSettlements.seq,
      kind: attemptSettlements.kind,
      createdAt: attemptSettlements.createdAt,
      questionCount: attemptSettlements.questionCount,
      activeSec: attemptSettlements.activeSec,
    })
    .from(attemptSettlements)
    .where(eq(attemptSettlements.attemptId, attempt.id))
    .orderBy(asc(attemptSettlements.seq))
    .all();
  return attemptSettlementProgressSchema.parse({
    settlements,
    nextQuestionId:
      rows.find((row) => row.submittedAt === null)?.questionId ?? null,
    membership: Object.fromEntries(
      rows
        .filter((row) => row.settlementSeq !== null)
        .map((row) => [row.questionId, row.settlementSeq]),
    ),
  });
}
