import type { DocumentKind, QuestionType } from "@tutor/contract";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * 数据库表定义（Drizzle / SQLite）。表结构以架构文档 §5.2 数据模型为准，
 * T0.5 建 teachers、sessions；T1.9 追加 login_failures（登录限流，§5.7）；
 * T1.10 追加内容七表：courses、lectures、units、questions、knowledge_points、
 * question_knowledge、imports（内容存储与导入）。
 *
 * 全库约定（见 docs/开发任务清单.md §0.3 与 db-change 技能）：
 * - 主键 id 一律为应用层生成的 crypto.randomUUID() 字符串；
 *   例外：units/questions 的 id 来自 DSL（题目/单元 id 由文档声明，编辑保持不变，§0.3）；
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

/**
 * 课程表——可选的组织层（如「初一上」，§5.2）。导入未指定 courseId 时落到系统默认课程
 * （title='默认课程'，不存在则由 ContentService 自动创建）。
 */
export const courses = sqliteTable("courses", {
  /** 主键：crypto.randomUUID()（§0.3 主键约定） */
  id: text("id").primaryKey(),
  /** 课程名；默认课程固定「默认课程」（同名复用） */
  title: text("title").notNull(),
  /** 同级排序（小在前）；首个课程为 0 */
  order: integer("order").notNull(),
  /** 创建时间：UTC ISO 字符串 */
  createdAt: text("created_at").notNull(),
});

/**
 * 讲义表。markdown 保存讲义原文（§5.1.1(4) 原文是真相），目录等结构化数据渲染时再解析；
 * 导入按 (courseId, title) 匹配替换 markdown。
 */
export const lectures = sqliteTable("lectures", {
  /** 主键：crypto.randomUUID()（讲义 id 在导入时生成，DSL 不声明） */
  id: text("id").primaryKey(),
  /** 所属课程 */
  courseId: text("course_id")
    .notNull()
    .references(() => courses.id),
  /** 讲义标题（H1 标题文本，导入匹配键） */
  title: text("title").notNull(),
  /** 讲义原始 Markdown（含 H1 标题行） */
  markdown: text("markdown").notNull(),
  /** 课程内排序（小在前） */
  order: integer("order").notNull(),
  /** 最近更新时间：UTC ISO 字符串 */
  updatedAt: text("updated_at").notNull(),
});

/**
 * 练习单元表。id 来自 DSL（frontmatter unit / v1 UNIT 注释），全局唯一（主键），
 * 编辑内容时 id 不变；导入按 unit.id 匹配合并（更新 title/topic/lectureId/courseId）。
 */
export const units = sqliteTable("units", {
  /** 主键：来自 DSL 的单元 id（§0.3 主键约定例外） */
  id: text("id").primaryKey(),
  /** 所属课程 */
  courseId: text("course_id")
    .notNull()
    .references(() => courses.id),
  /** 关联讲义（unit.lectureTitle 按 courseId+标题匹配解析；匹配不到为 NULL，不关联） */
  lectureId: text("lecture_id").references(() => lectures.id),
  /** 单元标题 */
  title: text("title").notNull(),
  /** 主题（frontmatter topic / v1 UNIT 第三段；未标注为 NULL） */
  topic: text("topic"),
  /** 课程内排序（小在前） */
  order: integer("order").notNull(),
  /** 最近更新时间：UTC ISO 字符串 */
  updatedAt: text("updated_at").notNull(),
});

/**
 * 题目表（结构化字段 = 判分与统计必需的抽取结果，§5.1.1(4)）。
 * - id 来自 DSL（题目指令 id 属性 / 缺省 `单元slug-序号`），全局唯一（主键）：
 *   跨单元同 id 的导入按「更新」处理（unitId 随之更新）；
 * - version：内容更新计数，同 id 再导入 +1（T1.10 验收项；历史作答经快照不受影响）；
 * - deletedAt：软删（db-change 红线：题目不物理删除）；软删后同 id 再导入视为恢复。
 */
export const questions = sqliteTable("questions", {
  /** 主键：来自 DSL 的题目 id（§0.3 主键约定例外） */
  id: text("id").primaryKey(),
  /** 所属单元（units.id） */
  unitId: text("unit_id")
    .notNull()
    .references(() => units.id),
  /** 单元内题序（0 起） */
  order: integer("order").notNull(),
  /** 题型（@tutor/contract questionTypeSchema 七种之一） */
  type: text("type").$type<QuestionType>().notNull(),
  /** 难度 1–5 */
  difficulty: integer("difficulty").notNull(),
  /** 题干 Markdown（含 [[答案]] 标记，教师侧内容） */
  stemMd: text("stem_md").notNull(),
  /** 选项 JSON（QuestionOption[]，仅 choice/multi）；无选项为 NULL */
  optionsJson: text("options_json"),
  /** 答案 JSON（QuestionAnswers 判别联合）；不完整答案由 linter 拦在导入前，此处可 NULL */
  answersJson: text("answers_json"),
  /** 提示 JSON（string[]，教师侧内容，学生端按需下发）；无提示存 [] */
  hintsJson: text("hints_json").notNull(),
  /** 详解 Markdown；未提供为 NULL */
  solutionMd: text("solution_md"),
  /** 该题原始 Markdown 片段（reparse 与单题编辑的依据，T1.12/T1.14） */
  sourceMd: text("source_md").notNull(),
  /** 内容版本：新插入 1，同 id 更新 +1 */
  version: integer("version").notNull().default(1),
  /** 最近更新时间：UTC ISO 字符串 */
  updatedAt: text("updated_at").notNull(),
  /** 软删时间：UTC ISO 字符串；未删除为 NULL（题目只软删，见 db-change 红线） */
  deletedAt: text("deleted_at"),
});

/** 知识考点表。同名考点全局归一复用（knowledge 属性按 name 匹配）。 */
export const knowledgePoints = sqliteTable("knowledge_points", {
  /** 主键：crypto.randomUUID()（§0.3 主键约定） */
  id: text("id").primaryKey(),
  /** 考点名（全局唯一） */
  name: text("name").notNull().unique(),
});

/** 题目 ↔ 考点关联表（多对多）。导入时全量替换该题的关联。 */
export const questionKnowledge = sqliteTable(
  "question_knowledge",
  {
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id),
    knowledgePointId: text("knowledge_point_id")
      .notNull()
      .references(() => knowledgePoints.id),
  },
  (table) => [
    primaryKey({ columns: [table.questionId, table.knowledgePointId] }),
  ],
);

/**
 * 导入留档表——原始 Markdown 留档，可追溯可重导（§5.2）。
 * rawMd 存老师提交的原文（v1 文档存 v1 原文，不存转换后的 v2 文本）；
 * reportJson 为本次导入统计报告（importCommitDataSchema 序列化）。
 */
export const imports = sqliteTable("imports", {
  /** 主键：crypto.randomUUID()（§0.3 主键约定；即响应中的 importId） */
  id: text("id").primaryKey(),
  /** 导入时的文件名（前端展示用） */
  filename: text("filename").notNull(),
  /** 文档类型（解析出的 frontmatter kind；缺 frontmatter 的兜底为 practice） */
  kind: text("kind").$type<DocumentKind>().notNull(),
  /** 原始 Markdown（v1 原样留档） */
  rawMd: text("raw_md").notNull(),
  /** 导入统计报告 JSON */
  reportJson: text("report_json").notNull(),
  /** 导入时间：UTC ISO 字符串 */
  createdAt: text("created_at").notNull(),
});

/** courses 表行类型（SELECT 结果） */
export type Course = typeof courses.$inferSelect;
/** courses 表插入类型 */
export type NewCourse = typeof courses.$inferInsert;
/** lectures 表行类型（SELECT 结果） */
export type Lecture = typeof lectures.$inferSelect;
/** lectures 表插入类型 */
export type NewLecture = typeof lectures.$inferInsert;
/** units 表行类型（SELECT 结果） */
export type Unit = typeof units.$inferSelect;
/** units 表插入类型 */
export type NewUnit = typeof units.$inferInsert;
/** questions 表行类型（SELECT 结果） */
export type Question = typeof questions.$inferSelect;
/** questions 表插入类型 */
export type NewQuestion = typeof questions.$inferInsert;
/** knowledge_points 表行类型（SELECT 结果） */
export type KnowledgePoint = typeof knowledgePoints.$inferSelect;
/** knowledge_points 表插入类型 */
export type NewKnowledgePoint = typeof knowledgePoints.$inferInsert;
/** question_knowledge 表行类型（SELECT 结果） */
export type QuestionKnowledge = typeof questionKnowledge.$inferSelect;
/** question_knowledge 表插入类型 */
export type NewQuestionKnowledge = typeof questionKnowledge.$inferInsert;
/** imports 表行类型（SELECT 结果） */
export type Import = typeof imports.$inferSelect;
/** imports 表插入类型 */
export type NewImport = typeof imports.$inferInsert;
