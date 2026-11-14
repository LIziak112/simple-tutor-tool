import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 会话表——老师与学生共用（登录后写入同一种会话 Cookie，见架构文档 §5.7）。
 */
export const sessions = sqliteTable("sessions", {
  /** 主键：crypto.randomUUID()（§0.3 主键约定） */
  id: text("id").primaryKey(),
  /** 会话主体类型：'teacher' 或 'student' */
  subjectType: text("subject_type").$type<"teacher" | "student">().notNull(),
  /**
   * 主体 id——多态引用（teachers.id 或 students.id）。不建外键：先删主体后会话由
   * 过期清理任务负责，靠外键级联反而会把清理顺序耦死。
   */
  subjectId: text("subject_id").notNull(),
  /** 已登记设备 id；历史会话未知，不做猜测回填。 */
  deviceId: text("device_id"),
  /** 过期时间：UTC ISO 字符串（教师 / 学生会话均 90 天，写入方决定；教师 2026-11 前为 7 天） */
  expiresAt: text("expires_at").notNull(),
  /** 创建时间：UTC ISO 字符串 */
  createdAt: text("created_at").notNull(),
});

/** sessions 表的行类型与插入类型 */
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
