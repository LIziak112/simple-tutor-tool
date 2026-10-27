import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, attempts, responses } from "../db/schema";

/**
 * 共享待批谓词（D4，T3.2a）——全站唯一口径：
 * **待批题 ≡ 「已交」的题中 `responses.finalCorrect IS NULL` 的题**。
 * 「已交」= attempt 非 draft **或该行已单题提交**（responses.submittedAt 非空；
 * 写该列的有两处：2026-10 讲练一体的 lesson 单题提交——进行中卷已提交的
 * 手写/无答案题即时进教师待批、课堂当场批改；M2 起练习反馈升级的 v1 新协议
 * 逐题提交——per_question 卷当题提交即落行级 submittedAt）。
 *
 * 设计依据：
 * - D3 持久化口径（交卷同时写 finalCorrect = teacherMark ?? autoCorrect）下与
 *   「autoCorrect 为 null 且教师未批」严格等价；「待批数 = 0 ⇔ status =
 *   graded」（D2 状态机）只对**已收尾卷**（非 draft）成立——lesson / v1 进行中
 *   卷可有行级待批（状态仍是 draft），消费方按状态先分流；
 * - **不得叠加 `answerJson 非空` 条件**（T3.2a 前的旧口径）：只写笔迹、未填
 *   最终答案的手写题 answerJson 为 null，却正是最需要批改的题——旧条件会漏掉
 *   它们并让该 attempt 永远到不了 graded；
 * - **叠加 `questionSnapshotJson 非空`（T6R.3）**：排除「历史题目缺失」的
 *   幽灵行（升级遗留卷中软删/缺失题的行——不进判分、不进任何视图，若计入
 *   待批会让 attempt 永卡 submitted 且队列出现不可批的空卡片）；
 * - 消费方：course-service（进度矩阵）、student-course-service（单元卡片）、
 *   teacher-attempt-service（数据页卡片与详情）、mark-response（待批队列）、
 *   student-records（记录行待批数）。T3.2b 待批队列同口径复用。
 *
 * 独立小模块（只依赖 db + schema）：避免 service 之间互相引用形成循环依赖。
 */

/** 判定输入的最小形态（attempt 行裁剪：只需要 id 与状态） */
export type PendingMarkAttempt = Pick<Attempt, "id" | "status">;

/**
 * D4 待批行的共享条件（不含 attempt 归属筛选——单卷 eq / 批量 inArray 各自给）：
 * finalCorrect IS NULL + 快照非空（排幽灵行）+ **排除 reference_self 行**
 * （QM-10 / §5.5.3 D9：有参考答案的新策略行走学生自评，永不进教师必批
 * 队列——教师可选批改走全部已交列表；NULL 策略旧行不受影响）+ draft 批次
 * 叠加行级已提交（lesson 单题提交与 v1 新协议逐题提交都会写行级
 * submittedAt——进行中卷只数已单题提交的行；无行级提交事实的 legacy draft
 * 恒 0。非 draft 批次整卷恒「已交」，保持既有口径不加条件——设计依据详见
 * 模块头注释）。两函数（单卷/批量）共用本构造器，口径永不漂移。
 */
/** D4 待批行的公共条件（draft 与非 draft 批次共享；draft 差异见 pendingMarkConditions） */
function pendingMarkBaseConditions(selfReview = false): (SQL | undefined)[] {
  return [
    isNull(responses.finalCorrect),
    eq(responses.reviewEligible, selfReview),
    isNotNull(responses.questionSnapshotJson),
    // QM-12 合并并集：策略排除（reference_self 行永不进教师必批）——v2 列
    // 门控之外补 PR 侧谓词；reference_self 行即便 review_eligible 误标也
    // 不进教师队列，两线口径（pendingSelfReviewCounts 分列）不漂移
    notSelfReviewPendingRow(),
  ];
}

function pendingMarkConditions(
  draft: boolean,
  selfReview = false,
): (SQL | undefined)[] {
  return [
    ...pendingMarkBaseConditions(selfReview),
    draft ? isNotNull(responses.submittedAt) : undefined,
  ];
}

/**
 * 「非 reference_self 行」条件（D4 谓词与 mark-response 待批队列共用）：
 * grading_policy 列可空（旧行 NULL = 旧语义），SQL 三值逻辑下 `!= 'x'` 对
 * NULL 行求值为 NULL 会被 and 吞掉——必须显式 isNull OR ne。
 */
export function notSelfReviewPendingRow(): SQL {
  return or(
    isNull(responses.gradingPolicy),
    ne(responses.gradingPolicy, "reference_self"),
  ) as SQL;
}

/**
 * 单个 attempt 的待批题数。draft 卷只有行级提交事实（lesson 单题提交 /
 * v1 新协议逐题提交）会命中（legacy draft 恒 0）；非 draft 按整卷既有口径。
 */
export function pendingMarkCount(db: Db, attempt: PendingMarkAttempt): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attempt.id),
          ...pendingMarkConditions(attempt.status === "draft"),
        ),
      )
      .get()?.n ?? 0
  );
}

/**
 * 批量待批数：attemptId → 该 attempt 的待批题数（分组查询，500 id 一块）。
 * 结果 Map 只含有命中的 attempt（调用方按 `map.get(id) ?? 0` 取值）——
 * 无行级提交事实的 legacy draft 恒 0 不出现；lesson / v1 进行中卷有已提交
 * 待批行时出现。
 */
export function pendingMarkCounts(
  db: Db,
  attempts: readonly PendingMarkAttempt[],
): Map<string, number> {
  const map = new Map<string, number>();
  const idsOf = (draft: boolean) =>
    attempts
      .filter((attempt) => (attempt.status === "draft") === draft)
      .map((attempt) => attempt.id);
  // 非 draft（整卷已交）与 draft（lesson 进行中卷——行级 submittedAt 判定）
  // 两批各查一次；条件差异见 pendingMarkConditions 注释
  for (const [draft, ids] of [
    [false, idsOf(false)],
    [true, idsOf(true)],
  ] as const) {
    for (let start = 0; start < ids.length; start += 500) {
      const chunk = ids.slice(start, start + 500);
      for (const row of db
        .select({ attemptId: responses.attemptId, n: sql<number>`count(*)` })
        .from(responses)
        .where(
          and(
            inArray(responses.attemptId, chunk),
            ...pendingMarkConditions(draft),
          ),
        )
        .groupBy(responses.attemptId)
        .all()) {
        map.set(row.attemptId, row.n);
      }
    }
  }
  return map;
}

/**
 * 批量待自评数（两线收敛接线，v2 记录行「待自评」徽章的数据源）：attemptId →
 * 该 attempt 的待自评行数（分组查询，500 id 一块，与 pendingMarkCounts 同款
 * 模式）。QM 口径 = reference_self 行且教师未判（teacherMark null）且学生未
 * 自评（selfReviewVerdict null）——与 teacher-attempt-service 详情的
 * selfReviewPendingCount 读侧循环同一语义（有判定来源即归零，注释互指、口径
 * 不漂移；路由投影锁见 routes/student-records.test.ts QM-12 节），draft 批次
 * 同样叠加行级已提交（未提交行无自评入口）。
 */
export function pendingSelfReviewCounts(
  db: Db,
  attempts: readonly PendingMarkAttempt[],
): Map<string, number> {
  const map = new Map<string, number>();
  const idsOf = (draft: boolean) =>
    attempts
      .filter((attempt) => (attempt.status === "draft") === draft)
      .map((attempt) => attempt.id);
  for (const [draft, ids] of [
    [false, idsOf(false)],
    [true, idsOf(true)],
  ] as const) {
    for (let start = 0; start < ids.length; start += 500) {
      const chunk = ids.slice(start, start + 500);
      for (const row of db
        .select({ attemptId: responses.attemptId, n: sql<number>`count(*)` })
        .from(responses)
        .where(
          and(
            inArray(responses.attemptId, chunk),
            eq(responses.gradingPolicy, "reference_self"),
            isNull(responses.teacherMark),
            isNull(responses.selfReviewVerdict),
            isNotNull(responses.questionSnapshotJson),
            draft ? isNotNull(responses.submittedAt) : undefined,
          ),
        )
        .groupBy(responses.attemptId)
        .all()) {
        map.set(row.attemptId, row.n);
      }
    }
  }
  return map;
}

/**
 * v1 逐题卷「进行中进度」批量计数（M4-D3 §13）：attemptId → 行级已提交数 /
 * 本卷总行数（分组查询，500 id 一块，与 pendingMarkCounts 同款模式）。
 * - 调用方传**已按协议过滤的 v1 行**（协议判定统一走 practiceProtocolOf 单一
 *   谓词，本函数不重复协议分支）；传 legacy/lesson 行则按行级事实如实计数，
 *   不会报错（语义兜底：非 draft 收敛整卷口径）。
 * - 已收尾卷收敛为整卷口径（status ≠ draft ⇒ submitted = total）：正常
 *   整卷收尾本就对逐题语义卷的全部判分行写行级 submittedAt=交卷时刻
 *   （attempt-service 整卷收尾的 rowSubmittedAtPatch，lesson 与 v1 同款），
 *   行值已齐全；此处收敛是**防御性口径**——语义上「已收尾 = n/N 同为 N」
 *   恒成立，不依赖整卷收尾的写入事实，勿据「行值本就齐全」删掉收敛分支。
 * - 白名单纯公开进度计数：只读 submittedAt 与行数，绝不含对错/得分/答案列。
 * 结果 Map 只含有行命中的 attempt；零行卷（异常空卷）不出现，调用方按需回落。
 */
export function practiceSubmittedCounts(
  db: Db,
  attempts: readonly PendingMarkAttempt[],
): Map<string, { submitted: number; total: number }> {
  const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const map = new Map<string, { submitted: number; total: number }>();
  const ids = [...byId.keys()];
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    for (const row of db
      .select({
        attemptId: responses.attemptId,
        total: sql<number>`count(*)`,
        submitted: sql<number>`sum(case when ${responses.submittedAt} is not null then 1 else 0 end)`,
      })
      .from(responses)
      .where(inArray(responses.attemptId, chunk))
      .groupBy(responses.attemptId)
      .all()) {
      const attempt = byId.get(row.attemptId);
      if (attempt === undefined) continue;
      const total = Number(row.total);
      map.set(row.attemptId, {
        submitted: attempt.status === "draft" ? Number(row.submitted) : total,
        total,
      });
    }
  }
  return map;
}

/**
 * 按学生聚合的待批数（T-PR4 Web-4 学生列表「待批」列数据源）。与
 * pendingMarkCounts 的两批查询同一口径（公共条件 pendingMarkBaseConditions ×
 * draft/非 draft 的并集：非 draft 整卷恒「已交」，draft 批次只数行级已提交），
 * join attempts 后按 attempts.studentId 聚合；学生域筛选由调用方传本人名下
 * 学生 id；作废卷排除（与作答列表的 abandonedAt 口径一致）。
 * 结果 Map 只含有命中的学生；无待批行的学生不出现（调用方 `map.get(id) ?? 0`）。
 */
export function pendingMarkCountsByStudent(
  db: Db,
  studentIds: readonly string[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (studentIds.length === 0) return map;
  for (const row of db
    .select({ studentId: attempts.studentId, n: sql<number>`count(*)` })
    .from(responses)
    .innerJoin(attempts, eq(responses.attemptId, attempts.id))
    .where(
      and(
        inArray(attempts.studentId, [...studentIds]),
        isNull(attempts.abandonedAt),
        // draft / 非 draft 两批的并集口径：整卷已交恒「已交」，draft 只数行级已提交
        or(ne(attempts.status, "draft"), isNotNull(responses.submittedAt)),
        ...pendingMarkBaseConditions(false),
      ),
    )
    .groupBy(attempts.studentId)
    .all()) {
    map.set(row.studentId, row.n);
  }
  return map;
}
