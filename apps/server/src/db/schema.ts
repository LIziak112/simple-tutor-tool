import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 数据库表定义（Drizzle / SQLite）。表结构以架构文档 §5.2 数据模型为准，
 * T0.5 建 teachers、sessions；T1.9 追加 login_failures（登录限流，§5.7）。
 *
 * 全库约定（见 docs/开发任务清单.md §0.3 与 db-change 技能）：
 * - 主键 id 一律为应用层生成的 crypto.randomUUID() 字符串；
 * - 时间统一存 UTC ISO 字符串（new Date().toISOString()），不用时间戳数字；
 * - 表名/列名 snake_case，TS 属性名 camelCase。
 */

/**
 * 教师表——单行设计（一对一辅导场景全系统只有一位老师，首次启动设置密码时由 T1.9 写入）。
 */
export const teachers = sqliteTable("teachers", {
  /** 主键：crypto.randomUUID()（§0.3 主键约定） */
  id: text("id").primaryKey(),
  /** 登录密码的 scrypt 哈希；设置密码前为 NULL */
  passwordHash: text("password_hash"),
  /** MCP / 脚本调用用的 API Token（T4.5 接入），可重置；未生成时为 NULL */
  apiToken: text("api_token"),
  /** 创建时间：UTC ISO 字符串 */
  createdAt: text("created_at").notNull(),
});

/**
 * 会话表——老师与学生共用（登录后写入同一种会话 Cookie，见架构文档 §5.7）。
 */
export const sessions = sqliteTable("sessions", {
  /** 主键：crypto.randomUUID()（§0.3 主键约定） */
  id: text("id").primaryKey(),
  /** 会话主体类型：'teacher' 或 'student' */
  subjectType: text("subject_type").$type<"teacher" | "student">().notNull(),
  /**
   * 主体 id——多态引用（teachers.id 或未来的 students.id）。
   * 不建外键：student_type 主体指向的 students 表要到 T2.1 才创建，
   * 且先删主体后会话由过期清理任务负责，靠外键级联反而会把清理顺序耦死。
   */
  subjectId: text("subject_id").notNull(),
  /** 过期时间：UTC ISO 字符串（教师会话 7 天、学生会话 90 天，写入方决定） */
  expiresAt: text("expires_at").notNull(),
  /** 创建时间：UTC ISO 字符串 */
  createdAt: text("created_at").notNull(),
});

/** teachers 表行类型（SELECT 结果） */
export type Teacher = typeof teachers.$inferSelect;
/** teachers 表插入类型 */
export type NewTeacher = typeof teachers.$inferInsert;
/** sessions 表行类型（SELECT 结果） */
export type Session = typeof sessions.$inferSelect;
/** sessions 表插入类型 */
export type NewSession = typeof sessions.$inferInsert;

/**
 * 登录失败限流表（§5.7：同一 IP / 同一登录名连续失败 5 次锁定 10 分钟）。
 * key 形如 "name:登录名" 或 "ip:IP"，按 key 分别计数；T2.1 学生登录复用本表。
 * count 与 lockedUntil 由服务层维护（锁过期后计数清零重来）。
 */
export const loginFailures = sqliteTable("login_failures", {
  /** 限流键（主键）：`name:<登录名>` 或 `ip:<IP>` */
  key: text("key").primaryKey(),
  /** 连续失败次数；成功登录后整行删除 */
  count: integer("count").notNull(),
  /** 锁定截止时间：UTC ISO 字符串；未锁定时为 NULL */
  lockedUntil: text("locked_until"),
});

/** login_failures 表行类型（SELECT 结果） */
export type LoginFailure = typeof loginFailures.$inferSelect;
/** login_failures 表插入类型 */
export type NewLoginFailure = typeof loginFailures.$inferInsert;
