import { ne, or, sql } from "drizzle-orm";
import { assignments, attempts } from "../db/schema.ts";

/** 已收尾卷的查询条件，SQLite 函数与 TypeScript 共用截止和缺失策略。 */
export function releaseGateSql(nowIso: string) {
  return or(
    ne(attempts.sourceType, "assignment"),
    sql`ownclass_assignment_answers_released(${assignments.answerRelease}, ${assignments.dueAt}, ${nowIso}) = 1`,
  );
}
