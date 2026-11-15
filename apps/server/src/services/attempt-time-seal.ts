import { createHash } from "node:crypto";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import {
  attemptEventReceipts,
  attemptTimeProfiles,
  attemptTimeSpans,
  responseTimeLedger,
} from "../db/attempt-time-schema";
import type { Db } from "../db/client";
import { events, responses } from "../db/schema";
import { allocateTimeSpans } from "./attempt-time-attribution";
import { timeEvidenceSessions } from "./attempt-time-evidence";
import { replaySession, type Tally } from "./question-activity-replay";

/** 只能在真实提交的 immediate 事务内调用；多题必须一次传入，重放不新增水位。 */
export function sealResponseTimeWithin(
  db: Db,
  attemptId: string,
  responseIds: readonly string[],
  sealedAt: string,
): void {
  if (!db.$client.inTransaction) throw new Error("活动封存必须位于提交事务内");
  if (
    !db
      .select()
      .from(attemptTimeProfiles)
      .where(eq(attemptTimeProfiles.attemptId, attemptId))
      .get()
  )
    return;
  const members = db
    .select({ id: responses.id, questionId: responses.questionId })
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all();
  const previous = db
    .select()
    .from(responseTimeLedger)
    .where(eq(responseTimeLedger.attemptId, attemptId))
    .all();
  const sealed = new Set(previous.map((r) => r.responseId));
  const targets = members
    .filter((r) => responseIds.includes(r.id) && !sealed.has(r.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!targets.length) return;
  if (responseIds.some((id) => !members.some((r) => r.id === id)))
    throw new Error("封存成员不属于本卷");
  const boundary = db
    .insert(attemptEventReceipts)
    .values({
      attemptId,
      eventId: null,
      origin: "server",
      kind: "seal",
      receivedAt: sealedAt,
    })
    .returning()
    .get();
  const rows = db
    .select({
      seq: attemptEventReceipts.seq,
      origin: attemptEventReceipts.origin,
      type: events.type,
      questionId: events.questionId,
      clientTs: events.clientTs,
      viewId: sql<
        string | null
      >`json_extract(${events.payloadJson}, '$.viewId')`,
    })
    .from(attemptEventReceipts)
    .innerJoin(events, eq(events.id, attemptEventReceipts.eventId))
    .where(
      and(
        eq(attemptEventReceipts.attemptId, attemptId),
        lt(attemptEventReceipts.seq, boundary.seq),
      ),
    )
    .orderBy(asc(attemptEventReceipts.seq))
    .all();
  const { sessions, badQuestions, badGlobal } = timeEvidenceSessions(
    rows,
    new Set(members.map((r) => r.questionId)),
    targets.map((r) => r.questionId),
  );
  const tallies = new Map<string, Tally>();
  const segments = [...sessions].flatMap(([session, list]) =>
    replaySession(session, list, tallies),
  );
  const sealedQuestions = new Set(
    members.filter((r) => sealed.has(r.id)).map((r) => r.questionId),
  );
  const occupied = db
    .select({ start: attemptTimeSpans.start, end: attemptTimeSpans.end })
    .from(attemptTimeSpans)
    .where(eq(attemptTimeSpans.attemptId, attemptId))
    .orderBy(asc(attemptTimeSpans.start))
    .all();
  const allocated = allocateTimeSpans(
    segments.filter(
      (s) =>
        !sealedQuestions.has(s.questionId) &&
        !badGlobal &&
        !badQuestions.has(s.questionId),
    ),
    new Set(targets.map((r) => r.questionId)),
    occupied,
  );
  const digest = createHash("sha256")
    .update(JSON.stringify([1, targets, rows]))
    .digest("hex");
  for (const target of targets) {
    const tally = tallies.get(target.questionId);
    const reason =
      badGlobal || badQuestions.has(target.questionId)
        ? ("clock_invalid" as const)
        : !tally
          ? ("no_client_evidence" as const)
          : null;
    const spans = allocated.filter((s) => s.questionId === target.questionId);
    const ms = (kind: string) =>
      spans
        .filter((s) => s.kind === kind)
        .reduce((sum, s) => sum + s.end - s.start, 0);
    const activeMs = reason ? null : ms("active"),
      observedMs = reason ? null : ms("observed");
    db.insert(responseTimeLedger)
      .values({
        responseId: target.id,
        attemptId,
        version: 1,
        state: reason ? "unknown" : "available",
        reason,
        activeMs,
        observedMs,
        activeSec: activeMs === null ? null : Math.round(activeMs / 1000),
        observedSec: observedMs === null ? null : Math.round(observedMs / 1000),
        actions: tally?.actions ?? 0,
        viewed: tally?.viewed ?? false,
        boundarySeq: boundary.seq,
        sealedAt,
        inputDigest: digest,
      })
      .run();
  }
  const ids = new Map(targets.map((r) => [r.questionId, r.id]));
  for (const span of allocated) {
    const owner =
      span.questionId === null ? null : (ids.get(span.questionId) ?? null);
    db.insert(attemptTimeSpans)
      .values({
        attemptId,
        sealResponseId: owner ?? (targets[0] as { id: string }).id,
        ownerResponseId: owner,
        kind: span.kind,
        start: span.start,
        end: span.end,
      })
      .run();
  }
}
