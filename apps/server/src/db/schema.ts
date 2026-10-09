import type {
  AnnotationBaseState,
  AnnotationPhase,
  AttemptStatus,
  DocumentKind,
  NoteImageSpec,
  NoteImageState,
  NotePhase,
  NoteSubmissionEvidenceState,
  QuestionType,
} from "@tutor/contract";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * 数据库表定义（Drizzle / SQLite）。表结构以架构文档 §5.2 数据模型为准，
 * T0.5 建 teachers、sessions；T1.9 追加 login_failures（登录限流，§5.7）；
 * T1.10 追加内容七表：courses、lectures、units、questions、knowledge_points、
 * question_knowledge、imports（内容存储与导入）；T2.1 追加 students（学生账号与两种登录）；
 * T2.2 追加 assignments、assignment_students（作业与指派名单，软删语义）；
 * T2.6 追加 attempts、responses（作答生命周期：一次作答 + 逐题响应快照）；
 * T2.8 追加 ink（手写笔迹元数据；笔迹本体是 DATA_DIR/blobs 下的文件，不进库）；
 * T2.10 追加 events（学习痕迹事件，追加写；每题有效用时由服务端按事件计算）。
 * Phase 2A（T2A.1）资源库 + 课程目录重构：追加 library_folders（资源库一级文件夹，D2）、
 * course_items（课程目录条目，D6）、course_students（课程成员，D7）、data_migrations
 * （D23 数据搬迁幂等标记）；lectures/units 加 folderId 与 deletedAt（D3 软删），
 * courseId 废弃（保留列不再读写，@deprecated T2A）；courses 加 archivedAt/description（D4）。
 * T2A.7 作业改造：追加 assignment_units（D12 作业内容 = 有序多个练习单元）；
 * assignments 加 courseId（D13 可选所属课程）、unitId 废弃改可空；assignment_students
 * 加 addedAt / removedAt（D13 名单增删、移出行保留以追溯）。
 * T2B.1 多教师基础结构：teachers 加 loginName（唯一索引）/isAdmin/disabledAt（D1）；
 * 根表（students、courses、library_folders、lectures、units、questions、imports、
 * assignments、question_knowledge）加 teacherId 归属列（D9：DB 可空、代码恒写非空）；
 * units/questions 主键改 (teacherId, id)、question_knowledge 主键改
 * (teacherId, questionId, knowledgePointId)（D10/D11，表重建）；D10 清单内全部
 * 指向 units/questions 的外键去除（值不变，子表表重建）。
 * T2B.6 追加 app_settings（应用设置 KV：注册开关 allowRegistration，D8）。
 * T6R.2 追加题目草稿四表：notes（当前头）、note_versions（不可变正文）、
 * note_images（派生图）、submission_evidence（逐题提交证据）——方案见
 * docs/题目草稿功能方案.md §5；契约见 packages/contract/src/note.ts。
 * T6R.20 追加题干标注两表：annotation_bases（固定底图，身份三要素）、
 * annotations（标注当前头，CAS revision）——方案见同文档 §10；契约见
 * packages/contract/src/annotation.ts。
 *
 * 全库约定（见 docs/开发任务清单.md §0.3 与 db-change 技能）：
 * - 主键 id 一律为应用层生成的 crypto.randomUUID() 字符串；
 *   例外：units/questions 的 id 来自 DSL（题目/单元 id 由文档声明，编辑保持不变，§0.3）；
 * - 时间统一存 UTC ISO 字符串（new Date().toISOString()），不用时间戳数字；
 * - 表名/列名 snake_case，TS 属性名 camelCase。
 */

/**
 * 教师表——T2B.1 起为多教师基础结构（D1 单表多角色：管理员 = isAdmin 的教师）。
 * 首位教师由首启 setup 创建（T2B.1 写 loginName='teacher'、isAdmin=true；T2B.2 起
 * 表单带登录名）；存量部署唯一的教师行由 T2B.1 回填自动升级（D4）。
 */
export const teachers = sqliteTable(
  "teachers",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /**
     * 登录名（D2：全局唯一，字符集中文/字母/数字/下划线/连字符，长度 2–32，
     * 契约校验在 T2B.2 落地）。列可空仅因迁移加列无法在 DDL 内回填（D9 同款口径）：
     * 存量行由 T2B.1 回填写 'teacher'，此后各创建入口恒写非空，读侧可视为必有。
     */
    loginName: text("login_name"),
    /** 是否管理员（D1）：管理员可兼任全部教师功能并进管理端（T2B.6）；默认 false */
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    /** 禁用时间（D5）：NULL = 未禁用；置值即禁用（会话立即失效、数据全保留、可再启用） */
    disabledAt: text("disabled_at"),
    /** 登录密码的 scrypt 哈希；设置密码前为 NULL */
    passwordHash: text("password_hash"),
    /** MCP / 脚本调用用的 API Token（T4.6 起启用，D22：randomBytes(32) base64url，
     *  每教师一份、可重置；未生成时为 NULL。唯一索引允许多个 NULL（存量行不冲突）） */
    apiToken: text("api_token"),
    /**
     * 辅助能力启用集 JSON（T7.7 / 方案 §4.5）：capabilityProfileSchema 形态
     * （{"enabledCapabilities":[…]}，值为 steps/ink 子集）。NULL = 未配置 =
     * 全启用（缺省语义，存量行无需回填）；空数组 = 显式全关。学生端 attempt/
     * 讲义读取接口按本列计算有效启用集下发；开关只影响辅助入口渲染，不是
     * 安全边界。
     */
    capabilityProfileJson: text("capability_profile_json"),
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
 * 应用设置表（T2B.6，D8）——两列 KV，本阶段仅一个键 allowRegistration
 * （'true' / 'false' 字符串布尔，默认 'true'，管理员经 /api/admin/settings 读写）。
 * 初始键不写进迁移文件：由 migrate.ts 流程内的回填以代码插入（标记防重跑，
 * onConflictDoNothing 兜底——管理员改过的值不会被启动回填覆盖）。
 */
export const appSettings = sqliteTable("app_settings", {
  /** 设置键（主键），如 allowRegistration */
  key: text("key").primaryKey(),
  /** 设置值（字符串；布尔语义由服务层解析） */
  value: text("value").notNull(),
});

/** app_settings 表行类型（SELECT 结果） */
export type AppSetting = typeof appSettings.$inferSelect;
/** app_settings 表插入类型 */
export type NewAppSetting = typeof appSettings.$inferInsert;

/**
 * 学生表（T2.1，§5.2）。一位老师多名学生；两种登录方式并存（§5.7）：
 * - loginName 全局唯一（默认等于姓名，重名时教师改「张三2」之类）；
 * - passwordHash 可空：只开专属链接、未设密码的学生为 NULL；
 * - linkToken 全局唯一：专属链接 /s/<token> 的随机令牌，重置后旧链接立即失效；
 * - linkEnabled / passwordEnabled：教师可对单个学生分别开关两种方式；
 * - archivedAt：归档（软删除语义）——不出现在默认列表、两种登录都拒绝。
 */
export const students = sqliteTable(
  "students",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /**
     * 归属教师（teachers.id，D14：一生只归一位教师，创建时写入）。
     * 列可空（D9 历史形态），代码层恒写非空，读侧可视为必有。
     * 不建外键（与 sessions.subjectId 同口径：教师数据永不连带删除）。
     */
    teacherId: text("teacher_id"),
    /** 显示姓名 */
    displayName: text("display_name").notNull(),
    /** 登录名（密码登录用；全局唯一，大小写敏感精确匹配） */
    loginName: text("login_name").notNull().unique(),
    /** 密码 scrypt 哈希；未设密码为 NULL */
    passwordHash: text("password_hash"),
    /** 专属链接令牌（base64url 随机串；全局唯一，重置即更换） */
    linkToken: text("link_token").notNull().unique(),
    /** 专属链接登录是否开启 */
    linkEnabled: integer("link_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    /** 密码登录是否开启 */
    passwordEnabled: integer("password_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 教师备注；未填为 NULL */
    note: text("note"),
    /** 归档时间：UTC ISO 字符串；未归档为 NULL（归档 = 软删除，不物理 DELETE） */
    archivedAt: text("archived_at"),
    /** 创建时间：UTC ISO 字符串 */
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("students_teacher_idx").on(table.teacherId)],
);

/** students 表行类型（SELECT 结果） */
export type Student = typeof students.$inferSelect;
/** students 表插入类型 */
export type NewStudent = typeof students.$inferInsert;

/**
 * 资源库文件夹表（T2A.1，D2）——讲义库与题库的一级分组，不可嵌套。
 * 「未归类」不是行，而是 folderId = NULL 的语义（不可删、不可改名）；
 * 删除文件夹时其内容移入未归类（服务层先把 lecture/unit 的 folderId 置 NULL）。
 * name 不设唯一约束（清单 §3 未要求）；同名复用场景按 (name, order) 取首个。
 */
export const libraryFolders = sqliteTable(
  "library_folders",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /**
     * 归属教师（D9：DB 可空、代码恒写非空——迁移加列回填口径同 students.teacherId）。
     * 资源库为域内私有（T2B.3 起按教师过滤）。
     */
    teacherId: text("teacher_id"),
    /** 文件夹名（同名校验由应用层处理，见 D2/清单 §3） */
    name: text("name").notNull(),
    /** 同级排序（小在前） */
    order: integer("order").notNull(),
    /** 创建时间：UTC ISO 字符串 */
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("library_folders_teacher_idx").on(table.teacherId)],
);

/**
 * 数据搬迁标记表（T2A.1，D23）——应用启动时数据回填的幂等完成标记。
 * drizzle 迁移只做 DDL；DML 回填以代码执行（src/db/backfill.ts），
 * 每个回填步骤组对应一个 key，执行成功后在同一事务写入本表防重跑。
 */
export const dataMigrations = sqliteTable("data_migrations", {
  /** 回填标识（如 t2a1_library_courses_backfill） */
  key: text("key").primaryKey(),
  /** 完成时间：UTC ISO 字符串 */
  appliedAt: text("applied_at").notNull(),
});

/**
 * 课程表——可选的组织层（如「初一上」，§5.2）。导入未指定 courseId 时落到系统默认课程
 * （title='默认课程'，不存在则由 ContentService 自动创建）。
 * Phase 2A 起课程 = 一份有序目录（course_items）+ 成员（course_students）；
 * 「默认课程」按普通课程处理（D23-7，教师可改名/归档）。
 */
export const courses = sqliteTable(
  "courses",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /**
     * 归属教师（D9：DB 可空、代码恒写非空）。课程与作业为域内私有（T2B.4 起按教师过滤）。
     */
    teacherId: text("teacher_id"),
    /** 课程名；默认课程固定「默认课程」（同名复用） */
    title: text("title").notNull(),
    /** 同级排序（小在前）；首个课程为 0 */
    order: integer("order").notNull(),
    /** 归档时间：UTC ISO 字符串；未归档为 NULL（D4：归档后学生端不可见，可恢复） */
    archivedAt: text("archived_at"),
    /** 课程简介；未填为 NULL */
    description: text("description"),
    /** 创建时间：UTC ISO 字符串 */
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("courses_teacher_idx").on(table.teacherId)],
);

/**
 * 讲义表。markdown 保存讲义原文（§5.1.1(4) 原文是真相），目录等结构化数据渲染时再解析。
 * Phase 2A 起归属资源库：folderId 组织（NULL = 未归类）、deletedAt 软删进回收站（D3）；
 * 课程引用改走 course_items（kind='lecture'）。
 */
export const lectures = sqliteTable(
  "lectures",
  {
    /** 主键：crypto.randomUUID()（讲义 id 在导入时生成，DSL 不声明） */
    id: text("id").primaryKey(),
    /** 归属教师（D9：DB 可空、代码恒写非空；讲义库域内私有） */
    teacherId: text("teacher_id"),
    /**
     * @deprecated T2A 归属改 folderId（资源库）；列保留不删（Phase 3 后统一清理），
     * 新代码不再读写。已改可空并去掉外键（D4：删除/归档课程不影响资源库内容）。
     */
    courseId: text("course_id"),
    /** 资源库文件夹（library_folders.id）；NULL = 未归类 */
    folderId: text("folder_id").references(() => libraryFolders.id),
    /** 讲义标题（H1 标题文本，导入匹配键） */
    title: text("title").notNull(),
    /** 讲义原始 Markdown（含 H1 标题行） */
    markdown: text("markdown").notNull(),
    /** 课程内排序（小在前）；@deprecated T2A 展示顺序改 course_items.order */
    order: integer("order").notNull(),
    /** 最近更新时间：UTC ISO 字符串 */
    updatedAt: text("updated_at").notNull(),
    /** 软删时间：UTC ISO 字符串；未删除为 NULL（D3：软删进回收站，可恢复） */
    deletedAt: text("deleted_at"),
  },
  (table) => [index("lectures_teacher_idx").on(table.teacherId)],
);

/**
 * 练习单元表。id 来自 DSL（frontmatter unit），编辑内容时 id 不变；
 * 导入按 (teacherId, unit.id) 匹配合并（D13 域内匹配，更新 title/topic/lectureId）。
 * T2B.1 起主键改 (teacherId, id)（D10）：两位教师各持同 id 单元合法；**所有指向
 * units(id) 的外键已全部去除**（SQLite 外键必须引用完整唯一键组，见 D10 清单），
 * 域一致性由服务层保证。
 * Phase 2A 起归属资源库：folderId 组织、deletedAt 软删（D3）；课程引用改走
 * course_items（kind='unit'）；lectureId 语义为「配套讲义」（D8，列不变）。
 */
export const units = sqliteTable(
  "units",
  {
    /** 单元 id：来自 DSL（§0.3 主键约定例外），与 teacherId 组成复合主键 */
    id: text("id").notNull(),
    /**
     * 归属教师（复合主键组成部分；D9：DB 可空、代码恒写非空，回填与创建入口
     * 均写非空值，读侧可视为必有）。
     */
    teacherId: text("teacher_id"),
    /**
     * @deprecated T2A 归属改 folderId（资源库）；列保留不删（Phase 3 后统一清理），
     * 新代码不再读写。已改可空并去掉外键（D4：删除/归档课程不影响资源库内容）。
     */
    courseId: text("course_id"),
    /** 资源库文件夹（library_folders.id）；NULL = 未归类 */
    folderId: text("folder_id").references(() => libraryFolders.id),
    /**
     * 配套讲义（lectures.id，D8）：在课程中添加讲义时可一并添加配套练习；
     * 学生阅读讲义页底部显示「本课配套练习」。无配套为 NULL。
     */
    lectureId: text("lecture_id").references(() => lectures.id),
    /** 单元标题 */
    title: text("title").notNull(),
    /** 主题（frontmatter topic；未标注为 NULL） */
    topic: text("topic"),
    /** 课程内排序（小在前）；@deprecated T2A 展示顺序改 course_items.order */
    order: integer("order").notNull(),
    /** 最近更新时间：UTC ISO 字符串 */
    updatedAt: text("updated_at").notNull(),
    /** 软删时间：UTC ISO 字符串；未删除为 NULL（D3：软删进回收站，可恢复） */
    deletedAt: text("deleted_at"),
  },
  (table) => [primaryKey({ columns: [table.teacherId, table.id] })],
);

/**
 * 课程目录条目表（T2A.1，D6）——课程的有序目录：分节标题 / 讲义引用 / 练习单元引用。
 * - 引用而非复制（D1）：只存 refId，资源库改动全课程即时生效；
 * - kind='section' 时 refId 为 NULL、title 必填；lecture/unit 时 refId 必填、
 *   title 为 NULL（标题取资源当前值）；
 * - 唯一约束 (courseId, kind, refId)：同一资源在同一课程只能出现一次。
 *   SQLite 对含 NULL 的唯一键不判重 → section（refId=NULL）多条合法（期望行为，
 *   同名分节如需限制在应用层校验）；重复添加 lecture/unit 由服务层返回
 *   409 DUPLICATE_COURSE_ITEM；
 * - visible/publishAt（D5）：条目级可见性；新添加默认 visible=true。
 */
export const courseItems = sqliteTable(
  "course_items",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 所属课程（courses.id） */
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id),
    /** 条目类型：section=分节标题 / lecture=讲义 / unit=练习单元 */
    kind: text("kind").$type<"section" | "lecture" | "unit">().notNull(),
    /** 引用资源 id（lectures.id / units.id）；section 为 NULL */
    refId: text("ref_id"),
    /** 分节标题（仅 kind='section' 使用）；其余为 NULL */
    title: text("title"),
    /** 课程内排序（小在前；同课程内全 kind 共用一个序列） */
    order: integer("order").notNull(),
    /** 是否对学生可见（D5 条件之一；新添加默认 true，D6） */
    visible: integer("visible", { mode: "boolean" }).notNull().default(true),
    /** 定时发布时间：UTC ISO 字符串；NULL = 不定时（D5：publishAt ≤ 现在才可见） */
    publishAt: text("publish_at"),
    /** 创建时间：UTC ISO 字符串 */
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // 同一资源在同一课程唯一（section refId=NULL 不受约束，多条合法，见表注释）
    uniqueIndex("course_items_course_kind_ref_uk").on(
      table.courseId,
      table.kind,
      table.refId,
    ),
  ],
);

/**
 * 课程成员表（T2A.1，D7）——只由教师添加/移出；复合主键 (courseId, studentId)。
 * 移出成员 = 删除本表行（已交卷的课程练习记录保留在 attempts，属 T2A.6 语义）。
 */
export const courseStudents = sqliteTable(
  "course_students",
  {
    /** 所属课程（courses.id） */
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id),
    /** 成员学生（students.id） */
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    /** 加入时间：UTC ISO 字符串 */
    joinedAt: text("joined_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.courseId, table.studentId] })],
);

/**
 * 题目表（结构化字段 = 判分与统计必需的抽取结果，§5.1.1(4)）。
 * - id 来自 DSL（题目指令 id 属性 / 缺省 `单元slug-序号`），T2B.1 起主键改
 *   (teacherId, id)（D10）：两位教师各持同 id 题目合法（域内唯一）；
 *   跨单元同 id 的导入在**本教师域内**按「更新」处理（unitId 随之更新）；
 * - unitId 值不变但**外键已去除**（D10：units 主键改复合后子表外键必须拆），
 *   域一致性由服务层保证；
 * - version：内容更新计数，同 id 再导入 +1（历史作答经快照不受影响）；
 * - deletedAt：软删（db-change 红线：题目不物理删除）；软删后同 id 再导入视为恢复。
 */
export const questions = sqliteTable(
  "questions",
  {
    /** 题目 id：来自 DSL（§0.3 主键约定例外），与 teacherId 组成复合主键 */
    id: text("id").notNull(),
    /** 归属教师（复合主键组成部分；D9：DB 可空、代码恒写非空） */
    teacherId: text("teacher_id"),
    /** 所属单元（units.id；D10 起无外键，值域一致性由服务层保证） */
    unitId: text("unit_id").notNull(),
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
  },
  (table) => [primaryKey({ columns: [table.teacherId, table.id] })],
);

/** 知识考点表。同名考点全局归一复用（knowledge 属性按 name 匹配）。 */
export const knowledgePoints = sqliteTable("knowledge_points", {
  /** 主键：crypto.randomUUID()（§0.3 主键约定） */
  id: text("id").primaryKey(),
  /** 考点名（全局唯一） */
  name: text("name").notNull().unique(),
});

/**
 * 题目 ↔ 考点关联表（多对多）。导入时全量替换该题的关联。
 * T2B.1（D11）：考点保持全局共享（knowledge_points 不加 teacherId），本表主键改
 * (teacherId, questionId, knowledgePointId)——两位教师各自维护同 id 题目的考点关联
 * 互不覆盖；questionId 值不变但外键已去除（D10：questions 主键改复合后必须拆）。
 */
export const questionKnowledge = sqliteTable(
  "question_knowledge",
  {
    /** 归属教师（复合主键组成部分；D9：DB 可空、代码恒写非空，与题目同行同值） */
    teacherId: text("teacher_id"),
    /** 题目（questions.id；D10 起无外键） */
    questionId: text("question_id").notNull(),
    knowledgePointId: text("knowledge_point_id")
      .notNull()
      .references(() => knowledgePoints.id),
  },
  (table) => [
    primaryKey({
      columns: [table.teacherId, table.questionId, table.knowledgePointId],
    }),
  ],
);

/**
 * 导入留档表——原始 Markdown 留档，可追溯可重导（§5.2）。
 * rawMd 存老师提交的原文；
 * reportJson 为本次导入统计报告（importCommitDataSchema 序列化）。
 * T2A.3 扩展（D17/D20）：sourcePath = 批量导入的相对路径；batchId = 批次 id
 * （前端生成、逐文件 commit 携带，GET /import/batches/:batchId 回看）；
 * folderId = 实际落库的目标文件夹（NULL = 未归类）。
 */
export const imports = sqliteTable(
  "imports",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定；即响应中的 importId） */
    id: text("id").primaryKey(),
    /** 归属教师（D9：DB 可空、代码恒写非空；导入留档域内私有） */
    teacherId: text("teacher_id"),
    /** 导入时的文件名（前端展示用） */
    filename: text("filename").notNull(),
    /** 文档类型（解析出的 frontmatter kind；缺 frontmatter 的兜底为 practice） */
    kind: text("kind").$type<DocumentKind>().notNull(),
    /** 原始 Markdown 原样留档 */
    rawMd: text("raw_md").notNull(),
    /** 导入统计报告 JSON */
    reportJson: text("report_json").notNull(),
    /** 批量导入的文件相对路径（如 "chapter1/练习.md"）；单文件导入为 NULL */
    sourcePath: text("source_path"),
    /** 批量导入批次 id（crypto.randomUUID，前端生成）；单文件导入为 NULL */
    batchId: text("batch_id"),
    /** 实际落库的目标文件夹（library_folders.id）；NULL = 未归类 */
    folderId: text("folder_id").references(() => libraryFolders.id),
    /** 导入时间：UTC ISO 字符串 */
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("imports_teacher_idx").on(table.teacherId)],
);

/**
 * 作业表（T2.2，§5.2）——"布置作业"，才能回答"谁做了/没做"。
 * - 一条作业 = 一组练习单元发给若干学生的一次练习（单元在 assignment_units、
 *   名单在 assignment_students，T2A.7/D12/D13）；
 * - title 缺省用布置时的单元标题（快照语义，不随单元后续改名联动）；
 * - courseId（T2A.7，D13）：可选所属课程——布置时若选课程，名单默认带出布置时刻
 *   全部课程成员（保存即独立快照，此后课程成员变化不自动影响本作业）；
 * - deletedAt：软删（db-change 红线：删除作业不删除已有作答记录——attempts 通过
 *   assignmentId 关联历史，物理删除会破坏"谁做了/没做"统计；T2.6 起作答经
 *   快照照常回看）。软删后学生端立即不可见、教师列表默认不显示。
 */
export const assignments = sqliteTable(
  "assignments",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 归属教师（D9：DB 可空、代码恒写非空；作业域内私有） */
    teacherId: text("teacher_id"),
    /**
     * @deprecated T2A 多单元改走 assignment_units（D12）；旧值保留不改（历史语义 =
     * 当时布置的单个单元，D23-5 回填进 assignment_units）。新代码不再写入，
     * 新多单元作业本列为 NULL——与 NOT NULL 约束冲突，故放开可空。
     * T2B.1（D10）：外键已去除（units 主键改复合），值不变。
     */
    /**
     * @deprecated T2A 多单元改走 assignment_units（D12）；旧值保留不改（历史语义 =
     * 当时布置的单个单元，D23-5 回填进 assignment_units）。新代码不再写入，
     * 新多单元作业本列为 NULL——与 NOT NULL 约束冲突，故放开可空。
     */
    unitId: text("unit_id"),
    /** 所属课程（courses.id，T2A.7/D13）：可空（作业可不挂课程）；布置时快照语义见表注释 */
    courseId: text("course_id").references(() => courses.id),
    /** 作业标题；缺省为布置时的单元标题 */
    title: text("title").notNull(),
    /** 截止时间：UTC ISO 字符串；未设置为 NULL（PATCH 显式置 null = 取消截止） */
    dueAt: text("due_at"),
    /**
     * 答案公布时机（T2A.8，D11）：on_submit=交卷即公布（默认，旧数据同语义，无需回填）；
     * after_due=截止后公布——服务层强制要求 dueAt 非空（create 缺 dueAt / PATCH 取消
     * 截止时为 after_due → 400，防「永不公布」死锁态）。公布与否在读结果视图时
     * 比较 dueAt 与当前时间（无定时任务）；course 来源作答不适用本字段（恒交卷即公布）。
     */
    answerRelease: text("answer_release")
      .$type<"on_submit" | "after_due">()
      .notNull()
      .default("on_submit"),
    /** 删除时间：UTC ISO 字符串；未删除为 NULL（软删，作答保留） */
    deletedAt: text("deleted_at"),
    /** 创建时间：UTC ISO 字符串 */
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("assignments_teacher_idx").on(table.teacherId)],
);

/**
 * 作业单元关联表（T2A.7，D12/D16）——作业内容 = 有序的多个练习单元。
 * - 复合主键 (assignmentId, unitId)：同一作业中单元不可重复（服务层返回
 *   400 DUPLICATE_UNIT；旧作业经 D23-5 回填每作业恰一行 order=0）；
 * - order：同作业内排序（小在前），布置时按教师确认的顺序写入，答题页按此分节；
 * - D16：单元软删（units.deletedAt 置值）不删本表行——作业照常可作答，
 *   卡片显示「含已删除单元」提示。
 */
export const assignmentUnits = sqliteTable(
  "assignment_units",
  {
    /** 所属作业（assignments.id） */
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id),
    /** 练习单元（units.id，来自 DSL；T2B.1/D10 起无外键，值不变） */
    unitId: text("unit_id").notNull(),
    /** 同作业内排序（小在前） */
    order: integer("order").notNull(),
  },
  (table) => [primaryKey({ columns: [table.assignmentId, table.unitId] })],
);

/**
 * 作业 ↔ 学生关联表（多对多，§5.2）：复合主键 (assignmentId, studentId)。
 * T2A.7（D13）起名单改为「增删式」维护：移出学生 = 置 removedAt（行保留以追溯
 * 历史指派与已交卷记录），再添加 = 置回 null（行复用，addedAt 刷新）；
 * 在名单中 = removedAt IS NULL。不做级联删除——作业走软删（deletedAt），
 * 关联行保留即可判定历史指派关系。
 */
export const assignmentStudents = sqliteTable(
  "assignment_students",
  {
    /** 所属作业（assignments.id） */
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id),
    /** 被指派学生（students.id） */
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    /**
     * 加入名单时间：UTC ISO 字符串。列可空仅因 SQLite 加 NOT NULL 列需重建表
     * （D23 迁移代价），代码层（T2A.7 服务与 D23-5 回填）恒写非空值，读侧可视为必有。
     */
    addedAt: text("added_at"),
    /**
     * 移出名单时间：UTC ISO 字符串；NULL = 在名单中（D13：移出 = 置值不删行，
     * 保留追溯；再添加 = 置回 null）。
     */
    removedAt: text("removed_at"),
  },
  (table) => [primaryKey({ columns: [table.assignmentId, table.studentId] })],
);

/**
 * 作答表（T2.6，§5.2；T2A.6 扩展作答来源 D9；2026-10 增 wrong 来源）——一次完整作答。
 * - sourceType（D9）：assignment=作业作答（记 assignmentId）/ course=课程练习
 *   （记 courseId + unitId，可重做，attemptNo 递增）/ wrong=错题重练（2026-10，
 *   三归属键恒 null、永不失权；题目集合与快照在该 attempt 自己的 responses 行，
 *   创建时按组卷顺序冻结）。三种来源共用同一套作答接口（判分/快照/提示/笔迹/
 *   事件全按 attemptId 工作）；
 * - status：draft=进行中（草稿）、submitted=已交卷（存在待批题，等教师批改）、
 *   graded=已批改（= 全部 finalCorrect 非 null；全客观题卷交卷即 graded，D2/D3，
 *   T3.2a）；
 * - T6R.3 起三来源统一**建卷冻结**：题目集合、题序与完整快照在创建 attempt 时
 *   逐题预插入该 attempt 自己的 responses 行（frozenAt 记冻结时刻），此后取卷/
 *   草稿/提示/判分/结果/导出一律读冻结行，教师改题库只影响之后新建的卷；
 *   unitId 仍记录作答期间的题目来源单元（course 必填；assignment 来源保留布置
 *   时作业的历史值，D23-6 原值不改）；
 * - attemptNo（D10）：course 来源同一 (学生, 课程, 单元) 从 1 递增；
 *   assignment 来源恒 1（一个作业一人一份，不重做）；wrong 来源按该生已有
 *   wrong 来源 attempt 数从 1 递增（每次重练都是新卷）；
 * - activeSec / device / scoreFinal 为 T2.10 / T2.10 / T3.2 预留列（建列不启用）。
 */
export const attempts = sqliteTable(
  "attempts",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 作答学生（students.id） */
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    /** 作答来源（D9 + 2026-10 wrong）：assignment | course | wrong */
    sourceType: text("source_type")
      .$type<"assignment" | "course" | "wrong">()
      .notNull()
      .default("assignment"),
    /**
     * 所属作业（assignments.id；作答记录不随作业软删消失，§5.2 删除作业不删作答）。
     * course 来源为 null（T2A.6 起可空）。
     */
    assignmentId: text("assignment_id").references(() => assignments.id),
    /**
     * 课程练习所属课程（courses.id）；course 来源必填，assignment 来源为 null
     * （T2A.7 起可填作业所属课程）。D4：删除课程前校验无关联作答。
     */
    courseId: text("course_id").references(() => courses.id),
    /** 目标练习单元（units.id，来自 DSL；T2A.7 起 assignment 来源为快照语义；
     *  T2B.1/D10 起无外键，值不变） */
    unitId: text("unit_id"),
    /** 第几次作答（D10：course 来源从 1 递增；assignment 来源恒 1） */
    attemptNo: integer("attempt_no").notNull().default(1),
    /** 作答状态：draft | submitted | graded */
    status: text("status").$type<AttemptStatus>().notNull(),
    /** 开始作答时间：UTC ISO 字符串 */
    startedAt: text("started_at").notNull(),
    /** 交卷时间：UTC ISO 字符串；未交为 NULL */
    submittedAt: text("submitted_at"),
    /**
     * 题目集合冻结时刻（T6R.3 全来源冻结）：UTC ISO。建卷（三来源）时与
     * startedAt 同值写入；NULL = 尚未冻结，仅两类行：升级前遗留的进行中
     * attempt（首次恢复访问时由 attempt-service 的 ensureAttemptFrozen 懒冻结
     * 补写）与升级前已交卷的 attempt（沿用交卷快照，永不补冻结——读路径对
     * 已交卷直接读 responses 行，不依赖本列）。冻结后题目集合/题序/内容以
     * 本 attempt 的 responses 行为唯一口径，不再读当前题库。
     */
    frozenAt: text("frozen_at"),
    /** 有效作答用时（秒；T2.10 由服务端按事件计算回写）；未计算为 NULL */
    activeSec: integer("active_sec"),
    /** 作答设备标识（T2.10 事件采集预留）；未记录为 NULL */
    device: text("device"),
    /** 自动判分得分（0–100 整数百分比 = 答对数/可自动判分数；D1 后未作答客观题进分母）；无可判分为 NULL */
    scoreAuto: integer("score_auto"),
    /** 最终得分（D2：round(finalCorrect=true 题数/全部题数×100)；T3.2a 起交卷时全非 null 即写入）；未批为 NULL */
    scoreFinal: integer("score_final"),
    /**
     * 冻结来源不可信标记（T6R.3，方案 §5.1「legacy_unverified」）：true = 本卷
     * 快照是升级后首次恢复访问时懒冻结的当前版本，不能宣称是学生更早看到的
     * 内容；false = 建卷即冻结（可信）。草稿视图透传给前端展示提示。
     */
    legacyUnverified: integer("legacy_unverified", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    // 「一个作业一人一份进行中」的查询索引；唯一性由服务层保证（先查后插，
    // better-sqlite3 同步单进程无并发竞态），不建 partial unique index 以保迁移简单
    index("attempts_student_assignment_idx").on(
      table.studentId,
      table.assignmentId,
    ),
    // 课程练习「同一 (学生, 课程, 单元)」历次查询索引（T2A.6，§3）；
    // 「同时最多 1 份未交卷」由服务层事务先查后插保证
    index("attempts_student_course_unit_idx").on(
      table.studentId,
      table.courseId,
      table.unitId,
    ),
  ],
);

/**
 * 逐题响应表（T2.6，§5.2；T6R.3 起三来源建卷冻结）——一行 = 一道题的作答与判定。
 * - (attemptId, questionId) 唯一：建卷时逐题预插入（携带冻结快照），草稿阶段
 *   upsert（answerJson/changeCount 累加），交卷时**原行更新**判分结果（行 id
 *   不变——id 即对外下发的 questionRevisionId，T6R.3，冻结/判分/交卷回传同源）；
 * - questionSnapshotJson：**建卷时冻结**的完整 Question 序列化（contract
 *   questionSchema）。此后老师编辑/软删题目（version+1）不影响本次作答的显示、
 *   提示、判分与结果回看（T6R.3 验收项）。NULL 仅存在于升级遗留行：升级前
 *   进行中的 attempt 首次恢复访问时由懒冻结补写（快照存在/未软删的题），
 *   软删/缺失的题保留 NULL = 「历史题目缺失」，不拿当前题库回填伪造；
 *   升级前已交卷的行沿用交卷时快照，不重写；
 * - 题目顺序：建卷插入序（rowid 升序 = 组卷题序）。建卷即冻结的卷（三来源，
 *   行带冻结 unitId）分组与组内序**完全从冻结行自身重建**（unitId 首现序分组
 *   + rowid 组内序，教师重排/移单元不影响）；懒冻结的存量卷与升级前已交卷的
 *   遗留行沿用 questions 域内 join 提供归属与展示序（口径见 attempt-service
 *   的 frozenRowsInDisplayOrder）。**不要对该表做整卷 DELETE/重插**（会破坏
 *   题序，也会改写 questionRevisionId 的稳定引用）；
 * - autoCorrect：服务端判分 true/false；NULL = 不能自动判定（D1 后仅：手写题
 *   未能自动判〔未作答/只写笔迹〕、题目无标准答案、判断题写法无法归一化——
 *   进教师待批队列；未作答客观题为 false）；
 * - finalCorrect / teacherMark / teacherComment：T3.2a 起启用——交卷时同时写
 *   finalCorrect = autoCorrect（D3），待批题 ≡ finalCorrect IS NULL 且快照
 *   非空（D4 共享谓词；T6R.3 起叠加快照非空——排除「历史题目缺失」的幽灵行，
 *   它们不进判分/视图/待批队列，见 pending-mark.ts）；teacherMark /
 *   teacherComment 留待 T3.2b 批注链路写入。
 */
export const responses = sqliteTable(
  "responses",
  {
    /**
     * 主键：crypto.randomUUID()（§0.3 主键约定）。T6R.3 起兼作对外下发的
     * questionRevisionId（学生对每题看到的不透明版本引用；建卷铸造、交卷回传
     * 比对、笔记/证据关联同源，见 contract attempt.ts questionRevisionIdSchema）。
     */
    id: text("id").primaryKey(),
    /** 所属作答（attempts.id） */
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    /** 题目（questions.id，来自 DSL；T2B.1/D10 起无外键，值不变） */
    questionId: text("question_id").notNull(),
    /**
     * 冻结时刻的单元归属（T6R.3）：建卷/懒冻结时随快照一并写入——分组与
     * 展示序全部从冻结行自身重建（unit_id 首现序分组 + rowid 组内序，即建卷
     * 组卷序），教师此后重排/移单元不影响进行中卷的结构。wrong 恒 null
     * （卷无单元语义）；升级前已交卷的遗留行恒 null（沿用交卷快照、读路径
     * 按域内 join 兜底分组，见 attempt-service.frozenRowsInDisplayOrder）。
     */
    unitId: text("unit_id"),
    /**
     * 建卷冻结时的题目内容版本（questions.version；wrong 来源 = 源快照的版本）。
     * 升级遗留的未冻结行为 0（懒冻结补写时更新）。
     */
    questionVersion: integer("question_version").notNull().default(0),
    /**
     * 建卷时冻结的完整题目快照（questionSchema 序列化）。NULL 仅存在于升级
     * 遗留行（懒冻结补写，或软删/缺失题的「历史题目缺失」标记），不回填伪造。
     */
    questionSnapshotJson: text("question_snapshot_json"),
    /** 学生答案（StudentAnswer 序列化）；未作为 NULL（交卷时未答题行也为 NULL） */
    answerJson: text("answer_json"),
    /** 自动判分结果：true/false；NULL = 不能自动判定（D1 后不含未作答客观题） */
    autoCorrect: integer("auto_correct", { mode: "boolean" }),
    /** 最终判定（D3：交卷时写 = autoCorrect，教师批注后 teacherMark 优先）；未批为 NULL，即待批（D4） */
    finalCorrect: integer("final_correct", { mode: "boolean" }),
    /** 教师批注标记（T3.2：正确 | 错误 | null）；未批为 NULL */
    teacherMark: text("teacher_mark"),
    /** 教师评语（T3.2）；未评为 NULL */
    teacherComment: text("teacher_comment"),
    /** 每题有效用时（秒；T2.10 按事件计算回写）；未计算为 NULL */
    activeSec: integer("active_sec"),
    /** 已查看提示数（T2.11：去重后的已解锁序号集合大小；交卷时冻结保留） */
    hintsUsed: integer("hints_used").notNull().default(0),
    /**
     * 已解锁提示序号集合（T2.11，JSON 数组如 "[0,2]"；0 起对齐题目 hintsJson 下标）。
     * 交卷后回看已解锁提示与刷新回显都以此为准；从未解锁为 NULL。
     * 与 hintsUsed 冗余（集合大小）但读路径免解析，写路径同事务维护。
     */
    hintsOpenedJson: text("hints_opened_json"),
    /** 答案保存（改答案）次数：草稿保存一次 +1，T2.10 起与事件交叉校验 */
    changeCount: integer("change_count").notNull().default(0),
    /** 手写笔迹记录 id（ink 表，T2.8 启用）；无笔迹为 NULL */
    inkId: text("ink_id"),
  },
  (table) => [
    // 草稿 upsert 与交卷整行重写的定位键
    uniqueIndex("responses_attempt_question_uk").on(
      table.attemptId,
      table.questionId,
    ),
  ],
);

/**
 * 手写笔迹表（T2.8，§5.2）——一行 = 一份作答里一道题的笔迹元数据。
 * - **笔迹不进数据库、不用 base64**（架构 §5.2 关键设计）：矢量文档与 PNG 快照
 *   以文件形式存 DATA_DIR/blobs/ink/<attemptId>/<安全文件名>.json.gz 与 .png，
 *   库里只存相对路径（strokesPath/pngPath 相对 DATA_DIR，DATA_DIR 迁移不破坏）；
 * - (attemptId, questionId) 唯一：同题再上传走幂等覆盖（文件重写 + 行 upsert，
 *   id 保持不变——教师端 inkId 引用稳定）；
 * - width/height：快照 PNG 的像素尺寸（教师端缩略图布局用）；解析失败为 0；
 * - strokeCount：atrament=data.strokes.length；excalidraw=data.scene.elements.length；
 * - updatedAt：最近一次上传时间（UTC ISO）。responses.inkId 的回填在 T3.1 批改页接入。
 */
export const ink = sqliteTable(
  "ink",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定；教师端 GET /api/teacher/ink/:inkId.png 用） */
    id: text("id").primaryKey(),
    /** 所属作答（attempts.id） */
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    /** 题目（questions.id，来自 DSL；可能含中文/点/连字符；T2B.1/D10 起无外键，值不变） */
    questionId: text("question_id").notNull(),
    /** 矢量文档相对路径（DATA_DIR 内，blobs/ink/<attemptId>/<安全名>.json.gz） */
    strokesPath: text("strokes_path").notNull(),
    /** 快照 PNG 相对路径（DATA_DIR 内，blobs/ink/<attemptId>/<安全名>.png） */
    pngPath: text("png_path").notNull(),
    /** 快照 PNG 像素宽；解析失败为 0 */
    width: integer("width").notNull(),
    /** 快照 PNG 像素高；解析失败为 0 */
    height: integer("height").notNull(),
    /** 笔画数（引擎相关口径，见表注释） */
    strokeCount: integer("stroke_count").notNull(),
    /** 最近上传时间：UTC ISO 字符串 */
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // 同题幂等覆盖的定位键（一个 attempt 一道题一行）
    uniqueIndex("ink_attempt_question_uk").on(
      table.attemptId,
      table.questionId,
    ),
  ],
);

/**
 * 学习痕迹事件表（T2.10，§5.2）——纯追加写（append-only），永不 UPDATE/DELETE。
 * - 事件形状的权威定义在 packages/contract/src/learning-event.ts（契约优先），
 *   本表只存元信息：type + payloadJson（answer_change 存学生自己输入的前后值、
 *   hint_open 只存序号、ink_stroke_batch 只存笔画数、lecture_expand 只存讲义 id
 *   与指令名/序号——任何题目侧内容不落本表）；
 * - attemptId 可空（§5.2 记作 attemptId；lecture_expand 读讲义时无 attempt 上下文，
 *   该类行 attemptId 与 questionId 均为 NULL，归属在 payloadJson.lectureId）；
 * - clientTs 为客户端毫秒时间戳（epoch ms 整数，与契约传输格式一致，focus/blur
 *   区间运算需要毫秒精度）；serverTs 为服务端接收时间（UTC ISO，§0.3 时间约定）；
 * - 每题有效用时由服务端在交卷时按本表事件序列计算（不信任客户端汇总值，§5.5），
 *   写回 responses.activeSec——本表是原始数据，计算只读。
 */
export const events = sqliteTable(
  "events",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 所属作答（attempts.id）；讲义等无 attempt 上下文的事件为 NULL */
    attemptId: text("attempt_id").references(() => attempts.id),
    /** 题目（questions.id）；无题目语义的事件（page 两态、submit、讲义域事件等）为 NULL */
    questionId: text("question_id"),
    /**
     * 学生（students.id；T4.0a D8）：DDL 可空、代码恒写非空（T2B D9 同口径）——
     * 服务端落库时从**会话**写入（前端不传，防伪造）。存量无 attemptId 的
     * 讲义事件（lecture_expand）无法归属，保留 NULL、读侧按非空过滤。
     */
    studentId: text("student_id"),
    /**
     * 讲义（lectures.id；T4.0a D8）：讲义域事件落库时从 payload 顶层提取
     * （questionIdOf 同款模式）——「学生 × 讲义」地图查询走索引，不必逐行
     * JSON.parse。环境族 net/idle 无讲义语义，为 NULL。
     */
    lectureId: text("lecture_id"),
    /** 事件类型（learningEventTypeSchema 22 种之一：T2.10 既有 11 + T4.0a 新增 11） */
    type: text("type")
      .$type<
        | "attempt_start"
        | "question_view"
        | "question_focus"
        | "question_blur"
        | "answer_change"
        | "hint_open"
        | "ink_stroke_batch"
        | "page_hidden"
        | "page_visible"
        | "submit"
        | "lecture_expand"
        | "lecture_visible"
        | "lecture_hidden"
        | "net_offline"
        | "net_online"
        | "idle_start"
        | "idle_end"
        | "lecture_section_focus"
        | "lecture_toc_jump"
        | "directive_interact"
        | "ink_edit_batch"
        | "ink_fullscreen"
      >()
      .notNull(),
    /** 事件载荷 JSON（契约各事件 schema 的序列化，不含题目侧内容） */
    payloadJson: text("payload_json").notNull(),
    /** 客户端事件时间（epoch 毫秒整数） */
    clientTs: integer("client_ts").notNull(),
    /** 服务端接收时间：UTC ISO 字符串 */
    serverTs: text("server_ts").notNull(),
  },
  (table) => [
    // 交卷时按 attempt 取全量事件序列计算的定位索引（clientTs 升序处理）
    index("events_attempt_client_ts_idx").on(table.attemptId, table.clientTs),
    // 讲义阅读地图常驻查询的定位索引（T4.0a D8：学生 × 讲义 × 时间；
    // type 过滤在少量行上做即可）
    index("events_student_lecture_client_ts_idx").on(
      table.studentId,
      table.lectureId,
      table.clientTs,
    ),
  ],
);

/**
 * 题目草稿四表（T6R.2，方案 §5.2「身份、正文、图片分开」）——
 * notes 当前头 + note_versions 不可变正文 + note_images 派生图 + submission_evidence
 * 逐题提交证据。契约权威定义在 packages/contract/src/note.ts（契约优先），
 * 本处 $type 仅引用其枚举类型，不重复手写值域。
 *
 * 归属推导（方案 §5.2/§8，T6R.0 决策 1）：一律 attemptId → attempts.studentId →
 * students.teacherId 服务端推导，客户端不可指定 studentId/teacherId/serverSavedAt；
 * **不使用 responses.inkId**——那是 T2.8 手写作答通道（手写题答案本体）的引用，
 * 与题目草稿（演算证据）是两条数据链，不得互相替代或混用作归属/证据引用。
 *
 * 正文与图片不进数据库（db-change 红线，ink 同款口径）：文件以不可变路径存
 * DATA_DIR/blobs/notes/…，库里只存相对路径（T6R.4 定稿路径规则与临时文件协议）。
 */
export const notes = sqliteTable(
  "notes",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定；即契约 NoteRecord.noteId） */
    id: text("id").primaryKey(),
    /** 所属作答（attempts.id；归属链入口） */
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    /** 题目（questions.id，来自 DSL；无外键，D10 口径） */
    questionId: text("question_id").notNull(),
    /**
     * 题目版本引用（T6R.3 冻结；契约 questionRevisionIdSchema：非空 opaque 串）。
     * 定位「建卷时冻结的那道题」，历史读取不依赖题库当前存活；具体铸造规则
     * （如 responses 行 id）由 T6R.3 落地，本列只存值不做外键。
     */
    questionRevisionId: text("question_revision_id").notNull(),
    /** 笔记阶段：scratch=本次工作稿（首版服务层只放行 scratch）/ correction=订正（T6R.15）/ supplement=交卷后找回（T6R.15） */
    phase: text("phase").$type<NotePhase>().notNull().default("scratch"),
    /** 当前 head 的 revision 号；0 = 建行后尚未产生任何版本（预留中间态） */
    currentRevision: integer("current_revision").notNull().default(0),
    /**
     * 当前 head 版本（note_versions.id）；currentRevision=0 时为 NULL。
     * 外键（T6R.2 code-review 裁决补加）：notes↔note_versions 循环引用在
     * SQLite 运行时外键下成立——头指针初始 NULL，版本先插、同事务内再切头；
     * GC 删除仍是 head 的版本会被 DB 拦截（防悬垂头指针）。
     */
    currentVersionId: text("current_version_id").references(
      (): AnySQLiteColumn => noteVersions.id,
    ),
    /** 最近一次服务端确认时间（UTC ISO）；从未确认为 NULL */
    serverSavedAt: text("server_saved_at"),
    /**
     * 订正检查点封存时间（T6R.15，D2「保存订正」= seal 检查点）：UTC ISO；
     * NULL = 未封存。非空 = 该订正行已封存，此后行不再接受写入（PUT →
     * 409 NOTE_CORRECTION_SEALED，再编辑 = 新开一行）；未封存的 correction
     * 行每 (attempt, question) 至多一行（D1，服务层事务内先查后插——同
     * scratch 口径不建 partial unique index）。仅 phase='correction' 行
     * 会有值（服务层保证；契约 noteRecordMetaSchema superRefine 锁定投影形态）。
     */
    sealedAt: text("sealed_at"),
    /**
     * 反思「我卡在哪里」（T6R.15，D10）：≤500 字（契约
     * NOTE_REFLECTION_MAX_LENGTH 单源）；随 seal 落列**冻结**——封存后行
     * 不再接受写入，反思字段随之不可改。
     */
    reflectionStuckAt: text("reflection_stuck_at"),
    /**
     * 反思「我的错因」（T6R.15，D10）：≤500 字；随 seal 落列冻结（同
     * reflectionStuckAt，checkpoint 语义天然只读）。
     */
    reflectionErrorCause: text("reflection_error_cause"),
    /** 头指针最近更新时间：UTC ISO 字符串（四表中唯一可 UPDATE 的表） */
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // 工作稿定位索引（attempt 下取题的热路径）。
    // 唯一性设计（T6R.2 决策）：「同 attempt 同题 scratch 唯一」是核心不变量，但
    // correction/supplement 允许多行（方案 §5.2/T6R.15：每次订正是独立 NoteRecord，
    // 再编辑另起），全列唯一索引不可行；partial unique index（WHERE phase='scratch'）
    // 依 attempts 表既有先例不建（「唯一性由服务层保证（先查后插，better-sqlite3
    // 同步单进程无并发竞态），不建 partial unique index 以保迁移简单」）——
    // scratch 唯一性由 T6R.4 服务层在同一事务内先查后插保证。
    index("notes_attempt_question_phase_idx").on(
      table.attemptId,
      table.questionId,
      table.phase,
    ),
    // DB 层值域防御（T6R.2 code-review）：$type 只约束 TS 不约束 SQLite——
    // 坏枚举串进入不可变链（版本/证据行）会导致 API 投影 parse 失败整页 500
    check(
      "notes_phase_check",
      sql`${table.phase} in ('scratch', 'correction', 'supplement')`,
    ),
  ],
);

/**
 * 备份快照引用列清单（T6R.14 /simplify C9 单源；T6R.23 P1-3/P2-1 扩列）：
 * GC 备份引用保留清单（backup-service.collectBackupReferencedPaths）从
 * 快照 db 读取的 (表, 路径列) 对——**所有含 DATA_DIR 相对 blob 文件引用
 * 的表**在此登记（notes 表族 / ink 笔迹两列 / 0027 标注两表）。
 * **消费方 backup-service 与各表定义在此同源**——表改名靠本常量同步；
 * 失败语义不对称的原因：列名改了 SELECT 抛错 → unreadable 计数触发保守
 * fail-safe（宁可不删），表名改了则静默按「表不存在」零引用——后者只能
 * 靠本常量与表定义同文件保证同步。可空列（annotation_bases.image_path、
 * annotations.body_path）的 NULL 行不是文件引用，由消费方跳过。
 */
export const BLOB_BACKUP_REF_COLUMNS = [
  ["note_versions", "body_path"],
  ["note_images", "path"],
  ["ink", "strokes_path"],
  ["ink", "png_path"],
  ["annotation_bases", "image_path"],
  ["annotations", "body_path"],
] as const;

/**
 * 笔记版本表（T6R.2，方案 §5.2/§6.3）——不可变正文：行只 INSERT 不 UPDATE，
 * 头指针切换在事务里改 notes；未引用版本由 GC 在安全窗口后回收（T6R.4）。
 * - (noteId, revision) 唯一：同一笔记内版本号从 1 递增（CAS 语义的基础）；
 * - bodyPath：gzip 后 NoteDoc 的不可变文件路径（相对 DATA_DIR；先写唯一临时
 *   文件再 rename，禁止覆盖既有版本路径——T6R.4 实现）；
 * - hash：服务端对规范化正文计算的 sha-256（64 位小写 hex，契约 noteBodyHashSchema）；
 * - paperWidth 恒 = 1000（INK_LOGICAL_WIDTH），冗余存储便于不解正文即知几何；
 * - renderVersion：派生图确定性口径（渲染器行为变更时递增；从 1 起）。
 */
export const noteVersions = sqliteTable(
  "note_versions",
  {
    /** 主键：crypto.randomUUID()（§0.3；即契约 versionId——交卷/补图引用它） */
    id: text("id").primaryKey(),
    /** 所属笔记（notes.id） */
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id),
    /** 版本号（同一 note 内从 1 递增） */
    revision: integer("revision").notNull(),
    /** 正文文件相对路径（DATA_DIR 内，blobs/notes/…；不可变，路径规则 T6R.4 定稿） */
    bodyPath: text("body_path").notNull(),
    /** 服务端正文 hash（sha-256 hex64；规范化规则 T6R.4 定稿） */
    hash: text("hash").notNull(),
    /** 笔画数（ink.strokes.length） */
    strokeCount: integer("stroke_count").notNull(),
    /** 总点数（全稿 points 之和；契约限额 NOTE_MAX_TOTAL_POINTS） */
    pointCount: integer("point_count").notNull(),
    /**
     * 纸张逻辑宽（恒 = INK_LOGICAL_WIDTH=1000；契约 z.literal 同口径锚定，
     * 冗余存储便于不解正文即知几何；DB 层 CHECK 兜底见表尾）
     */
    paperWidth: integer("paper_width").notNull(),
    /** 纸张逻辑高（本版本正文的 paperHeightLogical） */
    paperHeight: integer("paper_height").notNull(),
    /** 服务端确认时间：UTC ISO 字符串 */
    serverSavedAt: text("server_saved_at").notNull(),
    /** 渲染版本（从 1 起） */
    renderVersion: integer("render_version").notNull().default(1),
    /**
     * 幂等键（T6R.4）：客户端为本次变更生成的 mutationId（契约 noteUploadMetaSchema）。
     * 可空仅因 SQLite「ALTER ADD COLUMN NOT NULL 必须带默认值」——服务层
     * （note-service.saveNoteVersion）恒写非空，存量行不存在（本任务前无写入通道）。
     * 全局唯一索引承载幂等查重：同 mutationId 重放比对正文 hash——相同回原回执、
     * 不同 409 NOTE_MUTATION_MISMATCH；版本行被 GC 回收后幂等记录随之消失，
     * 幂等窗口 = GC 安全窗口（设计取舍：不为幂等另建长命表，重放远晚于安全窗口
     * 时按 CAS 冲突处理，可诊断）。
     */
    mutationId: text("mutation_id"),
  },
  (table) => [
    // 同一笔记内版本号唯一（CAS 期望值的物理基础）
    uniqueIndex("note_versions_note_revision_uk").on(
      table.noteId,
      table.revision,
    ),
    // 幂等键全局唯一（见 mutation_id 列注释；SQLite 唯一索引允许多个 NULL，
    // 存量空行互不冲突）
    uniqueIndex("note_versions_mutation_id_uk").on(table.mutationId),
    check("note_versions_paper_width_check", sql`${table.paperWidth} = 1000`),
  ],
);

/**
 * 笔记派生图表（T6R.2，方案 §5.2/§7）——从不可变 NoteVersion 生成的 PNG 附件：
 * 缩略图（thumbnail）与分析图（analysis，可切片）；同版本可有多个规格/多页。
 * - (noteVersionId, spec, pageIndex) 唯一：一个版本一个规格一个页号一个槽位，
 *   重建补图 = 行 upsert + 新文件新路径（不可变文件，不覆盖原路径）；
 * - 裁剪区（crop_x/y/w/h）：整数逻辑坐标（切片范围与重叠区，契约 noteCropRectSchema）；
 * - state：pending/ready/failed/missing（契约 noteImageStateSchema）；
 *   仅 ready 保证 hash/path 指向可用文件（与契约一致性校验同口径，DB 不强制）；
 * - 补图只能挂既定版本（T6R.5/6 校验），不能修改原稿正文与提交引用。
 */
export const noteImages = sqliteTable(
  "note_images",
  {
    /** 主键：crypto.randomUUID()（§0.3；即契约 imageId） */
    id: text("id").primaryKey(),
    /** 所属版本（note_versions.id） */
    noteVersionId: text("note_version_id")
      .notNull()
      .references(() => noteVersions.id),
    /** 渲染规格：thumbnail=缩略图 / analysis=分析图 */
    spec: text("spec").$type<NoteImageSpec>().notNull(),
    /** 页号/切片序（同版本同规格内从 0 递增） */
    pageIndex: integer("page_index").notNull(),
    /**
     * 裁剪区左上 x（整数逻辑坐标）。映射锚点（契约 ↔ 表平铺）：
     * 契约 crop.{x,y,width,height} ↔ crop_x/crop_y/crop_w/crop_h——注意
     * width→cropW、height→cropH 是换名非机械 snake_case；边界校验
     * （x+w≤1000、y+h≤3000）在契约 superRefine，DB 不加 CHECK（与 state 同口径）
     */
    cropX: integer("crop_x").notNull(),
    /** 裁剪区左上 y（整数逻辑坐标） */
    cropY: integer("crop_y").notNull(),
    /** 裁剪区宽（逻辑单位） */
    cropW: integer("crop_w").notNull(),
    /** 裁剪区高（逻辑单位） */
    cropH: integer("crop_h").notNull(),
    /** 像素宽 */
    pixelWidth: integer("pixel_width").notNull(),
    /** 像素高 */
    pixelHeight: integer("pixel_height").notNull(),
    /** 图片文件相对路径（DATA_DIR 内；不可变文件，重建 = 新路径） */
    path: text("path").notNull(),
    /**
     * 图片文件字节数（写入时记 png.byteLength；T6R.5 复审③：聚合限额
     * 「同版本派生图合计 ≤8MiB」用 select sum(byte_size) 一条 SQL 判定，
     * 不再逐行 statSync）。口径**更保守**：删除文件不释放额度（行才是账本，
     * 文件缺失的行照常占额度——防「删文件绕限额」；重建槽位以行替换归还）。
     * 存量行（本表首个写通道即 T6R.5，无存量）与异常行按默认 0 计
     */
    byteSize: integer("byte_size").notNull().default(0),
    /** 图片文件 sha-256（hex64）；未就绪为 NULL（仅 state='ready' 保证非空） */
    hash: text("hash"),
    /** 图片状态：pending=排队/生成中 / ready=可用 / failed=生成失败 / missing=文件缺失 */
    state: text("state").$type<NoteImageState>().notNull().default("pending"),
  },
  (table) => [
    // 槽位唯一：同版本同规格同页号只有一张图（重建走 upsert）
    uniqueIndex("note_images_version_spec_page_uk").on(
      table.noteVersionId,
      table.spec,
      table.pageIndex,
    ),
    check(
      "note_images_spec_check",
      sql`${table.spec} in ('thumbnail', 'analysis')`,
    ),
    check(
      "note_images_state_check",
      sql`${table.state} in ('pending', 'ready', 'failed', 'missing')`,
    ),
  ],
);

/**
 * 提交证据表（T6R.2，方案 §5.2/§6.4）——交卷事务固定的逐题原稿声明。
 * - (attemptId, questionId) 唯一：一次作答一道题一条证据；
 * - state：none=确实空稿 / frozen=已固定版本 / missing=用户明确选择缺稿交卷 /
 *   legacy_unverified=升级前进行中 attempt 首次恢复时的降级标记（T6R.3）；
 * - versionId：仅 state='frozen' 时指向 note_versions.id（交卷携带的 versionId），
 *   其余状态为 NULL——写入后**不能换原稿**：订正/重练/清空都不动本行
 *   （订正是新 NoteRecord，见 notes.phase）；
 * - recordedAt：交卷事务写入时间（UTC ISO）。
 * 旧客户端无笔记的兼容交卷按「未采集」处理（T6R.10：不落本表 = 无证据行，
 * 与 state='none'〔明确空稿〕区分）。
 */
export const submissionEvidence = sqliteTable(
  "submission_evidence",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 所属作答（attempts.id） */
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    /** 题目（questions.id，来自 DSL；无外键，D10 口径） */
    questionId: text("question_id").notNull(),
    /** 证据状态（见 table 注释四值） */
    state: text("state").$type<NoteSubmissionEvidenceState>().notNull(),
    /** 被固定的版本（note_versions.id）；仅 state='frozen' 非 NULL，写入后不换 */
    versionId: text("version_id").references(() => noteVersions.id),
    /** 记录时间：UTC ISO 字符串（交卷事务写入） */
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    // 一次作答一道题一条证据（交卷事务定位键）
    uniqueIndex("submission_evidence_attempt_question_uk").on(
      table.attemptId,
      table.questionId,
    ),
    // GC 反查：版本被证据引用时不得回收（T6R.4）。version_id 等值查询天然
    // 不命中 NULL 行；SQLite 普通索引含 NULL 条目，勿据索引条目数做统计
    index("submission_evidence_version_idx").on(table.versionId),
    check(
      "submission_evidence_state_check",
      sql`${table.state} in ('none', 'frozen', 'missing', 'legacy_unverified')`,
    ),
  ],
);

/**
 * 题干标注两表（T6R.20，docs/题目草稿功能方案.md §10「固定底图＋独立矢量标注」；
 * 契约权威定义在 packages/contract/src/annotation.ts）——
 * annotation_bases 固定底图行（身份三要素：questionRevisionId＋snapshotHash＋
 * baseRenderVersion）+ annotations 标注当前头（CAS revision，正文文件不可变）。
 *
 * 与 notes 四表的关系（计划决策 7 轻量口径）：标注数据量小（限额内几十笔）、
 * 无审计版本链需求（订正另开是 phase 记录级隔离，非版本链）；单表 + CAS +
 * mutationId 幂等与 note 上传协议同构，但**不复用** notes/note_versions 头/版本
 * 两表（NoteDoc 覆盖载荷禁令——方案 §10「不塞进 NoteDoc 同一次覆盖上传」）。
 *
 * 存储口径：底图 PNG 与标注正文均不进数据库——底图存 DATA_DIR/blobs/
 * annotations/<sha256>.png（内容寻址；**绝不放 blobs/media/**——/blobs 伺服
 * 段白名单只放行 media/，且 requireAnySession 会把题干内容暴露给任意登录
 * 学生，绕过题目可见性控制），正文存 blobs/annotation-bodies/<hash>.json.gz
 * （gzip JSON 不可变文件）；库行只存相对路径。
 *
 * 归属推导同 notes：attemptId → attempts.studentId → students.teacherId 服务端
 * 推导，客户端不可指定。
 */
export const annotationBases = sqliteTable(
  "annotation_bases",
  {
    /** 主键：crypto.randomUUID()（§0.3；即契约 annotationBaseRef.baseId） */
    id: text("id").primaryKey(),
    /** 所属作答（attempts.id；归属链入口） */
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    /** 题目（questions.id，来自 DSL；无外键，D10 口径） */
    questionId: text("question_id").notNull(),
    /**
     * 题目版本引用（身份三要素之一）：该 (attempt,question) 的 responses 行 id。
     * attempt 快照冻结后不可变，本列用于写入时比对（不一致＝数据异常行）。
     */
    questionRevisionId: text("question_revision_id").notNull(),
    /**
     * 标注阶段：scratch=作答期（交卷 seal）/ correction=订正期另开记录。
     * **无 supplement**（标注的记录级隔离只有两态）。
     */
    phase: text("phase").$type<AnnotationPhase>().notNull().default("scratch"),
    /**
     * 题目快照内容身份（身份三要素之二）：服务端 canonicalJson→sha-256。
     * 不变式：＝该 responses 行 questionSnapshotJson 的规范化 hash（快照冻结
     * 后不可变，正常永不漂移）；不一致＝stale（旧版本题干的标注，服务端
     * 如实上报 UI 标旧版，不静默重生成底图——「同一份圈画永不换底图」）。
     */
    snapshotHash: text("snapshot_hash").notNull(),
    /**
     * 底图生成管线版本（身份三要素之三）：契约 ANNOTATION_BASE_RENDER_VERSION
     * 单源。**不复用 note_versions.render_version**（那是笔记派生图渲染器版本，
     * 语义不同，命名隔离）。ready 后永不重生成——版本递增只影响新底图。
     */
    baseRenderVersion: integer("base_render_version").notNull(),
    /** 底图 PNG 相对路径（DATA_DIR 内 blobs/annotations/<sha256>.png）；仅 ready 非 NULL */
    imagePath: text("image_path"),
    /** 底图文件 sha-256（hex64）；仅 ready 非 NULL */
    imageHash: text("image_hash"),
    /** 底图像素宽（IHDR 实测；恒＝契约 ANNOTATION_BASE_WIDTH_PX）；仅 ready 非 NULL */
    pixelWidth: integer("pixel_width"),
    /** 底图像素高（IHDR 实测；≤契约上限）；仅 ready 非 NULL */
    pixelHeight: integer("pixel_height"),
    /**
     * 底图状态：pending=装配载荷已建待客户端回传 PNG / ready=PNG 已落盘
     * （此后挂画布、可落墨）/ failed=防御态（数据修复/异常标记）。
     */
    state: text("state")
      .$type<AnnotationBaseState>()
      .notNull()
      .default("pending"),
    /** 行创建时间：UTC ISO */
    createdAt: text("created_at").notNull(),
    /** 行最近更新时间：UTC ISO */
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // 定位索引（attempt 下取题的热路径）。唯一性（同 attempt 同题同 phase 至多
    // 一行）由服务层事务内先查后插保证——同 notes scratch 先例，不建 partial
    // unique index 以保迁移简单。
    index("annotation_bases_attempt_question_phase_idx").on(
      table.attemptId,
      table.questionId,
      table.phase,
    ),
    // DB 层值域防御（$type 只约束 TS 不约束 SQLite——坏枚举串会让 API 投影
    // parse 失败整页 500）
    check(
      "annotation_bases_phase_check",
      sql`${table.phase} in ('scratch', 'correction')`,
    ),
    check(
      "annotation_bases_state_check",
      sql`${table.state} in ('pending', 'ready', 'failed')`,
    ),
  ],
);

/**
 * 标注行（T6R.20）——每 (attempt, question, phase) 单行的当前头：
 * - revision 从 0 起的 CAS 计数（无版本表——历史正文文件按内容寻址不可变，
 *   行内指向最新一份；旧文件无引用后成为孤儿，标注量小不做 GC）；
 * - bodyPath：gzip 后 AnnotationDoc 的不可变文件（blobs/annotation-bodies/
 *   <hash>.json.gz，路径三段全服务端生成）；
 * - sealedAt：交卷（scratch）/订正检查点（correction）封存时间；非空后行
 *   只读（PUT → 409 ANNOTATION_SEALED，再编辑＝订正另开 correction 行）；
 * - mutationId：最近一次成功写入的幂等键（单行设计：幂等窗口＝行仍持有该
 *   id；全局唯一索引防两行共享）。
 */
export const annotations = sqliteTable(
  "annotations",
  {
    /** 主键：crypto.randomUUID()（§0.3；即契约 annotationMeta.annotationId） */
    id: text("id").primaryKey(),
    /** 所属作答（attempts.id） */
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    /** 题目（questions.id，来自 DSL；无外键，D10 口径） */
    questionId: text("question_id").notNull(),
    /** 标注阶段（scratch/correction；语义同 annotation_bases.phase） */
    phase: text("phase").$type<AnnotationPhase>().notNull().default("scratch"),
    /** 所属底图（annotation_bases.id；「没有可靠底图不能落墨」的行级锚定） */
    baseId: text("base_id")
      .notNull()
      .references(() => annotationBases.id),
    /** 当前 revision（CAS 期望值口径；0=建行后尚无正文） */
    revision: integer("revision").notNull().default(0),
    /** 当前正文文件相对路径（blobs/annotation-bodies/<hash>.json.gz）；revision=0 时 NULL */
    bodyPath: text("body_path"),
    /** 当前正文 hash（服务端规范化 sha-256，hex64）；revision=0 时 NULL */
    hash: text("hash"),
    /** 笔画数（doc.strokes.length） */
    strokeCount: integer("stroke_count").notNull().default(0),
    /** 总点数（全稿 points 之和） */
    pointCount: integer("point_count").notNull().default(0),
    /** 封存时间（UTC ISO）；NULL=进行中。交卷 seal 置 scratch 行，检查点置 correction 行 */
    sealedAt: text("sealed_at"),
    /** 行最近更新时间：UTC ISO */
    updatedAt: text("updated_at").notNull(),
    /** 最近一次成功写入的幂等键（可空仅因 ALTER ADD COLUMN 限制；服务层恒写非空） */
    mutationId: text("mutation_id"),
  },
  (table) => [
    // 定位索引（attempt 下取题的热路径；唯一性服务层先查后插，同上）
    index("annotations_attempt_question_phase_idx").on(
      table.attemptId,
      table.questionId,
      table.phase,
    ),
    check(
      "annotations_phase_check",
      sql`${table.phase} in ('scratch', 'correction')`,
    ),
    // 幂等键全局唯一（同 note_versions.mutation_id 口径：SQLite 唯一索引
    // 允许多个 NULL，空行互不冲突）
    uniqueIndex("annotations_mutation_id_uk").on(table.mutationId),
  ],
);

/** courses 表行类型（SELECT 结果） */
export type Course = typeof courses.$inferSelect;
/** courses 表插入类型 */
export type NewCourse = typeof courses.$inferInsert;
/**
 * 学情报告表（T4.6，D24）——AI 经 MCP save_report（source='mcp'）或教师手写
 * （source='manual'，预留入口）写入的学情报告最小集。
 * - 归属链 teacherId + studentId（服务层域校验；不建外键——教师数据永不连带
 *   删除的既有口径，students.teacherId 同款）；
 * - 教师端可查看（学生画像页 T4.7 接入）与删除，不做编辑；学生端不展示报告；
 * - markdown 存报告原文（AI 输出的 Markdown，画像页渲染展示）。
 */
export const reports = sqliteTable(
  "reports",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 归属教师（D9：DB 可空、代码恒写非空；报告域内私有） */
    teacherId: text("teacher_id"),
    /** 学生（students.id；服务层校验属于本教师） */
    studentId: text("student_id").notNull(),
    /** 报告标题 */
    title: text("title").notNull(),
    /** 报告正文（Markdown 原文） */
    markdown: text("markdown").notNull(),
    /** 来源（D24）：mcp = AI 写入 / manual = 教师手写（预留） */
    source: text("source").$type<"mcp" | "manual">().notNull(),
    /** 创建时间：UTC ISO 字符串 */
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // 学生报告列表的定位索引（teacherId + studentId，createdAt 倒序在少量行上做）
    index("reports_teacher_student_idx").on(table.teacherId, table.studentId),
  ],
);
/** reports 表行类型（SELECT 结果） */
export type Report = typeof reports.$inferSelect;
/** reports 表插入类型 */
export type NewReport = typeof reports.$inferInsert;
/** library_folders 表行类型（SELECT 结果） */
export type LibraryFolder = typeof libraryFolders.$inferSelect;
/** library_folders 表插入类型 */
export type NewLibraryFolder = typeof libraryFolders.$inferInsert;
/** data_migrations 表行类型（SELECT 结果） */
export type DataMigration = typeof dataMigrations.$inferSelect;
/** data_migrations 表插入类型 */
export type NewDataMigration = typeof dataMigrations.$inferInsert;
/** course_items 表行类型（SELECT 结果） */
export type CourseItem = typeof courseItems.$inferSelect;
/** course_items 表插入类型 */
export type NewCourseItem = typeof courseItems.$inferInsert;
/** course_items 条目类型（section/lecture/unit） */
export type CourseItemKind = NonNullable<CourseItem["kind"]>;
/** course_students 表行类型（SELECT 结果） */
export type CourseStudent = typeof courseStudents.$inferSelect;
/** course_students 表插入类型 */
export type NewCourseStudent = typeof courseStudents.$inferInsert;
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
/** assignments 表行类型（SELECT 结果） */
export type Assignment = typeof assignments.$inferSelect;
/** assignments 表插入类型 */
export type NewAssignment = typeof assignments.$inferInsert;
/** assignment_units 表行类型（SELECT 结果） */
export type AssignmentUnit = typeof assignmentUnits.$inferSelect;
/** assignment_units 表插入类型 */
export type NewAssignmentUnit = typeof assignmentUnits.$inferInsert;
/** assignment_students 表行类型（SELECT 结果） */
export type AssignmentStudent = typeof assignmentStudents.$inferSelect;
/** assignment_students 表插入类型 */
export type NewAssignmentStudent = typeof assignmentStudents.$inferInsert;
/** attempts 表行类型（SELECT 结果） */
export type Attempt = typeof attempts.$inferSelect;
/** attempts 表插入类型 */
export type NewAttempt = typeof attempts.$inferInsert;
/** responses 表行类型（SELECT 结果） */
export type ResponseRow = typeof responses.$inferSelect;
/** responses 表插入类型 */
export type NewResponseRow = typeof responses.$inferInsert;
/** ink 表行类型（SELECT 结果） */
export type InkRow = typeof ink.$inferSelect;
/** ink 表插入类型 */
export type NewInkRow = typeof ink.$inferInsert;
/** events 表行类型（SELECT 结果） */
export type EventRow = typeof events.$inferSelect;
/** events 表插入类型 */
export type NewEventRow = typeof events.$inferInsert;
/** notes 表行类型（SELECT 结果；T6R.2 笔记当前头） */
export type NoteRow = typeof notes.$inferSelect;
/** notes 表插入类型 */
export type NewNoteRow = typeof notes.$inferInsert;
/** note_versions 表行类型（SELECT 结果；不可变正文） */
export type NoteVersionRow = typeof noteVersions.$inferSelect;
/** note_versions 表插入类型 */
export type NewNoteVersionRow = typeof noteVersions.$inferInsert;
/** note_images 表行类型（SELECT 结果；派生图附件） */
export type NoteImageRow = typeof noteImages.$inferSelect;
/** note_images 表插入类型 */
export type NewNoteImageRow = typeof noteImages.$inferInsert;
/** submission_evidence 表行类型（SELECT 结果；逐题提交证据） */
export type SubmissionEvidenceRow = typeof submissionEvidence.$inferSelect;
/** submission_evidence 表插入类型 */
export type NewSubmissionEvidenceRow = typeof submissionEvidence.$inferInsert;
/** annotation_bases 表行类型（SELECT 结果；T6R.20 固定底图） */
export type AnnotationBaseRow = typeof annotationBases.$inferSelect;
/** annotation_bases 表插入类型 */
export type NewAnnotationBaseRow = typeof annotationBases.$inferInsert;
/** annotations 表行类型（SELECT 结果；T6R.20 标注当前头） */
export type AnnotationRow = typeof annotations.$inferSelect;
/** annotations 表插入类型 */
export type NewAnnotationRow = typeof annotations.$inferInsert;
