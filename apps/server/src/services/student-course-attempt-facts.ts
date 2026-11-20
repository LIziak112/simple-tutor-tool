import {
  isRecordableAttempt,
  type StudentUnitAttemptSummary,
} from "@tutor/contract";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  or,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts } from "../db/schema.ts";
import {
  kernelCourseOpenings,
  kernelQuestionDeliveries,
} from "../db/schema-kernel-question-delivery.ts";
import { recordableAttemptWhere } from "./attempt-recordability.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery-recovery.ts";
import { pendingMarkCounts } from "./pending-mark.ts";
import {
  attemptResultCounts,
  attemptResultCountsOfRows,
  resultCountsSummary,
} from "./result-counts.ts";

/** 调用方已校验课程成员和单元可见性。完成态及可补投影确认以题组回执为准。 */
export function readCourseAttemptFacts(
  db: Db,
  studentId: string,
  courseId: string,
  unitIds: readonly string[],
  dataDir?: string,
) {
  return db.transaction(
    () => {
      const hasDelivery = exists(
        db
          .select({ id: kernelQuestionDeliveries.attemptId })
          .from(kernelQuestionDeliveries)
          .where(eq(kernelQuestionDeliveries.attemptId, attempts.id)),
      );
      const candidates =
        unitIds.length === 0
          ? []
          : db
              .select({
                attempt: attempts,
                bound: kernelCourseOpenings.attemptId,
                hasDelivery,
              })
              .from(attempts)
              .leftJoin(
                kernelCourseOpenings,
                eq(kernelCourseOpenings.attemptId, attempts.id),
              )
              .where(
                and(
                  eq(attempts.studentId, studentId),
                  eq(attempts.sourceType, "course"),
                  eq(attempts.courseId, courseId),
                  inArray(attempts.unitId, unitIds),
                  isNull(attempts.abandonedAt),
                  or(
                    recordableAttemptWhere(),
                    dataDir === undefined
                      ? undefined
                      : and(
                          isNotNull(kernelCourseOpenings.attemptId),
                          hasDelivery,
                        ),
                  ),
                ),
              )
              .orderBy(asc(attempts.attemptNo))
              .all();

      const rows: Attempt[] = [];
      const legacyRows: Attempt[] = [];
      const kernelCounts = new Map<
        string,
        ReturnType<typeof attemptResultCountsOfRows>
      >();
      for (const { attempt, bound, hasDelivery } of candidates) {
        if (dataDir === undefined || bound === null) {
          rows.push(attempt);
          legacyRows.push(attempt);
          continue;
        }
        if (attempt.status === "draft" && !hasDelivery) {
          rows.push(attempt);
          continue;
        }
        const facts = readQuestionDeliveryFacts(db, dataDir, attempt);
        if (!facts) kernelAttemptUnavailable();
        if (isRecordableAttempt(facts.attempt)) rows.push(facts.attempt);
        if (facts.attempt.status !== "draft")
          kernelCounts.set(attempt.id, attemptResultCountsOfRows(facts.rows));
      }

      const resultCounts = attemptResultCounts(db, legacyRows);
      const pendingByAttempt = pendingMarkCounts(db, legacyRows);
      for (const [id, counts] of kernelCounts) {
        resultCounts.set(id, counts);
        pendingByAttempt.set(id, counts.pendingCount);
      }
      return { rows, resultCounts, pendingByAttempt };
    },
    { behavior: "immediate" },
  );
}

export function courseUnitAttemptSummaries({
  rows,
  resultCounts,
  pendingByAttempt,
}: ReturnType<typeof readCourseAttemptFacts>): Map<
  string,
  StudentUnitAttemptSummary
> {
  interface CellState extends StudentUnitAttemptSummary {
    firstSubmittedSeen: boolean;
    attemptIds: string[];
  }
  const byUnit = new Map<string, CellState>();
  for (const row of rows) {
    const unitId = row.unitId ?? "";
    const cell =
      byUnit.get(unitId) ??
      ({
        count: 0,
        submittedCount: 0,
        hasDraft: false,
        firstScore: null,
        latestScore: null,
        bestScore: null,
        pendingCount: 0,
        firstSubmittedSeen: false,
        attemptIds: [],
      } satisfies CellState);
    cell.attemptIds.push(row.id);
    cell.count += 1;
    cell.pendingCount += pendingByAttempt.get(row.id) ?? 0;
    const score = row.scoreFinal ?? row.scoreAuto;
    if (row.status === "draft") {
      cell.hasDraft = true;
    } else {
      cell.submittedCount += 1;
      // attemptNo 升序遍历：首个交卷即首次得分（无可判分保持 null），
      // 最后一个交卷即最近得分；最高分取非空得分的最大值（教师侧统计优先用首次分）
      if (!cell.firstSubmittedSeen) {
        cell.firstSubmittedSeen = true;
        cell.firstScore = score;
      }
      cell.latestScore = score;
      if (score !== null) {
        cell.bestScore = Math.max(cell.bestScore ?? 0, score);
      }
    }
    byUnit.set(unitId, cell);
  }

  const result = new Map<string, StudentUnitAttemptSummary>();
  for (const [unitId, cell] of byUnit) {
    const { firstSubmittedSeen: _omit, attemptIds, ...summary } = cell;
    result.set(unitId, {
      ...summary,
      ...resultCountsSummary(attemptIds, resultCounts),
    });
  }
  return result;
}
