import type { GradingPolicy, SelfReviewRecord } from "@tutor/contract";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { attempts } from "./schema.ts";

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
    /** 普通答案独立 CAS 版本，与作答次数统计、手写版本分别维护。 */
    answerRevision: integer("answer_revision").notNull().default(0),
    /** 最近一次有版本保存标识；建立新协议后拒绝无版本旧客户端覆盖。 */
    answerMutationId: text("answer_mutation_id"),
    /**
     * 单题提交时刻（讲练一体 2026-10 起写入；M2 新协议普通卷同写）：
     * UTC ISO；单题提交 = 该题提交时刻，整卷收尾对剩余行 = 交卷时刻
     * （lesson 独立适配 + M2 v1 普通卷，判定走 practiceProtocolOf 单一谓词）；
     * NULL = 未提交。历史旧协议卷（无工作流版本的 assignment/course/wrong）
     * 整卷链路不写本列，恒 null。
     */
    submittedAt: text("submitted_at"),
    /** 结算成员归属，与单题提交锁分开；空值包含已逐题提交但尚未结算的行。 */
    settlementSeq: integer("settlement_seq"),
    /** 自动判分结果：true/false；NULL = 不能自动判定（D1 后不含未作答客观题） */
    autoCorrect: integer("auto_correct", { mode: "boolean" }),
    /** 最终判定（D3：交卷时写 = autoCorrect，教师批注后 teacherMark 优先）；未批为 NULL，即待批（D4） */
    finalCorrect: integer("final_correct", { mode: "boolean" }),
    /**
     * 是否有实际作答内容（#6980-3）：判分写点落库——整卷交卷按「非空答案或
     * 正式手写笔迹（ink.strokeCount>0）」判定；单题主动提交
     * （submitPracticeQuestion / submitLessonQuestion）恒 true（显式交锋，
     * 含「不会，提交并看解析」的空提交）。历史行由 backfill.ts 回填（非空答案 /
     * 正式笔迹 / 单题提交标记）。与判分正交——未做仍按 D1 判错进分母；错题本
     * 入本（「答了且判错」或人工显式判定）、结果视图/教师详情「未做」灰显、
     * 「练习本卷错题」默认圈题共用本事实。
     */
    answered: integer("answered", { mode: "boolean" }).notNull().default(false),
    /**
     * 做题时学生自标「不会」（#6980-4）：'unsure' / NULL。draft 时经
     * PUT /attempts/:id/flags/:questionId 写入（交卷后 409）；随草稿/结果/
     * 错题本轮次/教师详情下发。标过不会的题入错题本（无论对错与是否作答），
     * 标过不会的做对轮不算攻克。不是作答内容，无泄露面。
     */
    studentFlag: text("student_flag"),
    /** 教师批注标记（T3.2：正确 | 错误 | null）；未批为 NULL */
    teacherMark: text("teacher_mark"),
    /** 教师评语（T3.2）；未评为 NULL */
    teacherComment: text("teacher_comment"),
    /** 每题有效用时（秒，T2.10 按事件计算回写）；未计算为 NULL */
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
    /**
     * 普通逐题提交幂等键（M1b 建列、M2 实装）：同 mutationId 同请求摘要重试
     * 返回同一提交事实，不重复判分；未逐题提交为 NULL。
     */
    practiceMutationId: text("practice_mutation_id"),
    /**
     * 逐题提交请求摘要（M1b 建列、M2 实装）：与 practiceMutationId 配对校验，
     * 同 id 不同摘要 → 409；未逐题提交为 NULL。
     */
    practiceRequestDigest: text("practice_request_digest"),
    /**
     * 行级判分策略（tt-05b / QM-03，决策记录 §5.6 D11）：开卷冻结时按题目快照与教师自评设置写入
     * （frozenGradingPolicyOf 单一出处）——auto / reference_self / manual_only。**NULL =
     * 旧行旧语义**（历史卷不重释）；值域不加 DB CHECK（teacherMark 同款口径）。
     */
    gradingPolicy: text("grading_policy").$type<GradingPolicy>(),
    /**
     * 学生自评 verdict（决策记录 §5.5.1/§5.5.2 三源分立）：correct/wrong 只存实际
     * 判断；NULL = 从未自评或已撤回（undecided = 清除）。自评不写 teacherMark/
     * finalCorrect（D7）。
     */
    selfReviewVerdict: text("self_review_verdict").$type<
      SelfReviewRecord["verdict"]
    >(),
    /** 最近一次自评时刻（UTC ISO）；从未自评为 NULL */
    selfReviewAt: text("self_review_at"),
    /** 自评记录修订版本（CAS 基线，首次 0；撤回/修正亦递增，§5.5.1） */
    selfReviewRevision: integer("self_review_revision").notNull().default(0),
    /** 最近一次自评写入的幂等键（网络重试同键不重复写）；从未自评为 NULL */
    selfReviewMutationId: text("self_review_mutation_id"),
    /**
     * 模块 3 通用量表判卷（0056）：自评 / Agent 意见 / 本人裁定三份 JSON（契约
     * rubric.ts），NULL = 尚无；量表在冻结题目快照里，量表分不进 finalCorrect。
     */
    rubricSelfJson: text("rubric_self_json"),
    rubricAgentJson: text("rubric_agent_json"),
    rubricFinalJson: text("rubric_final_json"),
    /**
     * v2 旧自评实现的 review_* 列族（0040_bizarre 建列）：§22 两线收敛后
     * 业务代码统一走 self_review_* 体系，这些列不再读写，仅为迁移链与
     * 存量库一致性保留（v2 侧 backfill 测试仍引用）。是否 DROP 由发布
     * 拍板（演示库残留列待决项），在此之前 schema 与迁移保持同形。
     */
    reviewPolicy: text("review_policy").notNull().default("legacy"),
    reviewEligible: integer("review_eligible", { mode: "boolean" })
      .notNull()
      .default(false),
    selfCorrect: integer("self_correct", { mode: "boolean" }),
    reviewRevision: integer("review_revision").notNull().default(0),
    reviewMutationId: text("review_mutation_id"),
    reviewMutationHash: text("review_mutation_hash"),
    reviewedAt: text("reviewed_at"),
  },
  (table) => [
    index("responses_settlement_idx").on(table.attemptId, table.settlementSeq),
    // 草稿 upsert 与交卷整行重写的定位键
    uniqueIndex("responses_attempt_question_uk").on(
      table.attemptId,
      table.questionId,
    ),
  ],
);

export type ResponseRow = typeof responses.$inferSelect;
export type NewResponseRow = typeof responses.$inferInsert;
