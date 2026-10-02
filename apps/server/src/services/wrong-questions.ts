import type {
  TeacherAttemptSource,
  WrongQuestionCard,
  WrongQuestionRound,
  WrongQuestionsData,
  WrongQuestionsQuery,
} from "@tutor/contract";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  assignments,
  attempts,
  questions,
  responses,
  units,
} from "../db/schema";
import { serializeStudentAnswer } from "./mark-response";
import { studentTeacherIdOf } from "./student-course-service";
import { answerOf, snapshotOf, sourceOf } from "./teacher-attempt-service";

/**
 * 错题本业务层（T3.5，Phase3 清单 D11；2026-10 升级轮次史 + 归属单元）——
 * 按 (studentId, questionId) 跨全部来源（作业 + 课程练习）聚合，取该题**全部**
 * 已判定作答行构造轮次史：
 *
 * - 只统计**已判定**作答：已交卷（status != draft）且 finalCorrect 非 null
 *   （待批题不参与——免得一道待批题把旧的「错」盖成未知）；
 * - 入本条件：任一次已判定作答判错（覆盖「首次对 → 中间错 → 最近对」这类
 *   首末皆对但曾错的题）；默认只显示「最近一次判定仍为错」（resolved=false）；
 *   includeResolved=true 额外列出「曾错、最近一次已做对」（resolved=true）；
 * - rounds：该题全部已判定作答按时间升序（同刻按 attemptId 升序兜底稳定），
 *   每轮带来源标题/课程名（服务端算好展示串）；攻克判定 2026-10 起在端上从
 *   rounds 按学生自选标准计算（宽松=最后一轮对；严格=最后两轮连续对且 ≥2 轮），
 *   服务端不下发判定规则；
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
 * - originUnitId/originUnitTitle：题目**归属单元**（questions.unitId join
 *   units 取标题，按练习分组的依据——历史合并作业里的错题按题挂回各自单元）。
 *   软删题目/单元行仍在、标题照常可读；题目行缺失的防御为 null；
 * - knowledge 筛选：与条目展示同源（最近一次快照的 knowledge）**精确匹配**；
 * - 排序：最近判定时间倒序（questionId 升序兜底稳定）；无分页（单学生错题
 *   规模有限，与待批队列同口径）。
 *
 * 安全口径（AGENTS 第 3 条）：只含已交卷题目内容（未交卷题目绝无可能进入
 * 本聚合——draft attempt 已被谓词排除）；rounds/归属单元等新字段无教师侧
 * 敏感键（泄露测试见 routes/student-wrong-questions.test.ts，assertNoLeak +
 * after_due 场景 + 轮次史多轮场景）。
 */

/**
 * 错题本聚合（D11 + 2026-10 轮次史）。now 可注入（after_due gate 的定时测试；
 * 默认当前时刻——读时比较，截止后下一次请求自动把该作业的作答纳入聚合）。
 */
export function listWrongQuestions(
  db: Db,
  studentId: string,
  query: WrongQuestionsQuery,
  now: Date | string = new Date(),
): WrongQuestionsData {
  const nowIso = new Date(now).toISOString();
  const includeResolved = query.includeResolved ?? false;

  // 该学生全部已判定作答行（公布 gate 过滤后）。两个 id 列必须显式别名
  // （attempt_id / response_id）——裸列名都是 "id"，子查询结果对象里会互相覆盖，
  // 导致后续按 responseId 回读内容失败。首末/计数在 JS 侧按组内排序计算
  // （2026-10 起需要全部行构造 rounds，窗口函数取首末两行的方式随之退役）。
  const ranked = db
    .select({
      questionId: responses.questionId,
      attemptId: sql<string>`${attempts.id}`.as("attempt_id"),
      responseId: sql<string>`${responses.id}`.as("response_id"),
      submittedAt: attempts.submittedAt,
      startedAt: attempts.startedAt,
      finalCorrect: responses.finalCorrect,
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

  const rows = db.select().from(ranked).all();

  // 按题分组构造轮次（升序：submittedAt ?? startedAt，同刻 attemptId 升序——
  // 与旧窗口函数 order by 同口径，first/last 取组内首尾）
  const roundsByQuestion = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const list = roundsByQuestion.get(row.questionId) ?? [];
    list.push(row);
    roundsByQuestion.set(row.questionId, list);
  }
  for (const list of roundsByQuestion.values()) {
    list.sort(
      (a, b) =>
        (a.submittedAt ?? a.startedAt).localeCompare(
          b.submittedAt ?? b.startedAt,
        ) || a.attemptId.localeCompare(b.attemptId),
    );
  }

  // 候选：入本（任一次判错）+ 默认剔除已攻克（服务端口径=最近一次做对）
  const candidates = [...roundsByQuestion.entries()].filter(
    ([, rounds]) =>
      rounds.some((round) => round.finalCorrect === false) &&
      (includeResolved || rounds[rounds.length - 1]?.finalCorrect !== true),
  );

  // 候选题涉及的 attempt 与最近一次判定的 response（轮次来源上下文与条目内容）
  const attemptIdSet = new Set<string>();
  const lastResponseIdByQuestion = new Map<string, string>();
  for (const [questionId, rounds] of candidates) {
    for (const round of rounds) attemptIdSet.add(round.attemptId);
    const last = rounds[rounds.length - 1];
    if (last !== undefined) {
      lastResponseIdByQuestion.set(questionId, last.responseId);
    }
  }
  const attemptById = new Map(
    attemptIdSet.size > 0
      ? db
          .select()
          .from(attempts)
          .where(inArray(attempts.id, [...attemptIdSet]))
          .all()
          .map((row) => [row.id, row] as const)
      : [],
  );
  const lastResponseById = new Map(
    lastResponseIdByQuestion.size > 0
      ? db
          .select()
          .from(responses)
          .where(inArray(responses.id, [...lastResponseIdByQuestion.values()]))
          .all()
          .map((row) => [row.id, row] as const)
      : [],
  );
  const teacherId = studentTeacherIdOf(db, studentId);

  // 归属单元：questions（软删行仍在）join units（复合主键 (teacherId, id)，标题
  // 软删后仍可读）。题目行缺失 → 不进 map → 卡片防御为 null；teacherId 缺失
  // （学生行异常）同样整组置 null，不打挂接口。
  const originByQuestion = new Map<
    string,
    { unitId: string; unitTitle: string | null }
  >();
  if (teacherId !== null && candidates.length > 0) {
    const originRows = db
      .select({
        questionId: questions.id,
        unitId: questions.unitId,
        unitTitle: units.title,
      })
      .from(questions)
      .leftJoin(
        units,
        and(
          eq(units.teacherId, questions.teacherId),
          eq(units.id, questions.unitId),
        ),
      )
      .where(
        and(
          eq(questions.teacherId, teacherId),
          inArray(
            questions.id,
            candidates.map(([questionId]) => questionId),
          ),
        ),
      )
      .all();
    for (const row of originRows) {
      originByQuestion.set(row.questionId, {
        unitId: row.unitId,
        unitTitle: row.unitTitle,
      });
    }
  }

  const cards: WrongQuestionCard[] = [];
  // 轮次来源上下文：按 attempt 缓存 sourceOf（同一 attempt 常覆盖多题，跨题复用；
  // sourceOf 内含 units/courses/assignments 单行查询，缓存避免逐轮重复查库）
  const sourceByAttemptId = new Map<string, TeacherAttemptSource>();
  const sourceOfAttempt = (attemptId: string): TeacherAttemptSource | null => {
    const cached = sourceByAttemptId.get(attemptId);
    if (cached !== undefined) return cached;
    const attempt = attemptById.get(attemptId);
    if (attempt === undefined) return null;
    const source = sourceOf(db, attempt, teacherId ?? "");
    sourceByAttemptId.set(attemptId, source);
    return source;
  };
  for (const [questionId, rounds] of candidates) {
    const first = rounds[0];
    const last = rounds[rounds.length - 1];
    const lastResponse =
      last === undefined ? undefined : lastResponseById.get(last.responseId);
    // 防御：join 回读必命中（主查询行来自这两张表）；坏数据跳过不打挂接口
    if (
      first === undefined ||
      last === undefined ||
      lastResponse === undefined
    ) {
      continue;
    }
    const lastSource = sourceOfAttempt(last.attemptId);
    if (lastSource === null) continue; // 来源 attempt 行缺失的防御（理论不可达）
    const snapshot = snapshotOf(lastResponse);
    if (snapshot === null) continue; // 坏快照按缺失计（snapshotOf 内留痕）
    // knowledge 筛选：与展示同源（最近一次快照）精确匹配
    if (
      query.knowledge !== undefined &&
      !snapshot.knowledge.includes(query.knowledge)
    ) {
      continue;
    }
    const roundsPayload: WrongQuestionRound[] = [];
    for (const round of rounds) {
      const source = sourceOfAttempt(round.attemptId);
      if (source === null) continue; // 防御：轮次行必来自已加载 attempt
      roundsPayload.push({
        attemptId: round.attemptId,
        sourceType: source.sourceType,
        correct: round.finalCorrect === true,
        submittedAt: round.submittedAt ?? round.startedAt,
        sourceTitle: roundSourceTitle(source),
        courseName: source.courseName,
      });
    }
    const origin = originByQuestion.get(questionId);
    cards.push({
      ...lastSource,
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
      rounds: roundsPayload,
      wrongCount: roundsPayload.filter((round) => !round.correct).length,
      correctCount: roundsPayload.filter((round) => round.correct).length,
      originUnitId: origin?.unitId ?? null,
      originUnitTitle: origin?.unitTitle ?? null,
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

/**
 * 轮次来源标题（服务端算好的展示串）：作业=作业标题；课程练习=「单元标题 ·
 * 第 n 次」。与前端 records-views.recordTitleOf 同口径（展示约定在
 * teacherAttemptSourceSchema 注释；跨端小格式化函数不进契约包，注释互指）。
 */
function roundSourceTitle(source: TeacherAttemptSource): string {
  if (source.sourceType === "assignment") {
    return source.assignmentTitle ?? "（作业已删除）";
  }
  return `${source.unitTitle ?? ""} · 第 ${source.attemptNo} 次`;
}
