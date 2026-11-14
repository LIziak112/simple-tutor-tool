import { questionRevisionIdSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { responses } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { questionSnapshotOf } from "./snapshot.ts";
export function incompleteFrozenAttempt(): never {
  throw new HttpError(
    409,
    "ATTEMPT_CONTEXT_BROKEN",
    "这份练习的冻结题目数据不完整，请联系老师检查",
  );
}
export function frozenMemberRefs(
  db: Db,
  attemptId: string,
): ReadonlyMap<string, string> {
  const rows = db
    .select({
      id: responses.id,
      questionId: responses.questionId,
      snapshot: responses.questionSnapshotJson,
    })
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all();
  const revisions = new Map<string, string>();
  for (const row of rows) {
    const snapshot =
      row.snapshot === null ? null : questionSnapshotOf(row.snapshot);
    if (
      snapshot === null ||
      snapshot.id !== row.questionId ||
      revisions.has(row.questionId) ||
      !questionRevisionIdSchema.safeParse(row.id).success
    )
      incompleteFrozenAttempt();
    revisions.set(row.questionId, row.id);
  }
  return revisions;
}
