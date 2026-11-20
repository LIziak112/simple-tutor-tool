import type { MarkResponseData, TeacherMark } from "@tutor/contract";
import type { KernelQuestionDeliveryIntent } from "@tutor/contract/kernel-question-delivery";
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { PublicationInput, VerdictCommand } from "learning-kernel";
import type { KernelOpeningDraft } from "../services/kernel-assignment-input.ts";
import { attempts, responses } from "./schema.ts";

export const kernelLessonOpenings = sqliteTable(
  "kernel_lesson_openings",
  {
    studentId: text("student_id").notNull(),
    lectureId: text("lecture_id").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    courseId: text("course_id").notNull(),
    teacherId: text("teacher_id").notNull(),
    unitId: text("unit_id").notNull(),
    operationId: text("operation_id").notNull().unique(),
    practiceId: text("practice_id").notNull().unique(),
    practiceVersion: integer("practice_version").notNull(),
    publication: text("publication_json", { mode: "json" })
      .$type<PublicationInput>()
      .notNull(),
    draft: text("draft_json", { mode: "json" })
      .$type<KernelOpeningDraft>()
      .notNull(),
    attemptId: text("attempt_id")
      .unique()
      .references(() => attempts.id),
    stepAttemptId: text("step_attempt_id").unique(),
  },
  (t) => [
    primaryKey({ columns: [t.studentId, t.lectureId, t.attemptNo] }),
    check(
      "kernel_lesson_opening_bound",
      sql`(${t.attemptId} IS NULL) = (${t.stepAttemptId} IS NULL)`,
    ),
  ],
);

export const kernelQuestionDeliveries = sqliteTable(
  "kernel_question_deliveries",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    stepAttemptId: text("step_attempt_id").notNull(),
    slotId: text("slot_id").notNull(),
    operationId: text("operation_id").notNull(),
    practiceVersion: integer("practice_version").notNull(),
    intent: text("intent_json", { mode: "json" })
      .$type<KernelQuestionDeliveryIntent>()
      .notNull(),
    receiptId: text("receipt_id").unique(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.stepAttemptId, t.slotId] }),
    unique().on(t.stepAttemptId, t.operationId),
  ],
);

export const kernelResponseMarks = sqliteTable(
  "kernel_response_marks",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    responseId: text("response_id")
      .notNull()
      .references(() => responses.id, { onDelete: "cascade" }),
    teacherId: text("teacher_id").notNull(),
    operationId: text("operation_id").notNull(),
    baseRevision: integer("base_revision").notNull(),
    mark: text("mark").$type<TeacherMark>(),
    comment: text("comment"),
    command: text("command_json", { mode: "json" }).$type<VerdictCommand>(),
    result: text("result_json", { mode: "json" }).$type<MarkResponseData>(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.teacherId, t.operationId] }),
    uniqueIndex("kernel_response_mark_pending")
      .on(t.responseId)
      .where(sql`${t.result} IS NULL`),
    check(
      "kernel_response_mark_completion",
      sql`${t.command} IS NOT NULL OR ${t.result} IS NOT NULL`,
    ),
    check("kernel_response_mark_revision", sql`${t.baseRevision} >= 0`),
  ],
);
