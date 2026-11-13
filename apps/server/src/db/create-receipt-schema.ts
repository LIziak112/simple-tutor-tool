import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const createReceipts = sqliteTable(
  "create_receipts",
  {
    kind: text("kind", {
      enum: ["lesson-restart", "wrong-practice", "assignment"],
    }).notNull(),
    actorId: text("actor_id").notNull(),
    operationId: text("operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    resultJson: text("result_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.actorId, table.operationId] }),
  ],
);
