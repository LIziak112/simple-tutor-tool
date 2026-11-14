import type { AttemptSettlement } from "@tutor/contract";
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { attempts } from "./schema.ts";

/** 永久结算事实；与十五分钟过期的交卷传输暂存表无关。 */
export const attemptSettlements = sqliteTable(
  "attempt_settlements",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").$type<AttemptSettlement["kind"]>().notNull(),
    createdAt: text("created_at").notNull(),
    questionCount: integer("question_count").notNull(),
    activeSec: integer("active_sec"),
    mutationId: text("mutation_id").notNull(),
    requestDigest: text("request_digest").notNull(),
  },
  (table) => [
    uniqueIndex("attempt_settlements_seq_uk").on(table.attemptId, table.seq),
    uniqueIndex("attempt_settlements_mutation_uk").on(
      table.attemptId,
      table.mutationId,
    ),
    uniqueIndex("attempt_settlements_final_uk")
      .on(table.attemptId)
      .where(sql`${table.kind} = 'final'`),
    check(
      "attempt_settlements_seq_check",
      sql`typeof(${table.seq}) = 'integer' and ${table.seq} > 0`,
    ),
    check(
      "attempt_settlements_kind_check",
      sql`${table.kind} in ('partial','final')`,
    ),
    check(
      "attempt_settlements_count_check",
      sql`typeof(${table.questionCount}) = 'integer' and (${table.questionCount} > 0 or (${table.kind} = 'final' and ${table.questionCount} = 0))`,
    ),
    check(
      "attempt_settlements_time_check",
      sql`${table.activeSec} is null or (typeof(${table.activeSec}) = 'integer' and ${table.activeSec} >= 0)`,
    ),
  ],
);
