import type { AiAttemptReviewStatus } from "@tutor/contract";
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

/**
 * AI 整体复盘事实类型（独立于单题 aiFacts 的事实词表；append-only）。
 * 不写入旧 aiHelpQuestionFacts 的按题统计——一次整体任务不虚增逐题求助记录。
 */
export type AiAttemptReviewFactType =
  | "task_created"
  | "claimed"
  | "replied"
  | "opened"
  | "failed"
  | "late_reply"
  | "cancelled"
  | "archived"
  | "retried"
  | "paused";

/**
 * AI 本次练习整体复盘任务表（任务 1ef854c7，《批量复盘整体分析与实施交接》
 * §6.1）——一行 = 一个 attempt 的一次整体复盘任务，与逐题 ai_tasks 并行、
 * 不复用单题表（不造占位 questionId，不破坏单题 FK/计数/教师督学事实）。
 * - 快照：contextSnapshotJson 为建任务时冻结的整体白名单快照（契约
 *   aiAttemptReviewSnapshotSchema 序列化，内部视图含允许的参考答案/解析；
 *   存库列，进备份）；snapshotVersion 为其 HMAC 身份戳，范围/判分/公布态
 *   变化即换值——旧报告永指原快照，不静默换新；
 * - mutationId 全局唯一：同键同内容重放返回原任务，同键异内容 409；
 * - 租约列仅 MCP 领取通道使用（初始 10 分钟，过期惰性回 created）；
 * - 删除策略：任务行是证据锚点（facts/results 的锚），不物理删。
 */
export const aiAttemptReviewTasks = sqliteTable(
  "ai_attempt_review_tasks",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 复盘学生（students.id） */
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    /** 所属作答（attempts.id；已交卷且答案公布门满足才可创建） */
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    /** 客户端幂等键（全局唯一索引承载查重） */
    mutationId: text("mutation_id").notNull(),
    /** 请求摘要（purpose + expectedPreviewVersion 的 sha-256；同键异内容 409 判据） */
    requestDigest: text("request_digest").notNull(),
    /** 出站通道（MVP 仅 mcp：外部客户端领取，页内不出站） */
    channel: text("channel").$type<"mcp">().notNull().default("mcp"),
    /** 快照契约版本 */
    schemaVersion: integer("schema_version").notNull().default(1),
    /** 快照身份不透明戳（HMAC；与预览版本同源） */
    snapshotVersion: text("snapshot_version").notNull(),
    /** 冻结整体快照 JSON（内部视图；不在学生普通接口返回） */
    contextSnapshotJson: text("context_snapshot_json").notNull(),
    /** 固定整体分析提示词快照 sha-256 */
    promptHash: text("prompt_hash").notNull(),
    /** 学生复盘诉求（可编辑；只作分析诉求） */
    purpose: text("purpose").notNull(),
    /** 整体覆盖题数（= 本次练习完整范围） */
    questionCount: integer("question_count").notNull(),
    /** 四桶计数 JSON（创建时冻结的反规范化投影；公开视图免解整体快照） */
    countsJson: text("counts_json").notNull(),
    /** 处理状态（契约 aiAttemptReviewStatusSchema 六态） */
    status: text("status")
      .$type<AiAttemptReviewStatus>()
      .notNull()
      .default("created"),
    /** 出站代次（0 = 未领取；每次领取 +1，写回 CAS 比对） */
    generation: integer("generation").notNull().default(0),
    /** MCP 租约截止：UTC ISO；非 claimed 为 NULL（过期惰性回 created） */
    leaseUntil: text("lease_until"),
    /** MCP 租约令牌（写回 CAS 凭证；迟到持有者仅记 late_reply 事实） */
    leaseToken: text("lease_token"),
    /** 最近失败摘要（failed 态）；无失败为 NULL */
    errorText: text("error_text"),
    /** 显式重试次数（学生显式重试 +1，绝不自动重发） */
    retryCount: integer("retry_count").notNull().default(0),
    /** 学生打开报告时刻：UTC ISO；null = 未查看 */
    openedAt: text("opened_at"),
    /** 学生归档时刻（队列整理；状态与事实不动）；null = 未归档 */
    archivedAt: text("archived_at"),
    /** 创建时间：UTC ISO 字符串 */
    createdAt: text("created_at").notNull(),
    /** 最近更新时间：UTC ISO 字符串 */
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // 学生任务列表（按创建时间倒序）
    index("ai_attempt_review_tasks_student_created_idx").on(
      table.studentId,
      table.createdAt,
    ),
    // 同卷活动任务定位（每 attempt 活动任务最多 1 的判定与复用）
    index("ai_attempt_review_tasks_attempt_status_idx").on(
      table.attemptId,
      table.status,
    ),
    // 租约惰性清理（claimed 且 leaseUntil < now → 回 created 可再领取）
    index("ai_attempt_review_tasks_status_lease_idx").on(
      table.status,
      table.leaseUntil,
    ),
    // 幂等键全局唯一（同请求键第二任务被 DB 拒绝）
    uniqueIndex("ai_attempt_review_tasks_mutation_id_uk").on(table.mutationId),
    check(
      "ai_attempt_review_tasks_channel_check",
      sql`${table.channel} = 'mcp'`,
    ),
    check(
      "ai_attempt_review_tasks_status_check",
      sql`${table.status} in ('created', 'claimed', 'replied', 'failed', 'paused', 'cancelled')`,
    ),
  ],
);

/**
 * AI 整体复盘结果表——一行 = 一次成功交付的结构化报告，唯一 (taskId,
 * generation)：同代同内容重放按内容哈希幂等返回原回执，同代异内容 409；
 * 学生显式重试后重新领取为新一代，新报告不覆盖旧代（历史版本保留）。
 * 报告按不可信输入校验入库；渲染层走安全渲染。
 */
export const aiAttemptReviewResults = sqliteTable(
  "ai_attempt_review_results",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 所属任务（ai_attempt_review_tasks.id） */
    taskId: text("task_id")
      .notNull()
      .references(() => aiAttemptReviewTasks.id),
    /** 出站代次（与任务行领取代次对应） */
    generation: integer("generation").notNull(),
    /** 结构化报告 JSON（契约 aiAttemptReviewReportSchema 序列化） */
    reportJson: text("report_json").notNull(),
    /** 报告内容 sha-256（幂等判定） */
    contentHash: text("content_hash").notNull(),
    /** 服务端收到时间：UTC ISO */
    receivedAt: text("received_at").notNull(),
  },
  (table) => [
    // 一代一结果：重试产生新代，旧报告不被覆盖
    uniqueIndex("ai_attempt_review_results_task_generation_uk").on(
      table.taskId,
      table.generation,
    ),
  ],
);

/**
 * AI 整体复盘审计事实表（append-only，永不 UPDATE/DELETE）——taskId 不建
 * 外键（事实须在任务行任何形态下独立存在；任务行本就不物理删）；冗余列
 * （studentId/attemptId）随任务行同源写入。不写入旧 ai_facts（按题督学
 * 统计不受整体任务影响）。
 */
export const aiAttemptReviewFacts = sqliteTable(
  "ai_attempt_review_facts",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 所属任务（ai_attempt_review_tasks.id；无外键，见表注释） */
    taskId: text("task_id").notNull(),
    /** 学生（students.id；冗余列） */
    studentId: text("student_id").notNull(),
    /** 所属作答（attempts.id；冗余列） */
    attemptId: text("attempt_id").notNull(),
    /** 事实类型（AiAttemptReviewFactType 10 种） */
    type: text("type").$type<AiAttemptReviewFactType>().notNull(),
    /** 事实详情 JSON（代次、原因摘要等；无详情为 NULL） */
    detailJson: text("detail_json"),
    /** 服务端时间：UTC ISO 字符串 */
    serverTs: text("server_ts").notNull(),
  },
  (table) => [
    // 任务时间线
    index("ai_attempt_review_facts_task_ts_idx").on(
      table.taskId,
      table.serverTs,
    ),
    // 按卷查询
    index("ai_attempt_review_facts_attempt_ts_idx").on(
      table.attemptId,
      table.serverTs,
    ),
    check(
      "ai_attempt_review_facts_type_check",
      sql`${table.type} in ('task_created', 'claimed', 'replied', 'opened', 'failed', 'late_reply', 'cancelled', 'archived', 'retried', 'paused')`,
    ),
  ],
);

export type AiAttemptReviewTaskRow = typeof aiAttemptReviewTasks.$inferSelect;
export type NewAiAttemptReviewTaskRow =
  typeof aiAttemptReviewTasks.$inferInsert;
export type AiAttemptReviewResultRow =
  typeof aiAttemptReviewResults.$inferSelect;
export type AiAttemptReviewFactRow = typeof aiAttemptReviewFacts.$inferSelect;
