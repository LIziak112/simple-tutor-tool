import {
  finalCorrectOf,
  gradingPolicySchema,
  resolveRowGradingPolicy,
} from "@tutor/contract";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
} from "drizzle-orm";
import { teacherMarkOf } from "../services/response-verdict.ts";
import { snapshotOfRow } from "../services/snapshot.ts";
import {
  outcomeRowsOf,
  rescoreFinalizedAttempt,
} from "./backfill-attempt-outcomes.ts";
import type { Db } from "./client.ts";
import {
  attempts,
  dataMigrations,
  responses,
  students,
  teachers,
} from "./schema.ts";

const KEY = "default_grading_policy_v1";

/**
 * 空判分策略回填（TASK-f9439bfd，主人定案 A：旧卷判定作废并重算分）：
 * - 空值或非法值行按冻结快照回落默认策略（resolveRowGradingPolicy，与新开卷
 *   同一规则，学生所属教师当前的自评开关决定 reference_self / manual_only）；
 * - 新策略非 auto 的行清掉旧语义留下的 autoCorrect，finalCorrect 按
 *   teacherMark ?? autoCorrect 重算——教师判定保留；
 * - 受影响的已收尾卷经 rescoreFinalizedAttempt（交卷/批改同一口径）重算
 *   status / scoreFinal / scoreAuto；
 * - 无可用快照的行（升级遗留幽灵行）无从推导策略，保持空值：判分与计分
 *   本就跳过这些行。
 * 幂等：完成标记与数据改动同事务落库，已标记即跳过。
 */
export function backfillDefaultGradingPolicy(db: Db, now: Date): void {
  const applied = () =>
    db
      .select({ key: dataMigrations.key })
      .from(dataMigrations)
      .where(eq(dataMigrations.key, KEY))
      .get() !== undefined;
  if (applied()) return;
  db.transaction(
    (tx) => {
      if (applied()) return;
      const selfReviewByStudent = new Map<string, boolean>();
      const selfReviewOf = (studentId: string): boolean => {
        const cached = selfReviewByStudent.get(studentId);
        if (cached !== undefined) return cached;
        const enabled =
          tx
            .select({ enabled: teachers.studentSelfReviewEnabled })
            .from(students)
            .innerJoin(teachers, eq(teachers.id, students.teacherId))
            .where(eq(students.id, studentId))
            .get()?.enabled === true;
        selfReviewByStudent.set(studentId, enabled);
        return enabled;
      };
      const touched = new Set<string>();
      let afterId = "";
      for (;;) {
        const rows = tx
          .select({ row: responses, studentId: attempts.studentId })
          .from(responses)
          .innerJoin(attempts, eq(attempts.id, responses.attemptId))
          .where(
            and(
              or(
                isNull(responses.gradingPolicy),
                notInArray(
                  responses.gradingPolicy,
                  gradingPolicySchema.options,
                ),
              ),
              gt(responses.id, afterId),
            ),
          )
          .orderBy(asc(responses.id))
          .limit(500)
          .all();
        if (rows.length === 0) break;
        for (const { row, studentId } of rows) {
          afterId = row.id;
          const snapshot = snapshotOfRow(row);
          if (snapshot === null) continue;
          const gradingPolicy = resolveRowGradingPolicy(
            row.gradingPolicy,
            snapshot,
            selfReviewOf(studentId),
          );
          const autoCorrect = gradingPolicy === "auto" ? row.autoCorrect : null;
          tx.update(responses)
            .set({
              gradingPolicy,
              autoCorrect,
              finalCorrect: finalCorrectOf(
                teacherMarkOf(row.teacherMark),
                autoCorrect,
              ),
            })
            .where(eq(responses.id, row.id))
            .run();
          touched.add(row.attemptId);
        }
      }
      for (const attemptId of [...touched].sort()) {
        const candidate = tx
          .select({
            id: attempts.id,
            status: attempts.status,
            scoreAuto: attempts.scoreAuto,
            scoreFinal: attempts.scoreFinal,
          })
          .from(attempts)
          .where(
            and(
              eq(attempts.id, attemptId),
              inArray(attempts.status, ["submitted", "graded"]),
              isNull(attempts.abandonedAt),
              isNotNull(attempts.submittedAt),
            ),
          )
          .get();
        if (candidate === undefined) continue;
        // 幽灵行（无可用快照）不计入，与交卷重算同口径
        const group = outcomeRowsOf(tx, attemptId).filter(
          (row) => row.hasSnapshot,
        );
        if (group.length > 0) rescoreFinalizedAttempt(tx, candidate, group);
      }
      tx.insert(dataMigrations)
        .values({ key: KEY, appliedAt: now.toISOString() })
        .run();
    },
    { behavior: "immediate" },
  );
}
