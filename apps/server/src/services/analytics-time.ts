import type { ResponseTime } from "@tutor/contract";
import { eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, responses, students } from "../db/schema";
import { timeProjectionsOf } from "./attempt-time-projection";
export function timeSeconds(time: ResponseTime | undefined): number | null {
  return time?.metric === "question_activity_sealed"
    ? time.value.activeSec
    : (time?.activeSec ?? null);
}
export function timeCohort(time: ResponseTime | undefined): string {
  return time?.metric === "question_activity_sealed"
    ? "question_activity_sealed:1"
    : "legacy_focus";
}
export function medianTime(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  return n === 0
    ? null
    : n % 2
      ? (sorted[Math.floor(n / 2)] ?? null)
      : ((sorted[n / 2 - 1] ?? 0) + (sorted[n / 2] ?? 0)) / 2;
}
/** 域内基准严格按指标/版本隔离；仅读取最小计时元信息。 */
export function analyticsTimesOf(db: Db, teacherId: string) {
  const rows = db
    .select({
      id: responses.id,
      questionId: responses.questionId,
      attemptId: responses.attemptId,
    })
    .from(responses)
    .innerJoin(attempts, eq(attempts.id, responses.attemptId))
    .innerJoin(students, eq(students.id, attempts.studentId))
    .where(eq(students.teacherId, teacherId))
    .all();
  const times = timeProjectionsOf(db, [
    ...new Set(rows.map((r) => r.attemptId)),
  ]);
  const completed = new Set(
    db
      .select({ id: attempts.id })
      .from(attempts)
      .where(ne(attempts.status, "draft"))
      .all()
      .map((a) => a.id),
  );
  const groups = new Map<string, number[]>();
  for (const row of rows)
    if (completed.has(row.attemptId)) {
      const time = times.responseTime.get(row.id),
        sec = timeSeconds(time);
      const key = JSON.stringify([row.questionId, timeCohort(time)]);
      if (sec !== null) {
        const list = groups.get(key) ?? [];
        list.push(sec);
        groups.set(key, list);
      }
    }
  return {
    responseTime: times.responseTime,
    median: (questionId: string, time: ResponseTime | undefined) =>
      medianTime(
        groups.get(JSON.stringify([questionId, timeCohort(time)])) ?? [],
      ),
  };
}
export function timeCohortStats(times: readonly (ResponseTime | undefined)[]) {
  return (["legacy_focus", "question_activity_sealed:1"] as const).flatMap(
    (key) => {
      const members = times.filter((t) => timeCohort(t) === key);
      if (!members.length) return [];
      const values = members
        .map(timeSeconds)
        .filter((s): s is number => s !== null);
      return [
        {
          metric:
            key === "legacy_focus"
              ? ("legacy_focus" as const)
              : ("question_activity_sealed" as const),
          version: key === "legacy_focus" ? null : (1 as const),
          knownCount: values.length,
          unknownCount: members.length - values.length,
          avgSec: values.length
            ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
            : null,
          medianSec: medianTime(values),
        },
      ];
    },
  );
}
