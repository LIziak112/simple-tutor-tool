import type { QuestionType } from "@tutor/contract";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import {
  aiAttemptReviewTasks,
  aiTasks,
  annotations,
  attempts,
  ink,
  notes,
  questions,
  responses,
  students,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { teacherVisibleResponsesWhere } from "../services/teacher-attempt-service";

/**
 * MCP-A 教师侧只读查询装配（教师迭代 T-PR2，方案口径见大厅 #11680 / #11693）：
 * - 四件工具（query_student_attempts / query_student_responses / search_questions /
 *   get_report）的查询 SQL 独立成本文件、不进各业务 service——与 PR #26（嵌套
 *   课程目录）的交集收敛到 server.ts 注册段与 mcp.test.ts，后合方 rebase；
 * - 共同约定：studentId 可省（名下未归档学生恰 1 名则默认该生，否则 400
 *   STUDENT_AMBIGUOUS 附 [{studentId, displayName}] 名单）；limit 默认 50、
 *   上限 200（search_questions 上限 100）+ cursor（页偏移的不透明编码，沿
 *   listTeacherAttempts 的 limit/offset/total 分页形状）；fields=summary|full
 *   （summary 题干截 120 字且不带答案/解析）；
 * - 口径：排作废卷；draft 卷只纳入单题已提交的行（teacher-attempt-service 的
 *   teacherVisibleResponsesWhere，T-PR3 与学生主页聚合端点同用）；考点/题型取
 *   responses 建卷冻结快照（analytics-service knowledgeOfResponse 同口径：
 *   快照优先、缺失不回填当前题库）。
 */

/** summary 面题干截断长度（阅读友好截断，不追加省略号避免误当作原文） */
const SUMMARY_STEM_MAX = 120;

/**
 * studentId 可省约定（MCP-A 四件共用）：显式给 → 域校验（不存在或非本教师
 * 404 STUDENT_NOT_FOUND，不暴露存在性）；省略 → 名下未归档学生恰 1 名时默认
 * 该生，否则 400 STUDENT_AMBIGUOUS 并附名单。
 */
export function resolveToolStudent(
  db: Db,
  teacherId: string,
  studentId?: string,
): string {
  if (studentId !== undefined) {
    const row = db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.id, studentId), eq(students.teacherId, teacherId)))
      .get();
    if (row === undefined) {
      throw new HttpError(404, "STUDENT_NOT_FOUND", "学生不存在");
    }
    return row.id;
  }
  const rows = db
    .select({ id: students.id, displayName: students.displayName })
    .from(students)
    .where(and(eq(students.teacherId, teacherId), isNull(students.archivedAt)))
    .all();
  const only = rows.length === 1 ? rows[0] : undefined;
  if (only !== undefined) return only.id;
  throw new HttpError(
    400,
    "STUDENT_AMBIGUOUS",
    rows.length === 0
      ? "名下没有未归档学生，无法缺省 studentId，请先指定要查的学生"
      : `名下有 ${rows.length} 名未归档学生，请用 studentId 指定要查的学生`,
    {
      _students: rows.map((row) => ({
        studentId: row.id,
        displayName: row.displayName,
      })),
    },
  );
}

/** offset 型游标解码（不透明字符串；首页缺省 = 0；非法值 400 不猜测） */
export function decodeCursorOffset(cursor?: string): number {
  if (cursor === undefined || cursor === "") return 0;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(
      400,
      "INVALID_CURSOR",
      "cursor 不合法，请使用上一页返回的 nextCursor",
    );
  }
  return parsed;
}

/** summary 题干截断 */
function stemSummaryOf(stemMd: string | null): string | null {
  if (stemMd === null) return null;
  return stemMd.length <= SUMMARY_STEM_MAX
    ? stemMd
    : stemMd.slice(0, SUMMARY_STEM_MAX);
}

/** 快照 JSON 列（$.answers / $.options）→ 解析结果（坏数据返回 null，不炸返回） */
function parseJsonObject(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 快照 knowledge 列（JSON 数组文本）→ 字符串数组（坏数据不炸聚合） */
function parseKnowledgeArray(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  } catch {
    return [];
  }
}

// ---------- query_student_attempts 的每卷增量计数 ----------

/** 每卷盘点计数（query_student_attempts 在 listTeacherAttempts 卡片上的增量面） */
export interface AttemptExtras {
  /** 单题已提交的行数（draft 卷为部分提交数；已交卷 = 冻结行数） */
  submittedCount: number;
  correctCount: number;
  wrongCount: number;
  /** 待批数（finalCorrect 为空且快照非空，D4 共享口径） */
  pendingCount: number;
  /** 自标「不会」的行数 */
  unsureCount: number;
  /** 是否已有整卷 AI 复盘任务（任意状态，创建过即算） */
  hasAiReview: boolean;
}

/** 一批卷的增量计数（两条聚合 SQL，避免逐卷 N+1；无 responses 行的卷补零值） */
export function attemptExtrasOf(
  db: Db,
  attemptIds: readonly string[],
): Map<string, AttemptExtras> {
  const map = new Map<string, AttemptExtras>();
  if (attemptIds.length === 0) return map;
  const ids = [...attemptIds];
  const counts = db
    .select({
      attemptId: responses.attemptId,
      submitted: sql<number>`coalesce(sum(case when ${responses.submittedAt} is not null then 1 else 0 end), 0)`,
      correct: sql<number>`coalesce(sum(case when ${responses.finalCorrect} = 1 then 1 else 0 end), 0)`,
      wrong: sql<number>`coalesce(sum(case when ${responses.finalCorrect} = 0 then 1 else 0 end), 0)`,
      pending: sql<number>`coalesce(sum(case when ${responses.finalCorrect} is null and ${responses.questionSnapshotJson} is not null then 1 else 0 end), 0)`,
      unsure: sql<number>`coalesce(sum(case when ${responses.studentFlag} = 'unsure' then 1 else 0 end), 0)`,
    })
    .from(responses)
    .innerJoin(attempts, eq(responses.attemptId, attempts.id))
    .where(and(inArray(responses.attemptId, ids), isNull(attempts.abandonedAt)))
    .groupBy(responses.attemptId)
    .all();
  const reviewIds = new Set(
    db
      .select({ attemptId: aiAttemptReviewTasks.attemptId })
      .from(aiAttemptReviewTasks)
      .where(inArray(aiAttemptReviewTasks.attemptId, ids))
      .all()
      .map((row) => row.attemptId),
  );
  for (const row of counts) {
    map.set(row.attemptId, {
      submittedCount: row.submitted ?? 0,
      correctCount: row.correct ?? 0,
      wrongCount: row.wrong ?? 0,
      pendingCount: row.pending ?? 0,
      unsureCount: row.unsure ?? 0,
      hasAiReview: reviewIds.has(row.attemptId),
    });
  }
  for (const id of ids) {
    if (!map.has(id)) {
      map.set(id, {
        submittedCount: 0,
        correctCount: 0,
        wrongCount: 0,
        pendingCount: 0,
        unsureCount: 0,
        hasAiReview: reviewIds.has(id),
      });
    }
  }
  return map;
}

// ---------- query_student_responses ----------

/** query_student_responses 入参（server.ts 的 inputSchema shape 与之对齐） */
export interface StudentResponseQueryArgs {
  studentId: string;
  attemptIds?: string[] | undefined;
  courseId?: string | undefined;
  questionId?: string | undefined;
  /** 单题提交时间下界 / 上界（UTC ISO，字符串比较口径） */
  from?: string | undefined;
  to?: string | undefined;
  /** 考点精确等于（建卷冻结快照值） */
  knowledge?: string | undefined;
  type?: string | undefined;
  correct?: "true" | "false" | "pending" | undefined;
  flaggedUnsure?: boolean | undefined;
  answered?: boolean | undefined;
  minActiveSec?: number | undefined;
  minChangeCount?: number | undefined;
  usedHints?: boolean | undefined;
  hasScratchOrInk?: boolean | undefined;
  hasCorrection?: boolean | undefined;
  hasAiHelp?: boolean | undefined;
  selfReview?: boolean | undefined;
  fields?: "summary" | "full" | undefined;
  limit: number;
  cursor?: string | undefined;
}

/** 行的引用 id（不内联内容；AI 按 id 另取笔记版本 / 笔迹图 / 标注 / AI 任务） */
interface ResponseRefs {
  inkIds: string[];
  noteVersionIds: string[];
  annotationIds: string[];
  aiTaskIds: string[];
  /** 有 scratch 工作稿笔记行（含 0 版本行——与筛选 EXISTS 同口径） */
  hasScratchNote: boolean;
  /** 有 correction 订正笔记行 */
  hasCorrectionNote: boolean;
}

/** 存在性筛选用 EXISTS 片段（笔记阶段 / 笔迹 / 标注 / AI 任务） */
const NOTES_SCRATCH_EXISTS = sql`exists (select 1 from notes n where n.attempt_id = ${responses.attemptId} and n.question_id = ${responses.questionId} and n.phase = 'scratch')`;
const NOTES_CORRECTION_EXISTS = sql`exists (select 1 from notes n where n.attempt_id = ${responses.attemptId} and n.question_id = ${responses.questionId} and n.phase = 'correction')`;
const INK_EXISTS = sql`exists (select 1 from ink i where i.attempt_id = ${responses.attemptId} and i.question_id = ${responses.questionId})`;
const AI_TASK_EXISTS = sql`exists (select 1 from ai_tasks t where t.attempt_id = ${responses.attemptId} and t.question_id = ${responses.questionId})`;

/** 行键（attemptId + questionId；同一键多行——同题多次作答——共享引用 id） */
function refKeyOf(attemptId: string, questionId: string): string {
  return `${attemptId}\u0000${questionId}`;
}

/** 一页行的引用 id 批量装配（4 条 IN 查询，避免逐行 EXISTS N+1） */
function responseRefsOf(
  db: Db,
  pairs: readonly { attemptId: string; questionId: string }[],
): Map<string, ResponseRefs> {
  const map = new Map<string, ResponseRefs>();
  if (pairs.length === 0) return map;
  for (const pair of pairs) {
    map.set(refKeyOf(pair.attemptId, pair.questionId), {
      inkIds: [],
      noteVersionIds: [],
      annotationIds: [],
      aiTaskIds: [],
      hasScratchNote: false,
      hasCorrectionNote: false,
    });
  }
  const attemptIdList = [...new Set(pairs.map((p) => p.attemptId))];
  const questionIdList = [...new Set(pairs.map((p) => p.questionId))];
  for (const row of db
    .select({
      id: ink.id,
      attemptId: ink.attemptId,
      questionId: ink.questionId,
    })
    .from(ink)
    .where(
      and(
        inArray(ink.attemptId, attemptIdList),
        inArray(ink.questionId, questionIdList),
      ),
    )
    .all()) {
    map.get(refKeyOf(row.attemptId, row.questionId))?.inkIds.push(row.id);
  }
  for (const row of db
    .select({
      attemptId: notes.attemptId,
      questionId: notes.questionId,
      versionId: notes.currentVersionId,
      phase: notes.phase,
    })
    .from(notes)
    .where(
      and(
        inArray(notes.attemptId, attemptIdList),
        inArray(notes.questionId, questionIdList),
      ),
    )
    .all()) {
    const entry = map.get(refKeyOf(row.attemptId, row.questionId));
    if (entry === undefined) continue;
    if (row.phase === "scratch") entry.hasScratchNote = true;
    if (row.phase === "correction") entry.hasCorrectionNote = true;
    if (row.versionId !== null) entry.noteVersionIds.push(row.versionId);
  }
  for (const row of db
    .select({
      id: annotations.id,
      attemptId: annotations.attemptId,
      questionId: annotations.questionId,
    })
    .from(annotations)
    .where(
      and(
        inArray(annotations.attemptId, attemptIdList),
        inArray(annotations.questionId, questionIdList),
      ),
    )
    .all()) {
    map
      .get(refKeyOf(row.attemptId, row.questionId))
      ?.annotationIds.push(row.id);
  }
  for (const row of db
    .select({
      id: aiTasks.id,
      attemptId: aiTasks.attemptId,
      questionId: aiTasks.questionId,
    })
    .from(aiTasks)
    .where(
      and(
        inArray(aiTasks.attemptId, attemptIdList),
        inArray(aiTasks.questionId, questionIdList),
      ),
    )
    .all()) {
    map.get(refKeyOf(row.attemptId, row.questionId))?.aiTaskIds.push(row.id);
  }
  return map;
}

/**
 * 逐题作答行检索：主查询一条 SQL（responses ⋈ attempts ⋈ students），过程特征
 * 全在 responses 行；笔记 / 笔迹 / 标注 / AI 任务的存在性筛选用 EXISTS、引用 id
 * 用页内批量装配。同题多次作答各自成行；排序 (submittedAt, id) 稳定，offset
 * 游标翻页。
 */
export function queryStudentResponses(
  db: Db,
  teacherId: string,
  args: StudentResponseQueryArgs,
): {
  total: number;
  nextCursor: string | null;
  responses: Record<string, unknown>[];
} {
  const offset = decodeCursorOffset(args.cursor);
  const conditions = [
    eq(students.teacherId, teacherId),
    // studentId 经 resolveToolStudent 解析后必达：缺这条会把「查学生 A」
    // 放大成「名下全部学生」（多学生教师串档，评审 #11725 必改①）
    eq(attempts.studentId, args.studentId),
    // 共享谓词：排作废卷；draft 卷只纳入单题已提交的行；幽灵行排除
    ...teacherVisibleResponsesWhere(),
    ...(args.attemptIds !== undefined && args.attemptIds.length > 0
      ? [inArray(responses.attemptId, args.attemptIds)]
      : []),
    ...(args.courseId !== undefined
      ? [eq(attempts.courseId, args.courseId)]
      : []),
    ...(args.questionId !== undefined
      ? [eq(responses.questionId, args.questionId)]
      : []),
    ...(args.from !== undefined ? [gte(responses.submittedAt, args.from)] : []),
    ...(args.to !== undefined ? [lte(responses.submittedAt, args.to)] : []),
    ...(args.knowledge !== undefined
      ? [
          sql`exists (select 1 from json_each(${responses.questionSnapshotJson}, '$.knowledge') k where k.value = ${args.knowledge})`,
        ]
      : []),
    ...(args.type !== undefined
      ? [
          sql`json_extract(${responses.questionSnapshotJson}, '$.type') = ${args.type}`,
        ]
      : []),
    ...(args.correct === "true" ? [eq(responses.finalCorrect, true)] : []),
    ...(args.correct === "false" ? [eq(responses.finalCorrect, false)] : []),
    ...(args.correct === "pending" ? [isNull(responses.finalCorrect)] : []),
    ...(args.flaggedUnsure ? [eq(responses.studentFlag, "unsure")] : []),
    ...(args.answered !== undefined
      ? [eq(responses.answered, args.answered)]
      : []),
    ...(args.minActiveSec !== undefined
      ? [gte(responses.activeSec, args.minActiveSec)]
      : []),
    ...(args.minChangeCount !== undefined
      ? [gte(responses.changeCount, args.minChangeCount)]
      : []),
    ...(args.usedHints ? [gt(responses.hintsUsed, 0)] : []),
    ...(args.hasScratchOrInk ? [or(NOTES_SCRATCH_EXISTS, INK_EXISTS)] : []),
    ...(args.hasCorrection ? [NOTES_CORRECTION_EXISTS] : []),
    ...(args.hasAiHelp ? [AI_TASK_EXISTS] : []),
    ...(args.selfReview ? [isNotNull(responses.selfCorrect)] : []),
  ];
  const where = and(...conditions);

  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(responses)
      .innerJoin(attempts, eq(responses.attemptId, attempts.id))
      .innerJoin(students, eq(attempts.studentId, students.id))
      .where(where)
      .get()?.n ?? 0;

  const rows = db
    .select({
      revisionId: responses.id,
      attemptId: responses.attemptId,
      attemptNo: attempts.attemptNo,
      sourceType: attempts.sourceType,
      attemptStatus: attempts.status,
      courseId: attempts.courseId,
      assignmentId: attempts.assignmentId,
      unitId: responses.unitId,
      questionId: responses.questionId,
      submittedAt: responses.submittedAt,
      answered: responses.answered,
      autoCorrect: responses.autoCorrect,
      finalCorrect: responses.finalCorrect,
      teacherMark: responses.teacherMark,
      studentFlag: responses.studentFlag,
      selfCorrect: responses.selfCorrect,
      activeSec: responses.activeSec,
      hintsUsed: responses.hintsUsed,
      changeCount: responses.changeCount,
      type: sql<
        string | null
      >`json_extract(${responses.questionSnapshotJson}, '$.type')`,
      difficulty: sql<
        number | null
      >`json_extract(${responses.questionSnapshotJson}, '$.difficulty')`,
      stemMd: sql<
        string | null
      >`json_extract(${responses.questionSnapshotJson}, '$.stemMd')`,
      knowledge: sql<
        string | null
      >`json_extract(${responses.questionSnapshotJson}, '$.knowledge')`,
      answersJson: sql<
        string | null
      >`json_extract(${responses.questionSnapshotJson}, '$.answers')`,
      optionsJson: sql<
        string | null
      >`json_extract(${responses.questionSnapshotJson}, '$.options')`,
      solutionMd: sql<
        string | null
      >`json_extract(${responses.questionSnapshotJson}, '$.solutionMd')`,
    })
    .from(responses)
    .innerJoin(attempts, eq(responses.attemptId, attempts.id))
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(where)
    .orderBy(sql`${responses.submittedAt} asc`, sql`${responses.id} asc`)
    .limit(args.limit)
    .offset(offset)
    .all();

  const refMap = responseRefsOf(
    db,
    rows.map((row) => ({
      attemptId: row.attemptId,
      questionId: row.questionId,
    })),
  );
  const full = args.fields === "full";

  const items = rows.map((row) => {
    const refs = refMap.get(refKeyOf(row.attemptId, row.questionId));
    return {
      revisionId: row.revisionId,
      attemptId: row.attemptId,
      attemptNo: row.attemptNo,
      sourceType: row.sourceType,
      attemptStatus: row.attemptStatus,
      courseId: row.courseId,
      assignmentId: row.assignmentId,
      unitId: row.unitId,
      questionId: row.questionId,
      submittedAt: row.submittedAt,
      type: row.type,
      difficulty: row.difficulty,
      knowledge: parseKnowledgeArray(row.knowledge),
      stemMd: full ? row.stemMd : stemSummaryOf(row.stemMd),
      pending: row.finalCorrect === null,
      autoCorrect: row.autoCorrect,
      finalCorrect: row.finalCorrect,
      teacherMark: row.teacherMark,
      answered: row.answered,
      flaggedUnsure: row.studentFlag === "unsure",
      selfCorrect: row.selfCorrect,
      activeSec: row.activeSec,
      hintsUsed: row.hintsUsed,
      changeCount: row.changeCount,
      hasScratchOrInk:
        (refs?.hasScratchNote ?? false) || (refs?.inkIds.length ?? 0) > 0,
      hasCorrection: refs?.hasCorrectionNote ?? false,
      hasAiHelp: (refs?.aiTaskIds.length ?? 0) > 0,
      refs: {
        inkIds: refs?.inkIds ?? [],
        noteVersionIds: refs?.noteVersionIds ?? [],
        annotationIds: refs?.annotationIds ?? [],
        aiTaskIds: refs?.aiTaskIds ?? [],
      },
      // full 面才带参考答案、选项与解析（教师域允许；summary 恒不出现这三个键）
      ...(full
        ? {
            answer: parseJsonObject(row.answersJson),
            options: parseJsonObject(row.optionsJson),
            solutionMd: row.solutionMd,
          }
        : {}),
    };
  });

  const nextCursor =
    offset + rows.length < total ? String(offset + rows.length) : null;
  return { total, nextCursor, responses: items };
}

// ---------- search_questions ----------

/** search_questions 入参（server.ts 的 inputSchema shape 与之对齐） */
export interface SearchQuestionsArgs {
  q?: string | undefined;
  knowledge?: string | undefined;
  type?: QuestionType | undefined;
  difficulty?: number | undefined;
  unitId?: string | undefined;
  fields?: "summary" | "full" | undefined;
  limit: number;
  cursor?: string | undefined;
}

/** LIKE 转义（\ % _；配合 escape '\' 子句，用户输入的通配符按字面匹配） */
function escapeLike(raw: string): string {
  return raw.replace(/([\\%_])/g, "\\$1");
}

/**
 * 题库检索（只搜未删除题；不做相关性排序，按单元与题序稳定排列）。
 * SQL 独立本文件（#11693：不进 library-service.ts，压缩与 PR #26 的交集）。
 */
export function searchQuestions(
  db: Db,
  teacherId: string,
  args: SearchQuestionsArgs,
): {
  total: number;
  nextCursor: string | null;
  questions: Record<string, unknown>[];
} {
  const offset = decodeCursorOffset(args.cursor);
  const conditions = [
    eq(questions.teacherId, teacherId),
    isNull(questions.deletedAt),
    ...(args.q !== undefined
      ? [sql`${questions.stemMd} like ${`%${escapeLike(args.q)}%`} escape '\\'`]
      : []),
    ...(args.knowledge !== undefined
      ? [
          sql`exists (select 1 from question_knowledge qk join knowledge_points kp on kp.id = qk.knowledge_point_id where qk.teacher_id = ${questions.teacherId} and qk.question_id = ${questions.id} and kp.name like ${`%${escapeLike(args.knowledge)}%`} escape '\\')`,
        ]
      : []),
    ...(args.type !== undefined ? [eq(questions.type, args.type)] : []),
    ...(args.difficulty !== undefined
      ? [eq(questions.difficulty, args.difficulty)]
      : []),
    ...(args.unitId !== undefined ? [eq(questions.unitId, args.unitId)] : []),
  ];
  const where = and(...conditions);

  const total =
    db.select({ n: sql<number>`count(*)` }).from(questions).where(where).get()
      ?.n ?? 0;

  const rows = db
    .select({
      id: questions.id,
      unitId: questions.unitId,
      order: questions.order,
      type: questions.type,
      difficulty: questions.difficulty,
      version: questions.version,
      updatedAt: questions.updatedAt,
      stemMd: questions.stemMd,
    })
    .from(questions)
    .where(where)
    .orderBy(asc(questions.unitId), asc(questions.order), asc(questions.id))
    .limit(args.limit)
    .offset(offset)
    .all();

  const full = args.fields === "full";
  const items = rows.map((row) => ({
    id: row.id,
    unitId: row.unitId,
    order: row.order,
    type: row.type,
    difficulty: row.difficulty,
    version: row.version,
    updatedAt: row.updatedAt,
    stemMd: full ? row.stemMd : stemSummaryOf(row.stemMd),
  }));

  const nextCursor =
    offset + rows.length < total ? String(offset + rows.length) : null;
  return { total, nextCursor, questions: items };
}
