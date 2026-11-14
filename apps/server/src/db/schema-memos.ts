import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * 随笔表（2026-11-10，个人学习迭代模块 5 第一步：随笔记录端）。
 * 一行 = 学习者本人随手记的一条：文字 / 语音 / 图片 / 手写（kind）。原始随笔
 * 不可变——只插入、只软删（deletedAt），没有 update 路径；整理稿是带 parentMemoSeq 的
 * 新条目，不覆盖原文。媒体本体内容寻址存 blobs/memos/<sha256>.<ext>，
 * 多行可共享一个 blob（与资料附件 / ::image 媒体同款，纳入 blobs/ 整目录备份）。
 * 默认仅本人；memo_shares 显式逐条授权当前归属教师。
 */
export const memos = sqliteTable(
  "memos",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 本人（students.id；个人账号即其绑定学习者行）。无外键，与 attempts 同口径 */
    studentId: text("student_id").notNull(),
    /** 客户端生成的幂等键（UUID）；(student_id, client_id) 唯一——离线补传重复只落一行 */
    clientId: text("client_id").notNull(),
    /** 本人递增序号；结构迁移后由启动回填补齐历史值。 */
    seq: integer("seq"),
    parentMemoSeq: integer("parent_memo_seq"),
    /** Agent原请求规范化摘要；不对外投影。 */
    agentRequestDigest: text("agent_request_digest"),
    /** 版本化内容与会话坐标 JSON；无法可靠恢复的旧锚保持 NULL。 */
    contextJson: text("context_json"),
    /** 本人已登记设备；历史设备类型不能反推设备身份。 */
    deviceId: text("device_id"),
    /** 形态：text / voice / image / ink（契约 memoKindSchema） */
    kind: text("kind").$type<"text" | "voice" | "image" | "ink">().notNull(),
    /** 文字随笔正文；媒体随笔的可选说明；无则 NULL */
    text: text("text"),
    /** 媒体格式（契约 memoMediaFormatSchema）；文字随笔 NULL */
    mediaFormat: text("media_format"),
    /** 媒体字节数；文字随笔 NULL */
    mediaBytes: integer("media_bytes"),
    /** 媒体内容哈希（小写 sha256 hex）；blob 文件名 = <sha256>.<format>；文字随笔 NULL */
    mediaSha256: text("media_sha256"),
    /** 语音时长（秒，客户端自报）；非语音 NULL */
    durationSec: integer("duration_sec"),
    /** 上下文锚 JSON（契约 memoAnchorSchema 序列化；无锚为 {"kind":"none"}） */
    anchorJson: text("anchor_json").notNull(),
    /** 锚到的作答 id（从 anchor 抽出便于按作答过滤 / 建索引）；无则 NULL */
    anchorAttemptId: text("anchor_attempt_id"),
    /** 锚到的讲义 id（同上）；无则 NULL */
    anchorLectureId: text("anchor_lecture_id"),
    /** 标签 JSON 数组（已规范化：去空、去重、≤ 5 个） */
    tagsJson: text("tags_json").notNull(),
    /** 来源：self 本人界面 / agent Agent 经 MCP 转记 */
    source: text("source").$type<"self" | "agent">().notNull(),
    /** 记录设备：phone / tablet / desktop / agent / other */
    device: text("device").notNull(),
    /** 服务端收到时间：UTC ISO */
    createdAt: text("created_at").notNull(),
    /** 设备上记下的时间：UTC ISO（离线补传早于 createdAt；缺省同 createdAt） */
    recordedAt: text("recorded_at").notNull(),
    /** 软删时间：UTC ISO；未删除为 NULL */
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("memos_student_seq_uk").on(table.studentId, table.seq),
    uniqueIndex("memos_student_client_uk").on(table.studentId, table.clientId),
    index("memos_student_recorded_idx").on(
      table.studentId,
      table.deletedAt,
      table.recordedAt,
    ),
    index("memos_student_attempt_idx").on(
      table.studentId,
      table.anchorAttemptId,
    ),
    index("memos_student_lecture_idx").on(
      table.studentId,
      table.anchorLectureId,
    ),
  ],
);

/** 逐条授权；归属改变、归档和软删都会即时阻止读取。 */
export const memoShares = sqliteTable("memo_shares", {
  memoId: text("memo_id").primaryKey(),
  studentId: text("student_id").notNull(),
  teacherId: text("teacher_id").notNull(),
  createdAt: text("created_at").notNull(),
});
