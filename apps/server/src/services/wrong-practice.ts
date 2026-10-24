import { randomUUID } from "node:crypto";
import type { AttemptStartData } from "@tutor/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, type ResponseRow, students } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  frozenGradingPolicyOf,
  wrongAttemptContextPlan,
} from "./attempt-context.ts";
import {
  type AttemptWorkflowStartOptions,
  attemptSummaryOf,
  insertFrozenResponse,
  newDraftAttempt,
  workflowStartColumns,
} from "./attempt-service";
import { newContentEnabledFromEnv } from "./import-qm.ts";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import { snapshotOfRow } from "./snapshot";
import { latestJudgedResponsesByQuestion } from "./wrong-questions";

/**
 * 错题重练组卷（2026-10 学生端闭环的最后一块）——POST /api/student/wrong-practice
 * 的业务层。产品口径：**重练范围由前端圈定**（错题本当前 tab + 分组的题目 id，
 * 顺序即组卷题序），服务端只做校验与组卷：
 *
 * - 校验：每个 questionId ∈ 该生错题本聚合（latestJudgedResponsesByQuestion，
 *   入本条件与 listWrongQuestions 完全一致——任一次已判定作答判错；includeResolved
 *   全量口径，已攻克的题同样可重练）**且最近一次判定作答的快照可用**
 *   （questionSnapshotJson 可解析，snapshotOfRow 同口径）。不满足的题**静默剔除**
 *   （不在聚合内 = 从未错过/公布 gate 挡住的题，不给信息量）；剔完为空 →
 *   400 WRONG_PRACTICE_EMPTY；
 * - 组卷（快照冻结口径）：练的就是**当时做错的那道题**——每题复制最近一次判定
 *   作答 responses 行的 questionSnapshotJson / questionVersion 进新 attempt 的
 *   自有 responses 行（题序 = questionIds 去重后的顺序 = 插入顺序，读路径按
 *   rowid 升序还原，见 db/schema.ts responses 表注释）。教师此后改题库/软删题
 *   不影响已建的卷与判分（判分输入 = 冻结快照，不查 questions 表）。tt-07a
 *   （QM-06）起材料/组依赖同事务冻结（来源卷快照优先——错题时学生所见的
 *   版本），gradingPolicy 按复制的来源快照逐行写入（§5.6/§5.8.4 开关控制）；
 * - attempt 行：sourceType='wrong'、assignmentId/courseId/unitId 恒 null（契约
 *   superRefine 锁定；无课程归属 → **永不失权**，草稿与记录一直可见）；
 *   attemptNo = 该生已有 wrong 来源 attempt 数 + 1（从 1 起）；不限制同时存在
 *   多份未交卷的 wrong 卷（每次重练都是独立新卷，互不影响，旧草稿从记录页
 *   续作）；
 * - 作答/判分/批改全复用既有机制（AttemptSession、submit、grading、教师待批
 *   队列）：wrong 来源的填空待批题照常进教师队列，全部判定后 status=graded；
 *   交卷后自动成为错题本新一轮（聚合按 (学生, 题目) 自然纳入）。
 *
 * 安全口径（AGENTS 第 3 条）：新卷只携带题目快照（服务端行内数据），响应本体是
 * attempt 摘要（无任何题目内容）；未交卷详情/试卷照旧走 attempt-service 的
 * 公开投影（publicOfSnapshot），泄露测试见 routes/student-wrong-practice.test.ts。
 */
export function startWrongPractice(
  db: Db,
  studentId: string,
  questionIds: readonly string[],
  options: AttemptWorkflowStartOptions = {},
  /** tt-07a：判分策略写入开关（缺省读部署 env，§5.8.4）；测试显式注入 */
  newContentEnabled?: boolean,
): AttemptStartData {
  // 去重保序（契约不拦重复 id；前端从聚合结果取 id 天然无重复，防御性收敛）
  const uniqueIds = [...new Set(questionIds)];

  // 该生错题本聚合内的题 → 最近一次判定作答行（快照来源）
  const latestByQuestion = latestJudgedResponsesByQuestion(db, studentId);

  /** 逐题校验：在聚合内且快照可用，否则剔除 */
  const pickOf = (questionId: string): ResponseRow | null => {
    const source = latestByQuestion.get(questionId);
    if (source === undefined) return null; // 不在聚合内（从未错过/公布 gate 挡住）
    return snapshotOfRow(source) !== null ? source : null; // 坏快照不可组卷
  };
  const picked = uniqueIds
    .map((questionId) => pickOf(questionId))
    .filter((row): row is ResponseRow => row !== null);

  // tt-07a（QM-06）：错题重练的依赖冻结走本单统一路径（设计方案 §5.3「错题
  // 重练复制来源作答的该子题及必要材料/说明」）——依赖条目**来源卷快照优先**
  // （错题时学生所见的版本），来源卷无快照回退 live 当前版本；依赖在两边都
  // 不可得（教师软删且来源卷未冻结）→ 该题剔除（学生自助重练不整卷失败）
  const teacherId =
    db
      .select({ teacherId: students.teacherId })
      .from(students)
      .where(eq(students.id, studentId))
      .get()?.teacherId ?? null;
  const plan = wrongAttemptContextPlan(db, teacherId, picked);

  if (picked.length === 0 || plan.usable.length === 0) {
    throw new HttpError(
      400,
      "WRONG_PRACTICE_EMPTY",
      "这些题目不在你的错题本里（或状态有变），请刷新后再试",
    );
  }

  const freezePolicy =
    newContentEnabled ?? newContentEnabledFromEnv();

  return db.transaction((tx) => {
    const countRow = tx
      .select({ n: sql<number>`count(*)` })
      .from(attempts)
      .where(
        and(
          eq(attempts.studentId, studentId),
          eq(attempts.sourceType, "wrong"),
        ),
      )
      .get();
    const attemptNo = (countRow?.n ?? 0) + 1;

    // T6R.3：行字面量复用 newDraftAttempt（三来源建卷共用；wrong 三归属键恒
    // null——契约来源不变式，frozenAt=startedAt 建卷即冻结，快照在下方逐题预插）
    const attempt = newDraftAttempt({
      id: randomUUID(),
      studentId,
      sourceType: "wrong",
      assignmentId: null,
      courseId: null,
      unitId: null,
      attemptNo,
      startedAt: new Date().toISOString(),
      // M1b：显式 workflowVersion=1 按教师策略裁决写新协议列；省略旧协议
      ...workflowStartColumns(db, "wrong", studentId, null, options),
    });
    const id = attempt.id;
    tx.insert(attempts).values(attempt).run();
    // 建卷即冻结：逐题复制最近一次判定作答的快照（插入顺序 = 组卷题序）。
    // 行写入复用 attempt-service 的 insertFrozenResponse（15 列字面量全服务端
    // 唯一处；wrong 卷 unitId 恒 null——卷无单元语义）。tt-07a：gradingPolicy
    // 按复制的来源快照逐行写入（frozenGradingPolicyOf 单一出处，§5.8.4 开关
    // 控制 NULL=旧语义）——判分策略与题目本体同源自冻结，教师事后改题不影响
    for (const source of plan.usable) {
      const snapshotJson = source.questionSnapshotJson;
      const snapshot = snapshotOfRow(source); // pickOf 已校验可解析，防御性收敛
      if (snapshotJson === null || snapshot === null) continue;
      insertFrozenResponse(tx, {
        attemptId: id,
        questionId: source.questionId,
        questionVersion: source.questionVersion,
        questionSnapshotJson: snapshotJson,
        unitId: null,
        gradingPolicy: frozenGradingPolicyOf(snapshot, freezePolicy),
      });
    }
    // 依赖闭包条目（来源卷快照优先）同事务冻结——开卷途中失败全回滚
    freezeAttemptContextSnapshotsWithin(tx, id, plan.entries, attempt.startedAt);
    const row = tx.select().from(attempts).where(eq(attempts.id, id)).get();
    if (row === undefined) {
      throw new HttpError(500, "INTERNAL", "创建作答失败，请重试");
    }
    return attemptSummaryOf(row);
  });
}
