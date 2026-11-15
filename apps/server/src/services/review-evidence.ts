import { memoAnchorSchema } from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { ink, memos, notes } from "../db/schema.ts";
import { readFrozenAttemptContext } from "./attempt-context.ts";
/** 批量读取回看证据；教师不接收本人私有随笔序号。 */
export function reviewEvidenceReader(
  db: Db,
  attemptId: string,
  studentId?: string,
) {
  const inkRows = db
    .select({ questionId: ink.questionId, count: ink.strokeCount })
    .from(ink)
    .where(eq(ink.attemptId, attemptId))
    .all();
  const noteRows = db
    .select({ questionId: notes.questionId })
    .from(notes)
    .where(and(eq(notes.attemptId, attemptId), eq(notes.phase, "scratch")))
    .all();
  const sequences = new Map<string, number[]>();
  if (studentId !== undefined)
    for (const memo of db
      .select({ seq: memos.seq, anchor: memos.anchorJson })
      .from(memos)
      .where(
        and(
          eq(memos.studentId, studentId),
          eq(memos.anchorAttemptId, attemptId),
          isNull(memos.deletedAt),
        ),
      )
      .all()) {
      try {
        const anchor = memoAnchorSchema.safeParse(JSON.parse(memo.anchor));
        if (
          anchor.success &&
          anchor.data.kind === "question" &&
          memo.seq !== null
        ) {
          const ids = sequences.get(anchor.data.questionId) ?? [];
          ids.push(memo.seq);
          sequences.set(anchor.data.questionId, ids);
        }
      } catch {
        /* 坏旧锚不猜关联。 */
      }
    }
  const { data } = readFrozenAttemptContext(db, attemptId);
  return (questionId: string, ownMaterialIds: readonly string[]) => ({
    hasHandwriting: inkRows.some(
      (r) => r.questionId === questionId && r.count > 0,
    ),
    hasScratch: noteRows.some((r) => r.questionId === questionId),
    memoSequences:
      studentId === undefined
        ? null
        : (sequences.get(questionId) ?? []).sort((a, b) => a - b),
    materialIds: [
      ...new Set([
        ...ownMaterialIds,
        ...data.groups
          .filter((g) => g.questionIds.includes(questionId))
          .flatMap((g) => g.materialRefs.map((r) => r.material)),
      ]),
    ],
  });
}
