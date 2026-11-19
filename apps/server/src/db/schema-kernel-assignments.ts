import type { AttemptSubmitRequest } from "@tutor/contract";
import {
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import type { PublicationInput } from "learning-kernel";
import type { KernelOpeningDraft } from "../services/kernel-assignment-input.ts";
import { assignments, attempts, students } from "./schema.ts";

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

export const kernelAssignmentOpenings = sqliteTable(
  "kernel_assignment_openings",
  {
    assignmentId: text("assignment_id").notNull(),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    practiceVersion: integer("practice_version").notNull(),
    publication: text("publication_json", { mode: "json" })
      .$type<PublicationInput>()
      .notNull(),
    draft: text("draft_json", { mode: "json" })
      .$type<KernelOpeningDraft>()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.assignmentId, table.studentId] }),
    foreignKey({
      columns: [table.assignmentId, table.practiceVersion],
      foreignColumns: [
        kernelAssignmentVersions.assignmentId,
        kernelAssignmentVersions.practiceVersion,
      ],
    }),
  ],
);

/** 保存可授权恢复的确认操作与冻结引用，不存答案正文或判定。 */
export const kernelAttemptConfirmations = sqliteTable(
  "kernel_attempt_confirmations",
  {
    attemptId: text("attempt_id")
      .primaryKey()
      .notNull()
      .references(() => kernelAttemptBindings.attemptId, {
        onDelete: "cascade",
      }),
    operationId: text("operation_id").notNull().unique(),
    stepAttemptId: text("step_attempt_id").notNull(),
    practiceVersion: integer("practice_version").notNull(),
    request: text("request_json", { mode: "json" })
      .$type<AttemptSubmitRequest>()
      .notNull(),
  },
);
