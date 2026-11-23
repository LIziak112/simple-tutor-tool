import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { attempts, noteVersions } from "./schema.ts";

export const attemptOriginalReservations = sqliteTable(
  "attempt_original_reservations",
  {
    operationId: text("operation_id").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    versionId: text("version_id").notNull(),
    revision: integer("revision").notNull(),
    hash: text("hash").notNull(),
    pendingVersionId: text("pending_version_id").references(
      () => noteVersions.id,
    ),
    state: text("state", {
      enum: ["pending", "projected", "aborted"],
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.attemptId, table.operationId, table.questionId],
    }),
    index("attempt_original_reservations_pending_idx").on(
      table.pendingVersionId,
    ),
    check(
      "attempt_original_reservations_pin_check",
      sql`(
        ${table.state} = 'pending' AND
        ${table.pendingVersionId} IS NOT NULL AND
        ${table.pendingVersionId} = ${table.versionId}
      ) OR (
        ${table.state} IN ('projected', 'aborted') AND
        ${table.pendingVersionId} IS NULL
      )`,
    ),
  ],
);
