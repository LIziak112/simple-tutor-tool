import type { TeacherPracticeFeedbackPolicy } from "@tutor/contract";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * 教师表——T2B.1 起为多教师基础结构（D1 单表多角色：管理员 = isAdmin 的教师；模块 0 起
 * accountKind 区分班级 / 个人账号）。首位教师由首启 setup 创建；存量唯一教师行由 T2B.1 回填升级（D4）。
 */
export const teachers = sqliteTable(
  "teachers",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /**
     * 登录名（D2：全局唯一，中文/字母/数字/下划线/连字符，2–32，契约校验 T2B.2）。
     * 列可空仅因迁移加列无法在 DDL 内回填（D9）：存量行由 T2B.1 回填 'teacher'，此后恒非空。
     */
    loginName: text("login_name"),
    /** 是否管理员（D1）：管理员可兼任全部教师功能并进管理端（T2B.6）；默认 false */
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    /** 禁用时间（D5）：NULL = 未禁用；置值即禁用（会话立即失效、数据全保留、可再启用） */
    disabledAt: text("disabled_at"),
    /** 登录密码的 scrypt 哈希；设置密码前为 NULL */
    passwordHash: text("password_hash"),
    /** MCP / 脚本调用用的 API Token（T4.6，D22：randomBytes(32) base64url，每教师一份可重置；NULL = 未生成，唯一索引允许多个 NULL） */
    apiToken: text("api_token"),
    /**
     * 辅助能力启用集 JSON（T7.7 / 方案 §4.5）：capabilityProfileSchema 形态
     * （{"enabledCapabilities":[steps/ink 子集]}）。NULL = 未配置 = 全启用（存量行无需回填）；
     * 空数组 = 显式全关。学生端 attempt/讲义接口按本列下发有效启用集；只影响辅助入口渲染，不是安全边界。
     */
    capabilityProfileJson: text("capability_profile_json"),
    /**
     * 练习反馈默认策略（M1b，2026-10-22 计划 §5.2）：student_choice | after_attempt。
     * NULL = 未配置，新普通自由练习（course/wrong 建卷）按 student_choice 缺省；不混入
     * capabilityProfileJson；异常持久化值读侧按 after_attempt 处理（fail closed）。
     */
    practiceFeedbackPolicy: text(
      "practice_feedback_policy",
    ).$type<TeacherPracticeFeedbackPolicy>(),
    studentSelfReviewEnabled: integer("student_self_review_enabled", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    /** 账号类型（模块 0）：class 班级账号（存量行默认）/ personal 个人账号（见 auth/personal-auth-service.ts） */
    accountKind: text("account_kind")
      .$type<"class" | "personal">()
      .notNull()
      .default("class"),
    /** 个人账号固定绑定的学习者 students.id（仅 personal 非空；不建外键，与 students.teacherId 同口径） */
    personalStudentId: text("personal_student_id"),
    /** 创建时间：UTC ISO 字符串 */
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // 登录名全局唯一（D2；SQLite 唯一索引允许多个 NULL——回填前的中间态不冲突）
    uniqueIndex("teachers_login_name_uk").on(table.loginName),
    // API Token 全局唯一（D22；多个 NULL 合法——未生成 token 的教师不冲突）
    uniqueIndex("teachers_api_token_uk").on(table.apiToken),
  ],
);

export type Teacher = typeof teachers.$inferSelect;
export type NewTeacher = typeof teachers.$inferInsert;
