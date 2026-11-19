import {
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { assignments, attempts } from "./schema.ts";

export const kernelAssignments = sqliteTable("kernel_assignments", {
  assignmentId: text("assignment_id")
    .primaryKey()
    .notNull()
    .references(() => assignments.id, { onDelete: "cascade" }),
});

export const kernelAssignmentVersions = sqliteTable(
  "kernel_assignment_versions",
  {
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => kernelAssignments.assignmentId),
    practiceVersion: integer("practice_version").notNull(),
    fingerprint: text("fingerprint").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.assignmentId, table.practiceVersion] }),
    unique().on(table.assignmentId, table.fingerprint),
  ],
);

export const kernelAttemptBindings = sqliteTable(
  "kernel_attempt_bindings",
  {
    attemptId: text("attempt_id")
      .primaryKey()
      .notNull()
      .references(() => attempts.id),
    assignmentId: text("assignment_id").notNull(),
    practiceVersion: integer("practice_version").notNull(),
    stepAttemptId: text("step_attempt_id").notNull().unique(),
  },
  (table) => [
    foreignKey({
      columns: [table.assignmentId, table.practiceVersion],
      foreignColumns: [
        kernelAssignmentVersions.assignmentId,
        kernelAssignmentVersions.practiceVersion,
      ],
    }),
  ],
);
