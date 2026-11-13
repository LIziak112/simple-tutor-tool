import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { questions, units } from "../db/schema.ts";

/** 向已存在的单元加题，保留原有题目与讲练题槽。 */
export function addLimitFixtureQuestions(
  db: Db,
  unitId: string,
  count: number,
): void {
  const unit = db
    .select({ teacherId: units.teacherId })
    .from(units)
    .where(eq(units.id, unitId))
    .get();
  if (!unit?.teacherId) throw new Error("缺少限额测试单元");
  const updatedAt = "2026-10-02T00:00:00.000Z";
  db.transaction((tx) => {
    for (let index = 0; index < count; index++) {
      tx.insert(questions)
        .values({
          id: `${unitId}-限额测试-${index}`,
          teacherId: unit.teacherId,
          unitId,
          order: 10 + index,
          type: "judge",
          difficulty: 1,
          stemMd: "一加一等于二。[[正确]]",
          answersJson: JSON.stringify({ kind: "judge", value: true }),
          hintsJson: "[]",
          sourceMd: "一加一等于二。[[正确]]",
          updatedAt,
        })
        .run();
    }
  });
}
