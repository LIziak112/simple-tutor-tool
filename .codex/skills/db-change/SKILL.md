---
name: db-change
description: 在 simple-tutor-tool 中新增或修改 SQLite 数据库表结构的标准流程。凡涉及建表、加列、改字段、Drizzle schema、drizzle-kit 迁移时使用。核心约束：只改 schema.ts 再生成迁移、禁止手改已有迁移文件、题目只允许软删除。
---

# 数据库结构变更

适用于所有建表/改表任务（T0.5、T1.10、T2.1、T2.2、T2.6、T2.8、T2.10、T4.5 等）。数据库是 SQLite（better-sqlite3，WAL 模式，`foreign_keys=ON`），ORM 用 Drizzle。

## 固定顺序

1. **改 schema**：只改 `apps/server/src/db/schema.ts`，按任务需要追加表或列。表结构设计以架构文档 §5.2 的数据模型为准，字段名保持一致。
2. **生成迁移**：`pnpm db:generate`（drizzle-kit）。生成后检查迁移文件内容与预期一致。
3. **测试**：用 `createTestDb()`（内存库 + 跑全部迁移）写服务层测试，验证新结构下的读写行为。

## 红线

- **禁止修改已有迁移文件**。已应用过的迁移被改动后，线上库与新库的 schema 会分叉，无法再对齐。改错了就生成一个新的补偿迁移。
- **题目只允许软删除**（`deletedAt` 字段置时间，不物理 DELETE）。历史作答通过 `questionSnapshotJson` 关联题目，物理删除会破坏历史统计。同理删除作业也不删除已有作答记录。
- 时间统一存 UTC ISO 字符串，不用时间戳数字。
- 笔迹数据不进数据库：文件存 `DATA_DIR/blobs/ink/…`，库里只存路径（`strokesPath`/`pngPath`）。

## 既有表速查（详见架构文档 §5.2）

teachers、students、sessions、login_failures、courses、lectures、units、questions、knowledge_points、question_knowledge、imports、assignments、assignment_students、attempts、responses、ink、events、reports。

新任务建表时先查这张清单：表已存在就改列，不要建重复语义的表。
