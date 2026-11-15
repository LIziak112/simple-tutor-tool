import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { attempts, students } from "./schema.ts";

/** v2任务图独立存储，旧v1快照/报告和租约不会被迁移改写。 */
export const reviewV2Runs = sqliteTable(
  "ai_review_v2_runs",
  {
    id: text("id").primaryKey(),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    mutationId: text("mutation_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    previewVersion: text("preview_version").notNull(),
    scopeJson: text("scope_json").notNull(),
    profile: text("profile").$type<"objective" | "essay">().notNull(),
    purpose: text("purpose").notNull(),
    questionCount: integer("question_count").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("ai_review_v2_runs_mutation_uk").on(
      table.studentId,
      table.mutationId,
    ),
    index("ai_review_v2_runs_owner_idx").on(
      table.studentId,
      table.attemptId,
      table.createdAt,
    ),
    check("ai_review_v2_runs_count_ck", sql`${table.questionCount} > 0`),
    check(
      "ai_review_v2_runs_profile_ck",
      sql`${table.profile} IN ('objective','essay')`,
    ),
  ],
);
export const reviewV2Tasks = sqliteTable(
  "ai_review_v2_tasks",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => reviewV2Runs.id),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").$type<"questions" | "summary">().notNull(),
    status: text("status")
      .$type<
        "blocked" | "created" | "claimed" | "replied" | "paused" | "cancelled"
      >()
      .notNull(),
    questionNosJson: text("question_nos_json").notNull(),
    snapshotJson: text("snapshot_json"),
    snapshotVersion: text("snapshot_version"),
    reportJson: text("report_json"),
    reportDigest: text("report_digest"),
    leaseToken: text("lease_token"),
    leaseStartedAt: text("lease_started_at"),
    leaseUntil: text("lease_until"),
    generation: integer("generation").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("ai_review_v2_tasks_order_uk").on(table.runId, table.ordinal),
    index("ai_review_v2_tasks_queue_idx").on(
      table.studentId,
      table.status,
      table.createdAt,
    ),
    check(
      "ai_review_v2_tasks_kind_ck",
      sql`${table.kind} IN ('questions','summary')`,
    ),
    check(
      "ai_review_v2_tasks_status_ck",
      sql`${table.status} IN ('blocked','created','claimed','replied','paused','cancelled')`,
    ),
    check("ai_review_v2_tasks_generation_ck", sql`${table.generation} >= 0`),
  ],
);
export type ReviewV2RunRow = typeof reviewV2Runs.$inferSelect;
export type ReviewV2TaskRow = typeof reviewV2Tasks.$inferSelect;

/** 迟到/取消后的回信只保留审计事实，不覆盖不可变报告。 */
export const reviewV2Audit = sqliteTable(
  "ai_review_v2_audit",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => reviewV2Tasks.id),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    type: text("type").$type<"late_reply">().notNull(),
    generation: integer("generation").notNull(),
    serverTs: text("server_ts").notNull(),
  },
  (table) => [
    index("ai_review_v2_audit_task_idx").on(table.taskId, table.serverTs),
    check("ai_review_v2_audit_type_ck", sql`${table.type} = 'late_reply'`),
  ],
);
