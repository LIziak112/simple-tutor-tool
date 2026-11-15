import {
  type AttemptTime,
  aggregateSealedTime,
  type ResponseTime,
  type SealedQuestionTime,
} from "@tutor/contract";
import { and, eq, inArray, lte } from "drizzle-orm";
import {
  attemptTimeProfiles,
  responseTimeLedger,
} from "../db/attempt-time-schema";
import type { Db } from "../db/client";
import { attemptSettlements, attempts, responses } from "../db/schema";
import { chunk } from "../lib/chunk";

type LedgerRow = typeof responseTimeLedger.$inferSelect;
export function sealedTimeValue(
  row: LedgerRow | undefined,
): SealedQuestionTime {
  if (!row)
    return {
      state: "unknown",
      reason: "ledger_missing",
      activeSec: null,
      observedSec: null,
    };
  if (row.state === "unknown")
    return {
      state: "unknown",
      reason: row.reason ?? "ledger_missing",
      activeSec: null,
      observedSec: null,
    };
  if (row.activeSec === null || row.observedSec === null)
    throw new Error("活动账缺少可用秒数");
  return {
    state: "available",
    activeSec: row.activeSec,
    observedSec: row.observedSec,
    actions: row.actions,
    viewed: row.viewed,
  };
}
/** 批量投影不回放事件。asOf 只读当时已封存事实，不穿越快照。 */
export function timeProjectionsOf(
  db: Pick<Db, "select">,
  attemptIds: readonly string[],
  asOf?: string,
) {
  const groups = chunk([...new Set(attemptIds)]);
  const profiles = new Set(
    groups.flatMap((ids) =>
      db
        .select()
        .from(attemptTimeProfiles)
        .where(inArray(attemptTimeProfiles.attemptId, ids))
        .all()
        .map((r) => r.attemptId),
    ),
  );
  const ledger = new Map(
    groups.flatMap((ids) =>
      db
        .select()
        .from(responseTimeLedger)
        .where(
          and(
            inArray(responseTimeLedger.attemptId, ids),
            asOf ? lte(responseTimeLedger.sealedAt, asOf) : undefined,
          ),
        )
        .all()
        .map((r) => [r.responseId, r] as const),
    ),
  );
  const members = groups.flatMap((ids) =>
    db
      .select({
        id: responses.id,
        attemptId: responses.attemptId,
        questionId: responses.questionId,
        activeSec: responses.activeSec,
        submittedAt: responses.submittedAt,
        settlementSeq: responses.settlementSeq,
      })
      .from(responses)
      .where(inArray(responses.attemptId, ids))
      .all(),
  );
  const responseTime = new Map<string, ResponseTime>();
  for (const row of members)
    responseTime.set(
      row.id,
      profiles.has(row.attemptId)
        ? {
            metric: "question_activity_sealed",
            version: 1,
            value: sealedTimeValue(ledger.get(row.id)),
          }
        : { metric: "legacy_focus", version: null, activeSec: row.activeSec },
    );
  const legacyTotals = new Map(
    groups.flatMap((ids) =>
      db
        .select({ id: attempts.id, activeSec: attempts.activeSec })
        .from(attempts)
        .where(inArray(attempts.id, ids))
        .all()
        .map((r) => [r.id, r.activeSec] as const),
    ),
  );
  const legacySettlements = new Map(
    groups.flatMap((ids) =>
      db
        .select({
          attemptId: attemptSettlements.attemptId,
          seq: attemptSettlements.seq,
          activeSec: attemptSettlements.activeSec,
        })
        .from(attemptSettlements)
        .where(inArray(attemptSettlements.attemptId, ids))
        .all()
        .map(
          (r) => [JSON.stringify([r.attemptId, r.seq]), r.activeSec] as const,
        ),
    ),
  );
  const aggregate = (attemptId: string, seq?: number): AttemptTime => {
    const rows = members.filter(
      (r) =>
        r.attemptId === attemptId &&
        (seq === undefined || r.settlementSeq === seq) &&
        (!asOf ||
          ledger.has(r.id) ||
          (!!r.submittedAt && r.submittedAt <= asOf)),
    );
    if (profiles.has(attemptId))
      return aggregateSealedTime(
        rows.map((r) => sealedTimeValue(ledger.get(r.id))),
      );
    return {
      metric: "legacy_focus",
      version: null,
      activeSec:
        seq === undefined
          ? (legacyTotals.get(attemptId) ?? null)
          : (legacySettlements.get(JSON.stringify([attemptId, seq])) ?? null),
    };
  };
  return { aggregate, responseTime, members, profiles };
}
export function attemptTimeOf(
  db: Pick<Db, "select">,
  attemptId: string,
): AttemptTime {
  return timeProjectionsOf(db, [attemptId]).aggregate(attemptId);
}
export function responseTimeOf(
  db: Pick<Db, "select">,
  attemptId: string,
  responseId: string,
): ResponseTime {
  const row = db
    .select({ id: responses.id, activeSec: responses.activeSec })
    .from(responses)
    .where(
      and(eq(responses.id, responseId), eq(responses.attemptId, attemptId)),
    )
    .get();
  if (!row) throw new Error("计时题行不存在");
  const profile = db
    .select()
    .from(attemptTimeProfiles)
    .where(eq(attemptTimeProfiles.attemptId, attemptId))
    .get();
  if (!profile)
    return { metric: "legacy_focus", version: null, activeSec: row.activeSec };
  const ledger = db
    .select()
    .from(responseTimeLedger)
    .where(eq(responseTimeLedger.responseId, responseId))
    .get();
  return {
    metric: "question_activity_sealed",
    version: 1,
    value: sealedTimeValue(ledger),
  };
}
