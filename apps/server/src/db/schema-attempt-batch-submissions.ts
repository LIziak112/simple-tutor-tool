import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { attempts } from "./schema.ts";

/** 每卷最多一组有效暂存，归属由 attempts.studentId 校验。 */
export const attemptBatchSubmissions = sqliteTable(
  "attempt_batch_submissions",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .unique()
      .references(() => attempts.id, { onDelete: "cascade" }),
    batchCount: integer("batch_count").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("attempt_batch_submissions_expires_idx").on(table.expiresAt),
  ],
);

export const attemptSubmissionBatches = sqliteTable(
  "attempt_submission_batches",
  {
    submissionId: text("submission_id")
      .notNull()
      .references(() => attemptBatchSubmissions.id, { onDelete: "cascade" }),
    batchIndex: integer("batch_index").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (table) => [primaryKey({ columns: [table.submissionId, table.batchIndex] })],
);
