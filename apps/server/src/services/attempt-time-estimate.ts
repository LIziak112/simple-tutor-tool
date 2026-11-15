import { asc, eq, sql } from "drizzle-orm";
import {
  attemptEventReceipts,
  attemptTimeSpans,
} from "../db/attempt-time-schema";
import type { Db } from "../db/client";
import { events } from "../db/schema";
import { allocateTimeSpans } from "./attempt-time-attribution";
import { timeEvidenceSessions } from "./attempt-time-evidence";
import { timeProjectionsOf } from "./attempt-time-projection";
import { replaySession, type Tally } from "./question-activity-replay";
/** 实时前缀复用相同回放/首封存占用规则，不延伸服务器 now，不把回看加回旧题。 */
export function attemptTimeEstimateOf(db: Db, attemptId: string) {
  const projection = timeProjectionsOf(db, [attemptId]);
  if (!projection.profiles.has(attemptId)) return undefined;
  const rows = db
    .select({
      seq: attemptEventReceipts.seq,
      type: events.type,
      clientTs: events.clientTs,
      questionId: events.questionId,
      viewId: sql<
        string | null
      >`json_extract(${events.payloadJson}, '$.viewId')`,
      origin: attemptEventReceipts.origin,
    })
    .from(attemptEventReceipts)
    .innerJoin(events, eq(events.id, attemptEventReceipts.eventId))
    .where(eq(attemptEventReceipts.attemptId, attemptId))
    .orderBy(asc(events.clientTs), asc(attemptEventReceipts.seq))
    .all();
  const members = projection.members;
  const valid = new Set(members.map((r) => r.questionId));
  const pending = new Set(
    members.filter((r) => !r.submittedAt).map((r) => r.questionId),
  );
  const { sessions, badQuestions, badGlobal } = timeEvidenceSessions(
    rows,
    valid,
  );
  const tallies = new Map<string, Tally>();
  const segments = [...sessions]
    .flatMap(([view, list]) => replaySession(view, list, tallies))
    .filter(
      (s) =>
        pending.has(s.questionId) &&
        !badGlobal &&
        !badQuestions.has(s.questionId),
    );
  const occupied = db
    .select({ start: attemptTimeSpans.start, end: attemptTimeSpans.end })
    .from(attemptTimeSpans)
    .where(eq(attemptTimeSpans.attemptId, attemptId))
    .all();
  const spans = allocateTimeSpans(segments, pending, occupied);
  const byQuestion = new Map<string, number>();
  for (const span of spans)
    if (span.kind === "active" && span.questionId)
      byQuestion.set(
        span.questionId,
        (byQuestion.get(span.questionId) ?? 0) + span.end - span.start,
      );
  const sealed = projection.aggregate(attemptId);
  return {
    metric: "question_activity_estimate" as const,
    version: 1 as const,
    activeSecTotal:
      (sealed.metric === "question_activity_sealed"
        ? sealed.knownActiveSec
        : 0) +
      [...byQuestion.values()].reduce((a, ms) => a + Math.round(ms / 1000), 0),
  };
}
