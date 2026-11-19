import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { assignments } from "./schema.ts";

export const kernelAssignments = sqliteTable("kernel_assignments", {
  assignmentId: text("assignment_id")
    .primaryKey()
    .notNull()
    .references(() => assignments.id, { onDelete: "cascade" }),
});
