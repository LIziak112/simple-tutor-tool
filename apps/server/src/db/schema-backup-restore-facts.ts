import type { BackupRestoreFact } from "@tutor/contract";
import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const backupRestoreFacts = sqliteTable(
  "backup_restore_facts",
  {
    id: text("id").primaryKey().notNull(),
    fact: text("fact_json", { mode: "json" })
      .$type<BackupRestoreFact>()
      .notNull(),
  },
  (table) => [
    check("backup_restore_fact_json_valid", sql`json_valid(${table.fact})`),
  ],
);
