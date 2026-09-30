import type {
  WrongQuestionCard,
  WrongQuestionsData,
  WrongQuestionsQuery,
} from "@tutor/contract";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { assignments, attempts, responses } from "../db/schema";
import { serializeStudentAnswer } from "./mark-response";
import { studentTeacherIdOf } from "./student-course-service";
import { answerOf, snapshotOf, sourceOf } from "./teacher-attempt-service";

/**
 * 错题本业务层（T3.5，Phase3 清单 D11）——按 (studentId, questionId) 跨全部来源
 * （作业 + 课程练习）聚合，SQL 层分组取「首次」与「最近」两条已判定作答：
 *
 * - 只统计**已判定**作答：已交卷（status != draft）且 finalCorrect 非 null
 *   （待批题不参与——免得一道待批题把旧的「错」盖成未知）；
 * - 入本条件：任一次已判定作答判错（sum(finalCorrect=0) > 0 的窗口聚合，
 *   覆盖「首次对 → 中间错 → 最近对」这类首末皆对但曾错的题）；
 * - 默认只显示「最近一次判定仍为错」（resolved=false）；includeResolved=true
 *   额外列出「曾错、最近一次已做对」（resolved=true）；
 * - 公布 gate（answer-release 的 SQL 化）：after_due 未公布的作业 attempt
 *   **整体不参与聚合**——否则题目出现在错题本就等于泄露了对错。判定与
 *   attempt-service.answersReleased 纯函数逐条对应：作业 answerRelease 非
 *   after_due、或 dueAt 已到（≤ now）才算已公布；course 来源恒参与（D11 交卷
 *   即公布）。leftJoin 保证 course 行不被 NULL 三值逻辑误伤；
 * - 条目内容（题干/题型/难度/考点/参考答案/详解）取**最近一次判定作答**的
 *   questionSnapshotJson 快照（含 [[答案]] 标记原文——已交卷内容允许下发，
 *   与结果视图同一口径；坏快照按缺失计跳过并留痕，snapshotOf 同口径）；
 * - answerText：本人最近答案的序列化文本（serializeStudentAnswer，与教师端
 *   待批卡片/CSV 导出同一口径）；来源上下文取最近一次判定作答所属 attempt；
 * - knowledge 筛选：与条目展示同源（最近一次快照的 knowledge）**精确匹配**；
 * - 排序：最近判定时间倒序（questionId 升序兜底稳定）；无分页（单学生错题
 *   规模有限，与待批队列同口径）。
 *
 * 安全口径（AGENTS 第 3 条）：只含已交卷题目内容（未交卷题目绝无可能进入
 * 本聚合——draft attempt 已被谓词排除）；泄露测试见
 * routes/student-wrong-questions.test.ts（assertNoLeak + after_due 场景）。
 */

/**
 * 错题本聚合（D11）。now 可注入（after_due gate 的定时测试；默认当前时刻——
 * 读时比较，截止后下一次请求自动把该作业的作答纳入聚合）。
 */
export function listWrongQuestions(
  db: Db,
  studentId: string,
  query: WrongQuestionsQuery,
  now: Date | string = new Date(),
): WrongQuestionsData {
  const nowIso = new Date(now).toISOString();
  const includeResolved = query.includeResolved ?? false;

  // 窗口聚合：每个 questionId 一组，rn_asc=首次（submittedAt 最早）、rn_desc=最近，
  // wrong_count=该题已判定作答中的判错次数（入本条件）。同刻并列按 attemptId
  // 升序/降序兜底稳定（同一 attempt 内一题至多一行，唯一索引保证）。
  const ranked = db
    .select({
      questionId: responses.questionId,
      attemptId: attempts.id,
      responseId: responses.id,
      submittedAt: attempts.submittedAt,
      startedAt: attempts.startedAt,
      finalCorrect: responses.finalCorrect,
      rnAsc:
        sql<number>`row_number() over (partition by ${responses.questionId} order by ${attempts.submittedAt} asc, ${attempts.id} asc)`.as(
          "rn_asc",
        ),
      rnDesc:
        sql<number>`row_number() over (partition by ${responses.questionId} order by ${attempts.submittedAt} desc, ${attempts.id} desc)`.as(
          "rn_desc",
        ),
      wrongCount:
        sql<number>`sum(iif(${responses.finalCorrect} = 0, 1, 0)) over (partition by ${responses.questionId})`.as(
          "wrong_count",
        ),
    })
    .from(responses)
    .innerJoin(attempts, eq(responses.attemptId, attempts.id))
    // 公布 gate 的作业维度（course 行 leftJoin 不命中；FK 保证 assignment 来源必命中）
    .leftJoin(assignments, eq(attempts.assignmentId, assignments.id))
    .where(
      and(
        eq(attempts.studentId, studentId),
        // 已判定作答谓词（D11）：已交卷 + finalCorrect 非 null（待批不参与）
        ne(attempts.status, "draft"),
        isNotNull(responses.finalCorrect),
        // 公布 gate（answersReleased 的 SQL 化，见模块头注释）：未公布的作业
        // attempt 整体排除。or 的三分支覆盖 course / 非 after_due / 已到截止；
        // leftJoin 未命中时 answerRelease 为 NULL → isNull 分支放行（防御口径：
        // assignment 来源经 FK 必命中，NULL 只可能是 course 行）
        or(
          eq(attempts.sourceType, "course"),
          isNull(assignments.answerRelease),
          ne(assignments.answerRelease, "after_due"),
          and(
            isNotNull(assignments.dueAt),
            sql`${assignments.dueAt} <= ${nowIso}`,
          ),
        ),
      ),
    )
    .as("ranked");

  const rows = db
    .select()
    .from(ranked)
    .where(or(eq(ranked.rnAsc, 1), eq(ranked.rnDesc, 1)))
    .all();

  const firstByQuestion = new Map<string, (typeof rows)[number]>();
  const lastByQuestion = new Map<string, (typeof rows)[number]>();
  const wrongCountByQuestion = new Map<string, number>();
  for (const row of rows) {
    wrongCountByQuestion.set(row.questionId, row.wrongCount);
    if (row.rnAsc === 1) firstByQuestion.set(row.questionId, row);
    if (row.rnDesc === 1) lastByQuestion.set(row.questionId, row);
  }

  // 候选：入本（任一次判错）+ 默认剔除已攻克
  const candidates = [...lastByQuestion.entries()].filter(
    ([questionId, last]) =>
      (wrongCountByQuestion.get(questionId) ?? 0) > 0 &&
      (includeResolved || last.finalCorrect !== true),
  );

  // 最近一次判定作答的完整行与所属 attempt（内容与来源上下文取最近一次）
  const lastResponseById = new Map(
    candidates.length > 0
      ? db
          .select()
          .from(responses)
          .where(
            inArray(
              responses.id,
              candidates.map(([, last]) => last.responseId),
            ),
          )
          .all()
          .map((row) => [row.id, row] as const)
      : [],
  );
  const attemptById = new Map(
    candidates.length > 0
      ? db
          .select()
          .from(attempts)
          .where(
            inArray(attempts.id, [
              ...new Set(candidates.map(([, last]) => last.attemptId)),
            ]),
          )
          .all()
          .map((row) => [row.id, row] as const)
      : [],
  );
  const teacherId = studentTeacherIdOf(db, studentId);

  const cards: WrongQuestionCard[] = [];
  for (const [questionId, last] of candidates) {
    const first = firstByQuestion.get(questionId);
    const lastResponse = lastResponseById.get(last.responseId);
    const lastAttempt = attemptById.get(last.attemptId);
    // 防御：join 回读必命中（主查询行来自这两张表）；坏数据跳过不打挂接口
    if (
      first === undefined ||
      lastResponse === undefined ||
      lastAttempt === undefined
    ) {
      continue;
    }
    const snapshot = snapshotOf(lastResponse);
    if (snapshot === null) continue; // 坏快照按缺失计（snapshotOf 内留痕）
    // knowledge 筛选：与展示同源（最近一次快照）精确匹配
    if (
      query.knowledge !== undefined &&
      !snapshot.knowledge.includes(query.knowledge)
    ) {
      continue;
    }
    cards.push({
      ...sourceOf(db, lastAttempt, teacherId ?? ""),
      questionId,
      type: snapshot.type,
      difficulty: snapshot.difficulty,
      knowledge: snapshot.knowledge,
      stemMd: snapshot.stemMd,
      ...(snapshot.options !== undefined
        ? { options: snapshot.options.map((option) => option.text) }
        : {}),
      answers: snapshot.answers ?? null,
      solutionMd: snapshot.solutionMd ?? null,
      answerText: serializeStudentAnswer(answerOf(lastResponse.answerJson)),
      firstCorrect: first.finalCorrect === true,
      resolved: last.finalCorrect === true,
      firstAt: first.submittedAt ?? first.startedAt,
      lastAt: last.submittedAt ?? last.startedAt,
    });
  }

  // 最近判定时间倒序（questionId 升序兜底稳定）
  cards.sort(
    (a, b) =>
      b.lastAt.localeCompare(a.lastAt) ||
      a.questionId.localeCompare(b.questionId),
  );
  return { questions: cards };
}
