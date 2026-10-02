import { randomUUID } from "node:crypto";
import type { AttemptStartData } from "@tutor/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, type ResponseRow, responses } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { attemptSummaryOf } from "./attempt-service";
import { snapshotOf } from "./teacher-attempt-service";
import { latestJudgedResponsesByQuestion } from "./wrong-questions";

/**
 * 错题重练组卷（2026-10 学生端闭环的最后一块）——POST /api/student/wrong-practice
 * 的业务层。产品口径：**重练范围由前端圈定**（错题本当前 tab + 分组的题目 id，
 * 顺序即组卷题序），服务端只做校验与组卷：
 *
 * - 校验：每个 questionId ∈ 该生错题本聚合（latestJudgedResponsesByQuestion，
 *   入本条件与 listWrongQuestions 完全一致——任一次已判定作答判错；includeResolved
 *   全量口径，已攻克的题同样可重练）**且最近一次判定作答的快照可用**
 *   （questionSnapshotJson 可解析，snapshotOf 同口径）。不满足的题**静默剔除**
 *   （不在聚合内 = 从未错过/公布 gate 挡住的题，不给信息量）；剔完为空 →
 *   400 WRONG_PRACTICE_EMPTY；
 * - 组卷（快照冻结口径）：练的就是**当时做错的那道题**——每题复制最近一次判定
 *   作答 responses 行的 questionSnapshotJson / questionVersion 进新 attempt 的
 *   自有 responses 行（题序 = questionIds 去重后的顺序 = 插入顺序，读路径按
 *   rowid 升序还原，见 db/schema.ts responses 表注释）。教师此后改题库/软删题
 *   不影响已建的卷与判分（判分输入 = 冻结快照，不查 questions 表）；
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
): AttemptStartData {
  // 去重保序（契约不拦重复 id；前端从聚合结果取 id 天然无重复，防御性收敛）
  const uniqueIds = [...new Set(questionIds)];

  // 该生错题本聚合内的题 → 最近一次判定作答行（快照来源）
  const latestByQuestion = latestJudgedResponsesByQuestion(db, studentId);

  /** 逐题校验：在聚合内且快照可用，否则剔除 */
  const pickOf = (questionId: string): ResponseRow | null => {
    const source = latestByQuestion.get(questionId);
    if (source === undefined) return null; // 不在聚合内（从未错过/公布 gate 挡住）
    return snapshotOf(source) !== null ? source : null; // 坏快照不可组卷
  };
  const picked = uniqueIds
    .map((questionId) => pickOf(questionId))
    .filter((row): row is ResponseRow => row !== null);

  if (picked.length === 0) {
    throw new HttpError(
      400,
      "WRONG_PRACTICE_EMPTY",
      "这些题目不在你的错题本里（或状态有变），请刷新后再试",
    );
  }

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

    const id = randomUUID();
    tx.insert(attempts)
      .values({
        id,
        studentId,
        sourceType: "wrong",
        // 契约来源不变式（attempt.ts superRefine）：wrong 三归属键恒 null
        assignmentId: null,
        courseId: null,
        unitId: null,
        attemptNo,
        status: "draft",
        startedAt: new Date().toISOString(),
        submittedAt: null,
        activeSec: null,
        device: null,
        scoreAuto: null,
        scoreFinal: null,
      })
      .run();
    // 建卷即冻结：逐题复制最近一次判定作答的快照（插入顺序 = 组卷题序）
    for (const source of picked) {
      tx.insert(responses)
        .values({
          id: randomUUID(),
          attemptId: id,
          questionId: source.questionId,
          questionVersion: source.questionVersion,
          questionSnapshotJson: source.questionSnapshotJson,
          answerJson: null,
          autoCorrect: null,
          finalCorrect: null,
          teacherMark: null,
          teacherComment: null,
          activeSec: null,
          hintsUsed: 0,
          changeCount: 0,
          inkId: null,
          hintsOpenedJson: null,
        })
        .run();
    }
    const row = tx.select().from(attempts).where(eq(attempts.id, id)).get();
    if (row === undefined) {
      throw new HttpError(500, "INTERNAL", "创建作答失败，请重试");
    }
    return attemptSummaryOf(row);
  });
}
