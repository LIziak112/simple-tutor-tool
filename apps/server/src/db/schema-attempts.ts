import type {
  AttemptSource,
  AttemptStatus,
  PracticeFeedbackMode,
} from "@tutor/contract";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { courses } from "./course-schema.ts";
import { assignments, students } from "./schema.ts";

export const attempts = sqliteTable(
  "attempts",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 作答学生（students.id） */
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    /** 作答来源（D9 + 2026-10 wrong/lesson）：assignment | course | wrong | lesson
     *  （lesson 行由讲练开卷在后续任务写入；此处改用契约类型单一出处，值域随
     *  attemptSourceSchema 联动，消除手抄枚举漂移——AGENTS 第 1 条同精神） */
    sourceType: text("source_type")
      .$type<AttemptSource>()
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
    /**
     * 讲练页来源讲义（lectures.id；讲练一体 2026-10）：lesson 来源必填 = 讲练页
     * 讲义 id，其余来源恒 null。无外键（参照 unitId 同款口径：D10 后子表外键
     * 已拆，域一致性由服务层保证）。
     */
    lectureId: text("lecture_id"),
    /**
     * 错题重练建卷范围快照（2026-10-25 #6980-2）：wrong 来源建卷时写入请求的
     * scope JSON（wrongPracticeScopeSchema）；其余来源恒 NULL。历史卷为
     * NULL，展示由 sourceOf 从冻结 responses→questions→units 反查现算。
     */
    practiceScopeJson: text("practice_scope_json"),
    /** 第几次作答（D10：course 来源从 1 递增；assignment 来源缺省 1、显式重做开新卷后按 (学生, 作业) 递增，hall-15313） */
    attemptNo: integer("attempt_no").notNull().default(1),
    /** 作答状态：draft | submitted | graded */
    status: text("status").$type<AttemptStatus>().notNull(),
    /** 开始作答时间：UTC ISO 字符串 */
    startedAt: text("started_at").notNull(),
    /** 最近有效作答确认时间；历史缺省由查询回退，不推测历史编辑。 */
    lastActivityAt: text("last_activity_at"),
    /** 首次实质动作时刻；NULL 是未入账的打开暂存卷。 */
    activatedAt: text("activated_at"),
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
    /** 冻结来源不可信标记（T6R.3 §5.1「legacy_unverified」）：true = 升级后首次恢复
     *  访问时懒冻结的当前版本（不能宣称是学生更早看到的内容）；false = 建卷即冻结 */
    legacyUnverified: integer("legacy_unverified", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * 作废时刻（2026-10 讲练随时重开）：UTC ISO；非 null = 已作废。讲练落地页
     * 「重新开始」放弃进行中卷时写入——被作废卷不再出现在讲练落地/开卷/记录/
     * 待批队列（学情与错题本本就只统计已交卷，天然排除），其上一切读写经
     * requireUsableAttempt 以 ATTEMPT_ABANDONED 拒绝。行与子行（responses/
     * 事件/笔记）保留审计，不物理删除。
     */
    abandonedAt: text("abandoned_at"),
    /**
     * 做题工作流协议版本（M1b，2026-10-22 计划 §6.2）：1 = 新协议卷（建卷时
     * 显式写入）；NULL = 升级前历史卷——恒整卷旧协议（resolver 恒 after_attempt /
     * legacy_attempt），不回填不升级。lesson 来源不经本列（独立适配路径）。
     */
    practiceWorkflowVersion: integer("practice_workflow_version"),
    /**
     * 本卷反馈节奏（M1b）：per_question | after_attempt。仅新协议卷在建卷时
     * 按教师规则 + 学生选择裁决写入；教师后续收紧不改写本值（读侧按当前规则
     * 冻结 canSubmitQuestion），历史卷 NULL。
     */
    feedbackMode: text("feedback_mode").$type<PracticeFeedbackMode>(),
    /** 工作流 CAS 版本（M1b）：新协议卷建卷写 0，反馈节奏修改（PATCH workflow）与
     *  逐题提交（M2）事务内自增比对；历史卷恒 0 且不可变更。 */
    workflowRevision: integer("workflow_revision").notNull().default(0),
    /** 限时测试（模块 2，2026-11）：自选时长秒 / 截止 UTC ISO（= startedAt + 时长）；
     *  非限时卷与历史卷 NULL。时钟以本列为准，写入闸门见 attempt-timing.ts */
    timeLimitSec: integer("time_limit_sec"),
    deadlineAt: text("deadline_at"),
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
    // 讲练页「同一 (学生, 讲义)」历次作答查询索引（讲练一体 2026-10；start 的
    // 幂等 create-or-return 与记录聚合走本索引，唯一性由服务层事务先查后插保证）
    index("attempts_student_lecture_idx").on(table.studentId, table.lectureId),
  ],
);

export type Attempt = typeof attempts.$inferSelect;
export type NewAttempt = typeof attempts.$inferInsert;
