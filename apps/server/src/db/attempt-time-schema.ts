import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { attempts, events, responses } from "./schema";

/** 独立 profile 保证旧卷不升级；新卷创建事务中的 trigger 选择版本。 */
export const attemptTimeProfiles = sqliteTable(
  "attempt_time_profiles",
  {
    attemptId: text("attempt_id")
      .primaryKey()
      .references(() => attempts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
  },
  (t) => [check("time_profile_version", sql`${t.version}=1`)],
);
export const attemptEventReceipts = sqliteTable(
  "attempt_event_receipts",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .unique()
      .references(() => events.id, { onDelete: "cascade" }),
    origin: text("origin", { enum: ["client", "server"] }).notNull(),
    kind: text("kind", { enum: ["event", "seal"] }).notNull(),
    receivedAt: text("received_at").notNull(),
  },
  (t) => [
    index("time_receipt_attempt_seq").on(t.attemptId, t.seq),
    check(
      "time_receipt_source",
      sql`${t.origin} IN ('client','server') AND ((${t.kind}='event' AND ${t.eventId} IS NOT NULL) OR (${t.kind}='seal' AND ${t.origin}='server' AND ${t.eventId} IS NULL))`,
    ),
  ],
);
export const responseTimeLedger = sqliteTable(
  "response_time_ledger",
  {
    responseId: text("response_id")
      .primaryKey()
      .references(() => responses.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    state: text("state", { enum: ["available", "unknown"] }).notNull(),
    reason: text("reason", {
      enum: ["no_client_evidence", "clock_invalid", "ledger_missing"],
    }),
    activeMs: integer("active_ms"),
    observedMs: integer("observed_ms"),
    activeSec: integer("active_sec"),
    observedSec: integer("observed_sec"),
    actions: integer("actions").notNull(),
    viewed: integer("viewed", { mode: "boolean" }).notNull(),
    boundarySeq: integer("boundary_seq")
      .notNull()
      .references(() => attemptEventReceipts.seq),
    sealedAt: text("sealed_at").notNull(),
    inputDigest: text("input_digest").notNull(),
  },
  (t) => [
    index("time_ledger_attempt").on(t.attemptId),
    check(
      "time_ledger_shape",
      sql`${t.version}=1 AND ${t.actions}>=0 AND ${t.actions}<=9007199254740991 AND ${t.viewed} IN (0,1) AND ((${t.state}='unknown' AND ${t.reason} IS NOT NULL AND ${t.activeMs} IS NULL AND ${t.observedMs} IS NULL AND ${t.activeSec} IS NULL AND ${t.observedSec} IS NULL) OR (${t.state}='available' AND ${t.reason} IS NULL AND ${t.activeMs} BETWEEN 0 AND 9007199254740991 AND ${t.observedMs} BETWEEN 0 AND 9007199254740991 AND ${t.activeSec}=cast((${t.activeMs}+500)/1000 as integer) AND ${t.observedSec}=cast((${t.observedMs}+500)/1000 as integer)))`,
    ),
  ],
);
export const attemptTimeSpans = sqliteTable(
  "attempt_time_spans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    sealResponseId: text("seal_response_id")
      .notNull()
      .references(() => responseTimeLedger.responseId, { onDelete: "cascade" }),
    ownerResponseId: text("owner_response_id").references(
      () => responseTimeLedger.responseId,
      { onDelete: "cascade" },
    ),
    kind: text("kind", {
      enum: ["active", "observed", "unattributed"],
    }).notNull(),
    start: integer("start_ms").notNull(),
    end: integer("end_ms").notNull(),
  },
  (t) => [
    index("time_span_attempt_start").on(t.attemptId, t.start),
    check(
      "time_span_shape",
      sql`${t.start}>=0 AND ${t.end}>${t.start} AND ${t.end}<=9007199254740991 AND ((${t.kind}='unattributed' AND ${t.ownerResponseId} IS NULL) OR (${t.kind} IN ('active','observed') AND ${t.ownerResponseId} IS NOT NULL))`,
    ),
  ],
);
