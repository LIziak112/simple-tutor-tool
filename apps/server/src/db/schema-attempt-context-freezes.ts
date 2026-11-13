import { sql } from "drizzle-orm";
import {
  check,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { attempts } from "./schema.ts";

/** 一条记录表示上下文冻结已完成，包括零材料、零题组。无记录的旧卷保留原证据。 */
export const attemptContextFreezes = sqliteTable("attempt_context_freezes", {
  attemptId: text("attempt_id")
    .primaryKey()
    .notNull()
    .references(() => attempts.id, { onDelete: "cascade" }),
  frozenAt: text("frozen_at").notNull(),
});

/**
 * attempt 上下文冻结快照表（tt-05b / QM-03 预留，决策记录 §5.8.1 与设计方案
 * §5.1/§5.3）——开卷冻结时按 attempt 保存组与材料的冻结内容、版本及引用：
 * - 冻结后显示、判分、AI 组装、导出、错题重练只读快照；不能仅引用 live
 *   materials（教师改题库不影响进行中卷）；
 * - 去重键 (attemptId, kind, sourceId, sourceVersion)：同一材料同版本一次
 *   存储（一篇长文章多题共享，不每题复制一份）；**材料快照与 responses
 *   同时成功才算开卷成功**（同事务写入，写入方 QM-06/TT-07 接线）；
 * - 错题重练复制来源作答的该子题及必要材料/说明：新卷有自己的快照行，
 *   同 ID 不同版本经 sourceVersion 天然不互相覆盖（§5.3）；
 * - snapshotJson 为学生作答所需的**公开投影形态**（materialPublicSchema /
 *   questionGroupPublicSchema 序列化——白名单字段，教师侧 sourceMd 不冻结
 *   下发；导出重建走 live 库源文）。
 */
export const attemptContextSnapshots = sqliteTable(
  "attempt_context_snapshots",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 所属作答（attempts.id；归属链 attemptId → studentId → teacherId 由服务层推导，客户端不可指定） */
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    /** 冻结实体类型：material=材料 / group=题组 */
    kind: text("kind").$type<"material" | "group">().notNull(),
    /** 来源实体 id（materials.id / question_groups.id，教师域 DSL id） */
    sourceId: text("source_id").notNull(),
    /** 冻结时的来源内容版本（materials.version / question_groups.version） */
    sourceVersion: integer("source_version").notNull(),
    /** 冻结内容 JSON（公开投影形态序列化，见表注释） */
    snapshotJson: text("snapshot_json").notNull(),
    /** 冻结时间：UTC ISO 字符串（与建卷 frozenAt 同事务） */
    frozenAt: text("frozen_at").notNull(),
  },
  (table) => [
    // 去重键：同一 attempt 同一实体同版本只存一份（onConflictDoNothing 承载幂等）
    uniqueIndex("attempt_context_snapshots_dedupe_uk").on(
      table.attemptId,
      table.kind,
      table.sourceId,
      table.sourceVersion,
    ),
    check(
      "attempt_context_snapshots_kind_check",
      sql`${table.kind} in ('material', 'group')`,
    ),
  ],
);

/** attempt_context_snapshots 表行类型（SELECT 结果；tt-05b 冻结快照） */
export type AttemptContextSnapshotRow =
  typeof attemptContextSnapshots.$inferSelect;
/** attempt_context_snapshots 表插入类型 */
export type NewAttemptContextSnapshotRow =
  typeof attemptContextSnapshots.$inferInsert;
