import { finalCorrectOf, gradingPolicySchema } from "@tutor/contract";
import { and, asc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  attemptFinalOutcomeOf,
  hasUsableQuestionSnapshotSql,
  scoreAutoOf,
} from "../services/attempt-final-outcome.ts";
import { teacherMarkOf } from "../services/response-verdict.ts";
import type { Db } from "./client.ts";
import {
  attempts,
  dataMigrations,
  type ResponseRow,
  responses,
} from "./schema.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const KEY = "reconcile_attempt_outcomes_v1";

export type OutcomeSource = Pick<
  ResponseRow,
  | "gradingPolicy"
  | "submittedAt"
  | "teacherMark"
  | "autoCorrect"
  | "finalCorrect"
> & { hasSnapshot: boolean };

function hasTrustworthyGrading(row: OutcomeSource): boolean {
  const teacherMark = teacherMarkOf(row.teacherMark);
  return (
    row.hasSnapshot &&
    gradingPolicySchema.safeParse(row.gradingPolicy).success &&
    (row.teacherMark === null || teacherMark !== null) &&
    ((row.gradingPolicy !== "reference_self" &&
      row.gradingPolicy !== "manual_only") ||
      row.autoCorrect === null) &&
    row.finalCorrect === finalCorrectOf(teacherMark, row.autoCorrect)
  );
}

export interface OutcomeCandidate {
  readonly id: string;
  readonly status: string;
  readonly scoreAuto: number | null;
  readonly scoreFinal: number | null;
}

/** 卷级派生状态与分数的判分行读取（重算单一入口的输入）。 */
export function outcomeRowsOf(tx: Tx, attemptId: string): OutcomeSource[] {
  return tx
    .select({
      hasSnapshot: hasUsableQuestionSnapshotSql.mapWith(Boolean),
      gradingPolicy: responses.gradingPolicy,
      submittedAt: responses.submittedAt,
      teacherMark: responses.teacherMark,
      autoCorrect: responses.autoCorrect,
      finalCorrect: responses.finalCorrect,
    })
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all();
}

/**
 * 已收尾卷按行内判分事实重算 status / scoreFinal / scoreAuto（与交卷、批改
 * 同一口径 attemptFinalOutcomeOf + scoreAutoOf），有变化才写。
 */
export function rescoreFinalizedAttempt(
  tx: Tx,
  candidate: OutcomeCandidate,
  group: readonly OutcomeSource[],
): void {
  const outcome = attemptFinalOutcomeOf(group, { finalized: true });
  const scoreAuto = scoreAutoOf(group);
  if (
    outcome.status === candidate.status &&
    outcome.scoreFinal === candidate.scoreFinal &&
    scoreAuto === candidate.scoreAuto
  )
    return;
  tx.update(attempts)
    .set({ ...outcome, scoreAuto })
    .where(eq(attempts.id, candidate.id))
    .run();
}

/** 仅重算已收尾、冻结完整且判分来源可核实的卷级派生状态和分数。 */
export function backfillAttemptOutcomes(db: Db, now: Date): void {
  if (
    db
      .select({ key: dataMigrations.key })
      .from(dataMigrations)
      .where(eq(dataMigrations.key, KEY))
      .get()
  )
    return;
  db.transaction(
    (tx) => {
      if (
        tx
          .select({ key: dataMigrations.key })
          .from(dataMigrations)
          .where(eq(dataMigrations.key, KEY))
          .get()
      )
        return;
      let afterId = "";
      for (;;) {
        const candidates = tx
          .select({
            id: attempts.id,
            status: attempts.status,
            scoreAuto: attempts.scoreAuto,
            scoreFinal: attempts.scoreFinal,
          })
          .from(attempts)
          .where(
            and(
              inArray(attempts.status, ["submitted", "graded"]),
              isNull(attempts.abandonedAt),
              eq(attempts.legacyUnverified, false),
              isNotNull(attempts.frozenAt),
              isNotNull(attempts.submittedAt),
              gt(attempts.id, afterId),
            ),
          )
          .orderBy(asc(attempts.id))
          .limit(200)
          .all();
        if (candidates.length === 0) break;
        for (const candidate of candidates) {
          afterId = candidate.id;
          const group = outcomeRowsOf(tx, candidate.id);
          if (group.length === 0 || !group.every(hasTrustworthyGrading))
            continue;
          rescoreFinalizedAttempt(tx, candidate, group);
        }
      }
      tx.insert(dataMigrations)
        .values({ key: KEY, appliedAt: now.toISOString() })
        .run();
    },
    { behavior: "immediate" },
  );
}
