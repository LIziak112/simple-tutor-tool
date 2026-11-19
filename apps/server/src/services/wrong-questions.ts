import {
  type TeacherAttemptSource,
  type WrongQuestionCard,
  type WrongQuestionRound,
  type WrongQuestionsData,
  type WrongQuestionsQuery,
  wrongAttemptTitleOf,
} from "@tutor/contract";
import { studentStemMd } from "@tutor/md-dsl";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, questions, units } from "../db/schema";
import { answerOf } from "./attempt-service";
import { serializeStudentAnswerOfRow } from "./mark-response";
import { countsAsWrong } from "./response-verdict.ts";
import { releaseOfSnapshot, snapshotOfRow } from "./snapshot";
import { studentTeacherIdOf } from "./student-course-service";
import { sourceOf } from "./teacher-attempt-service";
import {
  effectiveOfRound,
  enteredWrongBook,
  pendingCountByQuestion,
  type WrongRoundFacts,
  withWrongQuestionRounds,
} from "./wrong-question-rounds.ts";

/**
 * 错题本业务层（T3.5，Phase3 清单 D11；2026-10 升级轮次史 + 归属单元）——
 * 按 (studentId, questionId) 跨全部来源（作业 + 课程练习）聚合，取该题**全部**
 * 已判定作答行构造轮次史：
 *
 * - 只统计**已判定**作答：已交卷（status != draft）且有效判定非 null
 *   （QM-12 起统一有效判定投影：教师判 > 自评 > 自动——reference_self 行
 *   按学生自评计为已判定轮；未判断题不参与——免得一道待评题把旧的「错」
 *   盖成未知）；
 * - 入本条件：任一次已判定作答「答了且判错」或「标了不会」（enteredWrongBook
 *   单一出处，#6980-3/#6980-4：未做轮 answered=false 不入本，但人工显式判定
 *   〔teacherMark / 自评 verdict〕不被「未做」掩盖——老师显式批错、自评「错」
 *   的行照常入本；标过「不会」的轮无论对错与是否作答都保留；覆盖「首次对 →
 *   中间错 → 最近对」这类首末皆对但曾错的题）；默认只显示「最近一次有效
 *   判定仍为错或标了不会」（resolved=false）；includeResolved=true 额外列出
 *   「曾错、最近一次已做对」（resolved=true）；

 * - rounds：该题全部已判定作答按时间升序（同刻按 attemptId 升序兜底稳定），
 *   每轮带来源标题/课程名（服务端算好展示串）与 courseId（与 courseName 同一
 *   处 sourceOf 取值：course=练习课程、assignment=作业所属课程〔attempt 冗余
 *   列优先、为空回退作业行〕、wrong 恒 null——「按课程筛选错题」按任一轮
 *   courseId 求集合）；攻克判定 2026-10 起在端上从 rounds 按学生自选标准计算
 *   （宽松=最后一轮对；严格=最后两轮连续对且 ≥2 轮），服务端不下发判定规则；
 * - pendingCount：该题已交卷、待老师判定（finalCorrect IS NULL）的作答轮数
 *   （D4 共享谓词 × 公布 gate）——待批轮不进 rounds，本字段补足「做了 4 次
 *   只有 3 轮」的差额；draft 不计；
 * - 公布 gate（answer-release 的 SQL 化）：after_due 未公布的作业 attempt
 *   **整体不参与聚合**——否则题目出现在错题本就等于泄露了对错。判定与
 *   attempt-service.answersReleased 纯函数逐条对应：作业 answerRelease 非
 *   after_due、或 dueAt 已到（≤ now）才算已公布；course 来源恒参与（D11 交卷
 *   即公布）。leftJoin 保证 course 行不被 NULL 三值逻辑误伤；
 * - 条目内容（题干/题型/难度/考点/参考答案/详解）取**最近一次判定作答**的
 *   questionSnapshotJson 快照（含 [[答案]] 标记原文——已交卷内容允许下发，
 *   与结果视图同一口径；坏快照按缺失计跳过并留痕，snapshotOfRow 同口径）；
 * - answerText：本人最近答案的序列化文本（serializeStudentAnswerOfRow，
 *   与教师端待批卡片/CSV 导出/学情包同一单源）；来源上下文取最近一次判定
 *   作答所属 attempt；
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
/**
 * Asia/Shanghai 自然日截点（含今天，往前 days-1 天的当天零点，转 UTC ISO）：
 * 页面「最近 N 天」筛选（wrong-questions-ui.filterWrongQuestions 的 days 口径）
 * 与学生 MCP list_my_wrong_questions 的 sinceDays 共用本语义——上海无夏令时、
 * 固定 +08:00，可直接算术（评审修复：此前 MCP 用 now−N×24h 滚动窗口，与页面
 * 自然日同词不同义，最多差约 24 小时）。
 */
export function shanghaiNaturalDayCutoffIso(
  days: number,
  now: Date = new Date(),
): string {
  const shifted = new Date(now.getTime() + 8 * 3_600_000);
  const todayStartUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  // Date.UTC 得到的是北京日期的 UTC 零点，再减 8h 才是北京当天零点
  return new Date(
    todayStartUtc - 8 * 3_600_000 - (days - 1) * 86_400_000,
  ).toISOString();
}

/** 真实页面和目录共享聚合，课程与自然日筛选仍由已有目录使用。 */
interface WrongQuestionsListOptions {
  readonly dataDir?: string;
  /** 只保留任一轮发生在该课程的题（与页面 filterWrongQuestionsByCourse 同谓词） */
  readonly courseId?: string;
  /** 只保留最近 N 个自然日（含今天，Asia/Shanghai）内有判定的题 */
  readonly sinceDays?: number;
}

export function listWrongQuestions(
  db: Db,
  studentId: string,
  query: WrongQuestionsQuery,
  now: Date | string = new Date(),
  /** 2026-10 评审修复：courseId/sinceDays 下沉服务层单源谓词（此前在 MCP 层第三套实现） */
  options?: WrongQuestionsListOptions,
): WrongQuestionsData {
  return withWrongQuestionRounds(
    db,
    studentId,
    now,
    {
      ...options,
      ...(query.knowledge === undefined ? {} : { knowledge: query.knowledge }),
    },
    (facts) => cardsFromRounds(db, studentId, query, now, options, facts),
  );
}

function cardsFromRounds(
  db: Db,
  studentId: string,
  query: WrongQuestionsQuery,
  now: Date | string,
  filters: WrongQuestionsListOptions | undefined,
  { roundsByQuestion, responsesById, kernelTables }: WrongRoundFacts,
): WrongQuestionsData {
  const includeResolved = query.includeResolved ?? false;

  // 待批轮数（pendingCount）：与轮次查询同一公布 gate、同一 now（见
  // pendingCountByQuestion 注释）；查出后按题取值 ?? 0
  const pendingCounts = pendingCountByQuestion(
    db,
    studentId,
    now,
    kernelTables,
  );

  // 候选：入本（enteredWrongBook 单一出处——答了且判错 / 标了不会）+
  // 默认剔除已攻克（服务端口径=最近一次有效判定做对）
  const candidates = [...roundsByQuestion.entries()].filter(([, rounds]) => {
    if (!enteredWrongBook(rounds)) return false;
    if (includeResolved) return true;
    // 已攻克口径与端上 isConquered（宽松标准）同源：最近一轮有效判定做对且
    // 实际作答且未标「不会」才算攻克——标过不会的做对轮不算攻克
    // （#6980-4 审查 P1-4）；QM-12 起做对走有效判定（教师判 > 自评 > 自动）
    const last = rounds[rounds.length - 1];
    return !(
      last !== undefined &&
      effectiveOfRound(last)?.value === true &&
      last.answered &&
      last.studentFlag !== "unsure"
    );
  });

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
  const lastResponseById = responsesById([
    ...lastResponseIdByQuestion.values(),
  ]);
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
    const snapshot = snapshotOfRow(lastResponse);
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
        ...(round.reviewSource !== undefined
          ? { reviewSource: round.reviewSource }
          : {}),
        attemptId: round.attemptId,
        sourceType: source.sourceType,
        // 有效判定（教师判 > 自评 > 自动）——自评「错」即错轮（QM-12）
        correct: effectiveOfRound(round)?.value === true,
        answered: round.answered,
        studentFlag: round.studentFlag === "unsure" ? "unsure" : null,
        submittedAt: round.submittedAt ?? round.startedAt,
        sourceTitle: roundSourceTitle(source),
        // 与 courseName 同一处（sourceOf）取值：course=练习课程、assignment=
        // 作业所属课程（attempt 冗余列优先、为空回退作业行）、wrong 恒 null
        courseId: source.courseId,
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
      stemMd: studentStemMd(snapshot),
      ...(snapshot.options !== undefined
        ? { options: snapshot.options.map((option) => option.text) }
        : {}),
      ...releaseOfSnapshot(snapshot),
      // P3-5：与待批队列/CSV/学情包/单题包同走行级序列化单源（matching/ordering
      // 按冻结结构装配「第 N 空 = 选项正文」/项正文串联；旧七型输出逐字不变）
      answerText: serializeStudentAnswerOfRow(
        db,
        last.attemptId,
        lastResponse,
        answerOf(lastResponse.answerJson),
      ),
      firstCorrect: effectiveOfRound(first)?.value === true,
      // 已攻克（宽松口径，与默认过滤同源）：最近一轮有效判定做对且实际作答且
      // 未标「不会」——标过不会的做对轮不算攻克（#6980-4 审查 P1-4）
      resolved:
        effectiveOfRound(last)?.value === true &&
        last.answered &&
        last.studentFlag !== "unsure",
      firstAt: first.submittedAt ?? first.startedAt,
      lastAt: last.submittedAt ?? last.startedAt,
      rounds: roundsPayload,
      // #6980-3：错次只计「答了且判错」的轮（未做轮不计错次）；判错走 QM-12
      // 有效判定；人工显式判定的未做轮不被掩盖（审查修复 P0-1：老师批错/
      // 自评判错的行照常计错次）
      wrongCount: rounds.filter((round) =>
        countsAsWrong(effectiveOfRound(round), round.answered),
      ).length,
      correctCount: roundsPayload.filter((round) => round.correct).length,
      pendingCount: pendingCounts.get(questionId) ?? 0,
      originUnitId: origin?.unitId ?? null,
      originUnitTitle: origin?.unitTitle ?? null,
    });
  }

  // 组卷配套过滤（服务层单源谓词；页面同口径在端上本地过滤，语义以本处为准）
  let visible = cards;
  if (filters?.courseId !== undefined) {
    const courseId = filters.courseId;
    visible = visible.filter((card) =>
      card.rounds.some((round) => round.courseId === courseId),
    );
  }
  if (filters?.sinceDays !== undefined) {
    const cutoff = shanghaiNaturalDayCutoffIso(
      filters.sinceDays,
      typeof now === "string" ? new Date(now) : now,
    );
    visible = visible.filter((card) => card.lastAt >= cutoff);
  }

  // 最近判定时间倒序（questionId 升序兜底稳定）
  visible.sort(
    (a, b) =>
      b.lastAt.localeCompare(a.lastAt) ||
      a.questionId.localeCompare(b.questionId),
  );
  return { questions: visible };
}

/**
 * 轮次来源标题（服务端算好的展示串）：作业=作业标题；课程练习=「单元标题 ·
 * 第 n 次」；错题重练=「错题重练 · 第 n 次」（2026-10，重练交卷后自动成为
 * 新一轮）。与前端 records-views.recordTitleOf 同口径（展示约定在
 * teacherAttemptSourceSchema 注释；#6980-2 起格式化收敛进契约包
 * T6R.15 起导出：note-service.getStudentQuestionNotebook 的 sourceLabel 与
 * 本函数同一实现（同一概念同一份定义，不复制粘贴）。
 */
export function roundSourceTitle(source: TeacherAttemptSource): string {
  if (source.sourceType === "assignment") {
    return source.assignmentTitle ?? "（作业已删除）";
  }
  if (source.sourceType === "wrong") {
    // #6980-2：标题单源（契约 wrongAttemptTitleOf）——label 来自建卷存的
    // scope 快照，历史卷由 sourceOf 现算「来自 …」分布
    return wrongAttemptTitleOf({
      attemptNo: source.attemptNo,
      wrongScope: source.wrongScope ?? null,
    });
  }
  return `${source.unitTitle ?? ""} · 第 ${source.attemptNo} 次`;
}
