import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { attempts } from "./schema.ts";

/** 单题过程与当前稿独立。删除记录后保留授权行直到到期，拒绝迟到批次。 */
export const questionProcessRecordings = sqliteTable(
  "question_process_recordings",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .unique()
      .references(() => attempts.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [index("question_process_expires_idx").on(table.expiresAt)],
);

export const questionProcessBatches = sqliteTable(
  "question_process_batches",
  {
    recordingId: text("recording_id")
      .notNull()
      .references(() => questionProcessRecordings.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    segmentId: text("segment_id").notNull(),
    firstSeq: integer("first_seq").notNull(),
    lastSeq: integer("last_seq").notNull(),
    payload: text("payload").notNull(),
    bytes: integer("bytes").notNull(),
  },
  (table) => [
    index("question_process_capacity_idx").on(
      table.recordingId,
      table.questionId,
      table.bytes,
      table.firstSeq,
      table.lastSeq,
    ),
    primaryKey({
      columns: [
        table.recordingId,
        table.questionId,
        table.segmentId,
        table.firstSeq,
      ],
    }),
  ],
);
