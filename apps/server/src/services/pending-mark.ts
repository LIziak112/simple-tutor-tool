import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, attempts, responses } from "../db/schema";
import {
  hasUsableQuestionSnapshotSql,
  needsTeacherMarkSql,
} from "./attempt-final-outcome.ts";
import { effectiveVerdictValueSql } from "./response-verdict.ts";

/** 单卷、批量、列表和结果汇总使用相同的行级待批与待自评条件。 */
export type PendingMarkAttempt = Pick<Attempt, "id" | "status">;

export const needsSelfReviewSql = and(
  eq(responses.gradingPolicy, "reference_self"),
  isNull(effectiveVerdictValueSql),
);

export const submittedActiveResponseSql = and(
  isNull(attempts.abandonedAt),
  or(ne(attempts.status, "draft"), isNotNull(responses.submittedAt)),
);

export const submittedTeacherPendingSql = and(
  submittedActiveResponseSql,
  needsTeacherMarkSql,
);

export const pendingTeacherResponseSql = and(
  submittedTeacherPendingSql,
  hasUsableQuestionSnapshotSql,
);

function pendingCountsByAttempt(
  db: Db,
  ids: readonly string[],
  condition: SQL | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  for (let start = 0; start < ids.length; start += 500) {
    for (const row of db
      .select({ attemptId: responses.attemptId, n: sql<number>`count(*)` })
      .from(responses)
      .innerJoin(attempts, eq(responses.attemptId, attempts.id))
      .where(
        and(
          inArray(responses.attemptId, ids.slice(start, start + 500)),
          condition,
        ),
      )
      .groupBy(responses.attemptId)
      .all()) {
      map.set(row.attemptId, row.n);
    }
  }
  return map;
}

export function pendingMarkCount(db: Db, attempt: PendingMarkAttempt): number {
  return (
    pendingCountsByAttempt(db, [attempt.id], pendingTeacherResponseSql).get(
      attempt.id,
    ) ?? 0
  );
}

export function pendingMarkCounts(db: Db, rows: readonly PendingMarkAttempt[]) {
  return pendingCountsByAttempt(
    db,
    rows.map((row) => row.id),
    pendingTeacherResponseSql,
  );
}

export function pendingSelfReviewCounts(
  db: Db,
  rows: readonly PendingMarkAttempt[],
) {
  return pendingCountsByAttempt(
    db,
    rows.map((row) => row.id),
    and(
      submittedActiveResponseSql,
      needsSelfReviewSql,
      hasUsableQuestionSnapshotSql,
    ),
  );
}

/**
 * v1 逐题卷「进行中进度」批量计数（M4-D3 §13）：attemptId → 行级已提交数 /
 * 本卷总行数（分组查询，500 id 一块，与 pendingMarkCounts 同款模式）。
 * - 调用方传**已按协议过滤的 v1 行**（协议判定统一走 practiceProtocolOf 单一
 *   谓词，本函数不重复协议分支）；传 legacy/lesson 行则按行级事实如实计数，
 *   不会报错（语义兜底：非 draft 收敛整卷口径）。
 * - 已收尾卷收敛为整卷口径（status ≠ draft ⇒ submitted = total）：正常
 *   整卷收尾本就对逐题语义卷的全部判分行写行级 submittedAt=交卷时刻
 *   （attempt-service 整卷收尾的 rowSubmittedAtPatch，lesson 与 v1 同款），
 *   行值已齐全；此处收敛是**防御性口径**——语义上「已收尾 = n/N 同为 N」
 *   恒成立，不依赖整卷收尾的写入事实，勿据「行值本就齐全」删掉收敛分支。
 * - 白名单纯公开进度计数：只读 submittedAt 与行数，绝不含对错/得分/答案列。
 * 结果 Map 只含有行命中的 attempt；零行卷（异常空卷）不出现，调用方按需回落。
 */
export function practiceSubmittedCounts(
  db: Db,
  attempts: readonly PendingMarkAttempt[],
): Map<string, { submitted: number; total: number }> {
  const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const map = new Map<string, { submitted: number; total: number }>();
  const ids = [...byId.keys()];
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    for (const row of db
      .select({
        attemptId: responses.attemptId,
        total: sql<number>`count(*)`,
        submitted: sql<number>`sum(case when ${responses.submittedAt} is not null then 1 else 0 end)`,
      })
      .from(responses)
      .where(inArray(responses.attemptId, chunk))
      .groupBy(responses.attemptId)
      .all()) {
      const attempt = byId.get(row.attemptId);
      if (attempt === undefined) continue;
      const total = Number(row.total);
      map.set(row.attemptId, {
        submitted: attempt.status === "draft" ? Number(row.submitted) : total,
        total,
      });
    }
  }
  return map;
}

/**
 * 按学生聚合的待批数（T-PR4 Web-4 学生列表「待批」列数据源）。与
 * pendingMarkCounts 的两批查询同一口径（公共条件 pendingMarkBaseConditions ×
 * draft/非 draft 的并集：非 draft 整卷恒「已交」，draft 批次只数行级已提交），
 * join attempts 后按 attempts.studentId 聚合；学生域筛选由调用方传本人名下
 * 学生 id；作废卷排除（与作答列表的 abandonedAt 口径一致）。
 * 结果 Map 只含有命中的学生；无待批行的学生不出现（调用方 `map.get(id) ?? 0`）。
 */
export function pendingMarkCountsByStudent(
  db: Db,
  studentIds: readonly string[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (studentIds.length === 0) return map;
  for (const row of db
    .select({ studentId: attempts.studentId, n: sql<number>`count(*)` })
    .from(responses)
    .innerJoin(attempts, eq(responses.attemptId, attempts.id))
    .where(
      and(
        inArray(attempts.studentId, [...studentIds]),
        pendingTeacherResponseSql,
      ),
    )
    .groupBy(attempts.studentId)
    .all()) {
    map.set(row.studentId, row.n);
  }
  return map;
}
