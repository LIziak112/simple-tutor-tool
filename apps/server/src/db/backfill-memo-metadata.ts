import { memoAnchorSchema } from "@tutor/contract";
import { and, asc, eq, isNull, max } from "drizzle-orm";
import { ZodError } from "zod";
import { HttpError } from "../lib/http-error";
import { contextFromMemoAnchor } from "../services/memo-context";
import type { Db } from "./client";
import { dataMigrations, memos } from "./schema";

export const MEMO_METADATA_BACKFILL_KEY = "session_context_memo_metadata_v1";

/** 历史编号按创建时间稳定分配；包含软删记录，已分配的号永不回收或改写。 */
export function backfillMemoMetadata(db: Db, now = new Date()): void {
  if (
    db
      .select()
      .from(dataMigrations)
      .where(eq(dataMigrations.key, MEMO_METADATA_BACKFILL_KEY))
      .get() !== undefined
  )
    return;
  db.transaction(
    () => {
      const next = new Map<string, number>();
      for (const group of db
        .select({ studentId: memos.studentId, seq: max(memos.seq) })
        .from(memos)
        .groupBy(memos.studentId)
        .all())
        next.set(group.studentId, group.seq ?? 0);
      for (const row of db
        .select()
        .from(memos)
        .orderBy(asc(memos.studentId), asc(memos.createdAt), asc(memos.id))
        .all()) {
        if (row.seq === null) {
          const seq = (next.get(row.studentId) ?? 0) + 1;
          next.set(row.studentId, seq);
          db.update(memos)
            .set({ seq })
            .where(and(eq(memos.id, row.id), isNull(memos.seq)))
            .run();
        }
        if (row.contextJson !== null) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(row.anchorJson);
        } catch {
          continue;
        }
        const anchor = memoAnchorSchema.safeParse(raw);
        if (!anchor.success) continue;
        try {
          const context = contextFromMemoAnchor(
            db,
            row.studentId,
            anchor.data,
            now,
            true,
          );
          if (context !== null)
            db.update(memos)
              .set({ contextJson: JSON.stringify(context) })
              .where(eq(memos.id, row.id))
              .run();
        } catch (error) {
          // 失去来源、可见性或旧非UUID版本不可可靠恢复，保留旧锚和空上下文。
          if (!(error instanceof HttpError || error instanceof ZodError))
            throw error;
        }
      }
      db.insert(dataMigrations)
        .values({
          key: MEMO_METADATA_BACKFILL_KEY,
          appliedAt: now.toISOString(),
        })
        .run();
    },
    { behavior: "immediate" },
  );
}
