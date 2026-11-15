import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts } from "../db/schema.ts";
import { activateAttempt } from "../services/attempt-activation.ts";

/** 列表/排序旧用例中的零答案卷代表已发生本机材料笔迹，显式激活后再断言。 */
export function activateTestAttempt(
  db: Db,
  attemptId: string,
  now?: string,
): void {
  const row = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  if (!row) throw new Error("待激活测试卷不存在");
  activateAttempt(
    db,
    row.studentId,
    attemptId,
    { expectedFrozenAt: row.frozenAt },
    now,
  );
}
