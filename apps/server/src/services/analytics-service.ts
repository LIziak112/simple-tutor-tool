import type {
  AnalyticsAnomalyQuestion,
  AnalyticsAssignmentCell,
  AnalyticsAssignmentColumn,
  AnalyticsFocusCard,
  AnalyticsFocusPoint,
  AnalyticsKnowledgeRow,
  AnalyticsLectureMapEntry,
  AnalyticsMatrix,
  AnalyticsOffline,
  AnalyticsOverviewData,
  AnalyticsQuery,
  AnalyticsQuestionRow,
  AnalyticsQuestionsData,
  AnalyticsRange,
  AnalyticsRedoRow,
  AnalyticsStudentData,
  AnalyticsStudentRow,
  AnalyticsTrendPoint,
  AnalyticsUnitCell,
  AnalyticsUnitColumn,
  AnalyticsWrongAnswer,
  AnalyticsWrongQuestionRow,
  Question,
} from "@tutor/contract";
import {
  ANALYTICS_WRONG_ANSWER_TOP_N,
  analyticsQuerySchema,
} from "@tutor/contract";
import { and, asc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  assignmentStudents,
  assignments,
  attempts,
  courseItems,
  courseStudents,
  courses,
  events,
  knowledgePoints,
  lectures,
  questionKnowledge,
  questions,
  type ResponseRow,
  responses,
  students,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { answerOf } from "./attempt-service";
import { loadResourceContext } from "./course-service";
import { lectureReadingMapFor } from "./lecture-insights";
import { serializeStudentAnswer } from "./mark-response";
import { pendingMarkCounts } from "./pending-mark";
import { snapshotOfRow } from "./snapshot";
import { type TraceEvent, traceEventsFromRows } from "./trace-intervals";
import { computeAttemptTraceMetrics } from "./trace-metrics";

/**
 * AnalyticsService（T4.1，Phase4 清单 §2 D1–D7 + 架构 §5.8）——学情聚合业务层：
 * 完成矩阵、周趋势、学生×考点、题目统计、异常题、下节课重点、重做计数、
 * 离线作答占比、讲义阅读地图。纯 SQL + TS（一对一量级内存聚合），不建新表、
 * 不回写派生指标（D13）；判分只读 finalCorrect / scoreFinal（红线：绝不重算判分）。
 *
 * 口径总纲（契约 analytics-api.ts 的 D1–D7 注释为权威，此处为实现侧摘要）：
 * - D1：作业全部作答参与统计；课程练习仅 attemptNo=1，重做次数独立展示；
 * - D2：矩阵 = 学生 × 布置的作业 + 可见课程单元（可见性与 T2A.6 进度矩阵同一
 *   判定：visible=true 且已到 publishAt 且资源未删且有未删题，复用
 *   loadResourceContext）；
 * - D3：courseId 筛选（缺省=全部）——学生行=该课程成员、作业列=挂该课程的
 *   作业、单元列与讲义地图=该课程条目；课程须属本教师域，否则一律空集
 *   （不泄露他域存在性与计数）；
 * - D4：finalCorrect=null 不进正确率分母，单独计待批数；
 * - D5：days 窗口按 submittedAt 过滤统计作答；周趋势自然周（Asia/Shanghai、
 *   周一起算、取 submittedAt）；完成矩阵不受 days 影响（当下状态一览）；
 * - D6：activeSec > 该题用时中位数 2 倍 或 hintsUsed ≥ 2；中位数按本教师域内
 *   该题全部已交作答计算（不受 days/D1/D3 限制）；
 * - D7：全部查询经 attempt → student → teacherId 域过滤（乙查甲 → 空集，
 *   不泄露计数，T2B 口径）。
 *
 * 离线作答占比与讲义阅读地图消费 T4.0b 聚合纯函数（trace-metrics /
 * lecture-insights）；本模块**不向响应输出任何 events 原始行**（D13 红线）。
 *
 * now 可注入（趋势分桶与窗口判定的确定性测试；默认当前时刻）。
 */

/** 一天（趋势窗口与周桶推进的步长） */
const DAY_MS = 86_400_000;
/** 北京时间相对 UTC 的固定偏移（无夏令时，D5） */
const BEIJING_OFFSET_MS = 8 * 3_600_000;
/** 周桶数量防御上限（10 年；days="all" 且库里有远古数据时不撑爆响应） */
const TREND_BUCKET_MAX = 520;

/**
 * 北京自然周周一（D5：周一起算）：ms → 该周周一 00:00（北京）对应的 UTC 时刻。
 * 1970-01-01（北京周四）→ 天数模 7 偏移 +3 使周一=0；+7 再模防负数。
 */
function beijingWeekStartMs(ms: number): number {
  const beijingDays = Math.floor((ms + BEIJING_OFFSET_MS) / DAY_MS);
  const dayOfWeek = (((beijingDays + 3) % 7) + 7) % 7;
  return (beijingDays - dayOfWeek) * DAY_MS - BEIJING_OFFSET_MS;
}

/** 周一起点毫秒 → 周一北京日期键（YYYY-MM-DD；先平移回北京时区再切日期） */
function weekKeyOfMs(weekStartMs: number): string {
  return new Date(weekStartMs + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** submittedAt（UTC ISO）→ 该作答所在自然周的周一北京日期键（YYYY-MM-DD） */
function beijingWeekKeyOf(iso: string): string {
  return weekKeyOfMs(beijingWeekStartMs(Date.parse(iso)));
}

/** 数值中位数（空数组为 null；偶数个取中间两数平均） */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (sorted.length % 2 === 1) return upper ?? null;
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

/** 保留 2 位小数（异常倍数展示用） */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** JSON.parse 的窄化包装：坏数据返回 undefined（列由写入链路保证为合法 JSON） */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 考点名窄化（快照坏数据不打挂聚合） */
function isKnowledgeName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 响应行的考点：优先快照 knowledge（交卷冻结值）；快照缺失按当前库关联兜底 */
function knowledgeOfResponse(
  row: ResponseRow,
  fallback: Map<string, string[]>,
): string[] {
  if (row.questionSnapshotJson !== null) {
    const parsed = jsonOf(row.questionSnapshotJson);
    if (parsed !== null && typeof parsed === "object") {
      const knowledge = (parsed as { knowledge?: unknown }).knowledge;
      if (Array.isArray(knowledge)) return knowledge.filter(isKnowledgeName);
    }
  }
  return fallback.get(row.questionId) ?? [];
}

/** inArray 分块迭代（SQLite 变量上限防御；500 与 pending-mark 同款） */
function chunk<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** 组内最近一次已交卷（无则 undefined） */
function lastSubmittedOf(group: readonly Attempt[]): Attempt | undefined {
  let found: Attempt | undefined;
  for (const attempt of group) {
    if (attempt.submittedAt !== null) found = attempt; // 组按 submittedAt 升序装载
  }
  return found;
}

// ---------- 作用域装配（三个接口共用的数据装载） ----------

/** 学情作用域：一次请求内装载的域内数据（教师域 + D3/D5 筛选后） */
interface AnalyticsContext {
  readonly teacherId: string;
  readonly query: AnalyticsQuery;
  readonly range: AnalyticsRange;
  readonly nowMs: number;
  /** 矩阵学生行（courseId 筛选后=该课程成员；含已归档——教师侧统计视角） */
  readonly studentRows: readonly AnalyticsStudentRow[];
  /** courseId → 课程名（域内；作业列/重做行展示用） */
  readonly courseNames: Map<string, string>;
  /** unitId → 单元标题（域内，含软删——历史作答统计不消失） */
  readonly unitTitles: Map<string, string>;
  /** D5 窗口内参与统计的作答（D1：作业全部 + 课程练习 attemptNo=1） */
  readonly qualifying: readonly Attempt[];
  /** qualifying 各 attempt 的 responses（(attemptId, questionId) 唯一索引定位） */
  readonly responsesByAttempt: Map<string, ResponseRow[]>;
  /** D3 筛选后的全部作答（含 draft 与重做；矩阵/待批/重点/重做用，不受 days 限制） */
  readonly allAttempts: readonly Attempt[];
  /** D6 中位数：questionId → 该题域内全部已交作答 activeSec 的中位数 */
  readonly domainMedianByQuestion: Map<string, number | null>;
  /** 当前库题目元信息（题目视角排序与快照兜底；软删题保留——统计不消失） */
  readonly questionMeta: Map<
    string,
    {
      unitId: string;
      order: number;
      type: string;
      difficulty: number;
      stemMd: string;
    }
  >;
  /** 快照考点兜底：questionId → 当前库考点名（question_knowledge 域内读） */
  readonly knowledgeFallback: Map<string, string[]>;
}

/**
 * 装载作用域（三接口共用）：
 * - attempts 经 students.teacherId 域过滤（attempts_student_assignment_idx /
 *   attempts_student_course_unit_idx 供 join 下推）；
 * - D3 筛选：courseId 须属本教师域（否则整域空集，不泄露他域计数）；assignment
 *   来源 attempt.courseId 以作业行兜底（T2A.7 起交卷链路恒写，旧数据可缺）；
 * - qualifying：D5 窗口（submittedAt ∈ [from, now]）+ D1（course 来源仅首次）；
 * - D6 中位数独立装载：域内全部已交 attempt 的逐题 activeSec（不做 D3/D5/D1
 *   筛选——口径是「本教师域内该题全部已交作答」）。
 */
function buildContext(
  db: Db,
  teacherId: string,
  query: AnalyticsQuery,
  now: Date | string,
): AnalyticsContext {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  const nowIso = new Date(nowMs).toISOString();
  const fromIso =
    query.days === "all"
      ? null
      : new Date(nowMs - query.days * DAY_MS).toISOString();

  // D3：课程筛选的域校验（乙拿甲的 courseId → 整域空集，不暴露存在性）
  const scopeCourse =
    query.courseId === undefined
      ? undefined
      : db
          .select({ id: courses.id })
          .from(courses)
          .where(
            and(
              eq(courses.id, query.courseId),
              eq(courses.teacherId, teacherId),
            ),
          )
          .get();
  const courseScopeValid =
    query.courseId === undefined || scopeCourse !== undefined;

  // 矩阵学生行（courseId 筛选=该课程成员；不筛选=全部学生；均含已归档）
  const studentSelect = {
    id: students.id,
    displayName: students.displayName,
    archivedAt: students.archivedAt,
  };
  const studentRows: AnalyticsStudentRow[] = courseScopeValid
    ? (query.courseId === undefined
        ? db
            .select(studentSelect)
            .from(students)
            .where(eq(students.teacherId, teacherId))
            .orderBy(asc(students.displayName), asc(students.id))
            .all()
        : db
            .select(studentSelect)
            .from(courseStudents)
            .innerJoin(students, eq(courseStudents.studentId, students.id))
            .where(eq(courseStudents.courseId, query.courseId))
            .orderBy(asc(students.displayName), asc(students.id))
            .all()
      ).map((row) => ({
        studentId: row.id,
        displayName: row.displayName,
        archived: row.archivedAt !== null,
      }))
    : [];

  const courseNames = new Map(
    db
      .select({ id: courses.id, title: courses.title })
      .from(courses)
      .where(eq(courses.teacherId, teacherId))
      .all()
      .map((row) => [row.id, row.title] as const),
  );
  const unitTitles = new Map(
    db
      .select({ id: units.id, title: units.title })
      .from(units)
      .where(eq(units.teacherId, teacherId))
      .all()
      .map((row) => [row.id, row.title] as const),
  );

  // 域内 attempt（含 draft：矩阵进行中/做过次数要用），D3 筛选在 TS 侧
  const assignmentCourseById = new Map(
    db
      .select({ id: assignments.id, courseId: assignments.courseId })
      .from(assignments)
      .where(eq(assignments.teacherId, teacherId))
      .all()
      .map((row) => [row.id, row.courseId] as const),
  );
  const inCourseScope = (attempt: Attempt): boolean => {
    if (query.courseId === undefined) return true;
    const courseId =
      attempt.courseId ??
      (attempt.assignmentId !== null
        ? (assignmentCourseById.get(attempt.assignmentId) ?? null)
        : null);
    return courseId === query.courseId;
  };
  const allAttempts = courseScopeValid
    ? db
        .select({ attempt: attempts })
        .from(attempts)
        .innerJoin(students, eq(attempts.studentId, students.id))
        .where(eq(students.teacherId, teacherId))
        .orderBy(asc(attempts.submittedAt), asc(attempts.id))
        .all()
        .map((row) => row.attempt)
        .filter(inCourseScope)
    : [];

  // D5 窗口 + D1（统计作答）——wrong 来源（2026-10 错题重练）不计入：重练是
  // 对已做过题目的再作答，不属于「首次见到这批题」的统计口径（作业全部 +
  // 课程首次；其作答在错题本/记录/数据页照常可见）
  const qualifying = allAttempts.filter(
    (attempt) =>
      attempt.status !== "draft" &&
      attempt.submittedAt !== null &&
      (fromIso === null || attempt.submittedAt >= fromIso) &&
      attempt.submittedAt <= nowIso &&
      attempt.sourceType !== "wrong" &&
      (attempt.sourceType === "assignment" || attempt.attemptNo === 1),
  );

  // qualifying 的 responses
  const responsesByAttempt = new Map<string, ResponseRow[]>();
  for (const ids of chunk(qualifying.map((attempt) => attempt.id))) {
    for (const row of db
      .select()
      .from(responses)
      .where(inArray(responses.attemptId, ids))
      .all()) {
      const list = responsesByAttempt.get(row.attemptId);
      if (list === undefined) responsesByAttempt.set(row.attemptId, [row]);
      else list.push(row);
    }
  }

  // D6 中位数：域内全部已交作答（不筛课程——题目用时是该题在域内的固有属性）
  const domainSubmittedIds = db
    .select({ id: attempts.id })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(and(eq(students.teacherId, teacherId), ne(attempts.status, "draft")))
    .all()
    .map((row) => row.id);
  const secByQuestion = new Map<string, number[]>();
  for (const ids of chunk(domainSubmittedIds)) {
    for (const row of db
      .select({
        questionId: responses.questionId,
        activeSec: responses.activeSec,
      })
      .from(responses)
      .where(inArray(responses.attemptId, ids))
      .all()) {
      if (row.activeSec === null) continue;
      const list = secByQuestion.get(row.questionId);
      if (list === undefined)
        secByQuestion.set(row.questionId, [row.activeSec]);
      else list.push(row.activeSec);
    }
  }
  const domainMedianByQuestion = new Map<string, number | null>();
  for (const [questionId, values] of secByQuestion) {
    domainMedianByQuestion.set(questionId, medianOf(values));
  }

  // 当前库题目元信息（题目视角排序与快照兜底；软删题保留——历史统计不消失）
  const questionMeta = new Map<
    string,
    {
      unitId: string;
      order: number;
      type: string;
      difficulty: number;
      stemMd: string;
    }
  >();
  for (const row of db
    .select({
      id: questions.id,
      unitId: questions.unitId,
      order: questions.order,
      type: questions.type,
      difficulty: questions.difficulty,
      stemMd: questions.stemMd,
    })
    .from(questions)
    .where(eq(questions.teacherId, teacherId))
    .all()) {
    questionMeta.set(row.id, {
      unitId: row.unitId,
      order: row.order,
      type: row.type,
      difficulty: row.difficulty,
      stemMd: row.stemMd,
    });
  }

  // 快照考点兜底（question_knowledge × knowledge_points 域内读）
  const knowledgeFallback = new Map<string, string[]>();
  for (const row of db
    .select({
      questionId: questionKnowledge.questionId,
      name: knowledgePoints.name,
    })
    .from(questionKnowledge)
    .innerJoin(
      knowledgePoints,
      eq(questionKnowledge.knowledgePointId, knowledgePoints.id),
    )
    .where(eq(questionKnowledge.teacherId, teacherId))
    .all()) {
    const list = knowledgeFallback.get(row.questionId);
    if (list === undefined) knowledgeFallback.set(row.questionId, [row.name]);
    else list.push(row.name);
  }

  return {
    teacherId,
    query,
    range: { days: query.days, from: fromIso, to: nowIso },
    nowMs,
    studentRows,
    courseNames,
    unitTitles,
    qualifying,
    responsesByAttempt,
    allAttempts,
    domainMedianByQuestion,
    questionMeta,
    knowledgeFallback,
  };
}

/** qualifying 中属于指定学生的作答（画像页复用全域上下文后过滤） */
function qualifyingOfStudent(
  ctx: AnalyticsContext,
  studentId: string,
): Attempt[] {
  return ctx.qualifying.filter((attempt) => attempt.studentId === studentId);
}

/** 统计聚合的工作单元：响应行 + 所属 attempt（qualifying，submittedAt 必非空） */
interface ScopedResponse {
  readonly response: ResponseRow;
  readonly attempt: Attempt;
}

/** qualifying → 逐响应工作单元（供考点/重点/题目视角聚合） */
function scopedResponsesOf(
  ctx: AnalyticsContext,
  scoped: readonly Attempt[],
): ScopedResponse[] {
  const out: ScopedResponse[] = [];
  for (const attempt of scoped) {
    for (const response of ctx.responsesByAttempt.get(attempt.id) ?? []) {
      out.push({ response, attempt });
    }
  }
  return out;
}

/** 行 → 有效得分（scoreFinal ?? scoreAuto；与 T2A.6 进度矩阵同一展示口径） */
function effectiveScore(attempt: Attempt): number | null {
  return attempt.scoreFinal ?? attempt.scoreAuto;
}

// ---------- 完成矩阵（D2） ----------

/**
 * 完成矩阵（D2）：学生 × 布置的作业 + 可见课程单元，稠密单元格。
 * - 作业列：本教师未软删的作业（courseId 筛选时只留挂该课程者），createdAt 升序；
 * - 单元列：域内未归档课程的可见单元条目（可见性判定与 T2A.6 进度矩阵一致，
 *   复用 loadResourceContext：visible 且已到 publishAt 且单元未删且有未删题）；
 * - 单元格状态：不在名单/不是课程成员 → not-assigned；无 attempt → not-started；
 *   有 draft → in-progress；否则取最近一次已交卷的 status（submitted/graded）。
 * 矩阵不受 days 影响（D5：当下状态一览——「谁没做」不受时间范围筛选）。
 */
function buildMatrix(db: Db, ctx: AnalyticsContext): AnalyticsMatrix {
  const { query } = ctx;

  // —— 作业列 ——
  const assignmentColumns: AnalyticsAssignmentColumn[] = db
    .select({
      id: assignments.id,
      title: assignments.title,
      dueAt: assignments.dueAt,
      courseId: assignments.courseId,
      createdAt: assignments.createdAt,
    })
    .from(assignments)
    .where(
      and(
        eq(assignments.teacherId, ctx.teacherId),
        isNull(assignments.deletedAt),
      ),
    )
    .orderBy(asc(assignments.createdAt), asc(assignments.id))
    .all()
    .filter(
      (row) => query.courseId === undefined || row.courseId === query.courseId,
    )
    .map((row) => ({
      assignmentId: row.id,
      title: row.title,
      dueAt: row.dueAt,
      courseId: row.courseId,
      courseName:
        row.courseId !== null
          ? (ctx.courseNames.get(row.courseId) ?? null)
          : null,
    }));

  // 名单（removedAt IS NULL = 在册，D13 口径）
  const roster = new Set<string>();
  for (const ids of chunk(
    assignmentColumns.map((column) => column.assignmentId),
  )) {
    for (const row of db
      .select({
        assignmentId: assignmentStudents.assignmentId,
        studentId: assignmentStudents.studentId,
      })
      .from(assignmentStudents)
      .where(
        and(
          inArray(assignmentStudents.assignmentId, ids),
          isNull(assignmentStudents.removedAt),
        ),
      )
      .all()) {
      roster.add(`${row.assignmentId}:${row.studentId}`);
    }
  }

  // —— 单元列（可见性判定复用 T2A.6 的资源上下文） ——
  const scopedCourses =
    query.courseId === undefined
      ? db
          .select({ id: courses.id, title: courses.title })
          .from(courses)
          .where(
            and(
              eq(courses.teacherId, ctx.teacherId),
              isNull(courses.archivedAt),
            ),
          )
          .orderBy(asc(courses.order), asc(courses.id))
          .all()
      : db
          .select({ id: courses.id, title: courses.title })
          .from(courses)
          .where(
            and(
              eq(courses.id, query.courseId),
              eq(courses.teacherId, ctx.teacherId),
              isNull(courses.archivedAt),
            ),
          )
          .all();
  const { unitById, liveQuestionCountByUnit } = loadResourceContext(
    db,
    ctx.teacherId,
  );
  const unitColumns: AnalyticsUnitColumn[] = [];
  for (const course of scopedCourses) {
    const items = db
      .select({
        refId: courseItems.refId,
        order: courseItems.order,
        visible: courseItems.visible,
        publishAt: courseItems.publishAt,
      })
      .from(courseItems)
      .where(
        and(eq(courseItems.courseId, course.id), eq(courseItems.kind, "unit")),
      )
      .orderBy(asc(courseItems.order), asc(courseItems.id))
      .all();
    for (const item of items) {
      if (item.refId === null) continue;
      const unit = unitById.get(item.refId);
      if (unit === undefined || unit.deletedAt !== null) continue;
      if (!item.visible) continue;
      if (item.publishAt !== null && Date.parse(item.publishAt) > ctx.nowMs) {
        continue;
      }
      if ((liveQuestionCountByUnit.get(item.refId) ?? 0) < 1) continue;
      unitColumns.push({
        courseId: course.id,
        courseName: course.title,
        unitId: item.refId,
        unitTitle: unit.title,
        order: item.order,
      });
    }
  }

  // —— 课程成员（单元列 not-assigned 判定） ——
  const members = new Set<string>();
  for (const ids of chunk(scopedCourses.map((course) => course.id))) {
    for (const row of db
      .select({
        courseId: courseStudents.courseId,
        studentId: courseStudents.studentId,
      })
      .from(courseStudents)
      .where(inArray(courseStudents.courseId, ids))
      .all()) {
      members.add(`${row.courseId}:${row.studentId}`);
    }
  }

  // —— 作答索引（(学生,作业) / (学生,课程,单元)；按 submittedAt 升序） ——
  const byAssignment = new Map<string, Attempt[]>();
  const byCourseUnit = new Map<string, Attempt[]>();
  for (const attempt of ctx.allAttempts) {
    if (attempt.sourceType === "assignment" && attempt.assignmentId !== null) {
      const key = `${attempt.assignmentId}:${attempt.studentId}`;
      const list = byAssignment.get(key);
      if (list === undefined) byAssignment.set(key, [attempt]);
      else list.push(attempt);
    } else if (
      attempt.sourceType === "course" &&
      attempt.courseId !== null &&
      attempt.unitId !== null
    ) {
      const key = `${attempt.courseId}:${attempt.unitId}:${attempt.studentId}`;
      const list = byCourseUnit.get(key);
      if (list === undefined) byCourseUnit.set(key, [attempt]);
      else list.push(attempt);
    }
  }

  /** 该格作答的展示状态（draft 优先 in-progress；否则最近一次已交卷的 status） */
  const cellStateOf = (
    group: readonly Attempt[],
  ): AnalyticsAssignmentCell["status"] => {
    if (group.some((attempt) => attempt.status === "draft")) {
      return "in-progress";
    }
    const latest = group[group.length - 1];
    if (latest === undefined) return "not-started";
    return latest.status === "graded" ? "graded" : "submitted";
  };

  // 待批数（D4 共享谓词；单元列聚合该单元全部历次已交卷；draft 恒 0）
  const pendingByAttempt = pendingMarkCounts(db, ctx.allAttempts);

  const cells: Array<AnalyticsAssignmentCell | AnalyticsUnitCell> = [];
  for (const student of ctx.studentRows) {
    for (const column of assignmentColumns) {
      const key = `${column.assignmentId}:${student.studentId}`;
      const group = byAssignment.get(key) ?? [];
      cells.push({
        kind: "assignment",
        studentId: student.studentId,
        assignmentId: column.assignmentId,
        status:
          group.length === 0 && !roster.has(key)
            ? "not-assigned"
            : cellStateOf(group),
        attemptId: group[group.length - 1]?.id ?? null,
        submittedAt: lastSubmittedOf(group)?.submittedAt ?? null,
      });
    }
    for (const column of unitColumns) {
      const key = `${column.courseId}:${column.unitId}:${student.studentId}`;
      const group = byCourseUnit.get(key) ?? [];
      if (group.length === 0) {
        cells.push({
          kind: "course-unit",
          studentId: student.studentId,
          courseId: column.courseId,
          unitId: column.unitId,
          status: members.has(`${column.courseId}:${student.studentId}`)
            ? "not-started"
            : "not-assigned",
          attemptCount: 0,
          redoCount: 0,
          firstScore: null,
          pendingCount: 0,
          latestSubmittedAt: null,
        });
        continue;
      }
      const submitted = group.filter((attempt) => attempt.submittedAt !== null);
      cells.push({
        kind: "course-unit",
        studentId: student.studentId,
        courseId: column.courseId,
        unitId: column.unitId,
        status: cellStateOf(group),
        // 做过次数（含草稿与重做，D2）；重做次数独立指标（D1）
        attemptCount: group.length,
        redoCount: group.length - 1,
        firstScore:
          submitted[0] === undefined ? null : effectiveScore(submitted[0]),
        pendingCount: group.reduce(
          (sum, attempt) => sum + (pendingByAttempt.get(attempt.id) ?? 0),
          0,
        ),
        latestSubmittedAt: submitted[submitted.length - 1]?.submittedAt ?? null,
      });
    }
  }

  return {
    students: [...ctx.studentRows],
    assignmentColumns,
    unitColumns,
    cells,
  };
}

// ---------- 周趋势（D5） ----------

/**
 * 总正确率周趋势（D5）：自然周（北京、周一起算、取 submittedAt）连续分桶。
 * 首桶 = from 所在周（days="all" 时取最早一条 qualifying 的所在周；scoped 为空
 * 返回空数组）；每桶 attemptCount=提交份数（D1 口径），judged/correct 为题数
 * （D4：待批不进分母）。
 */
function buildTrend(
  ctx: AnalyticsContext,
  scoped: readonly Attempt[],
): AnalyticsTrendPoint[] {
  if (scoped.length === 0) return [];
  const byWeek = new Map<string, Attempt[]>();
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const attempt of scoped) {
    const submittedAt = attempt.submittedAt;
    if (submittedAt === null) continue; // qualifying 恒非空，防御
    earliestMs = Math.min(earliestMs, Date.parse(submittedAt));
    const key = beijingWeekKeyOf(submittedAt);
    const list = byWeek.get(key);
    if (list === undefined) byWeek.set(key, [attempt]);
    else list.push(attempt);
  }
  if (byWeek.size === 0) return [];
  const firstWeekMs =
    ctx.range.from !== null
      ? beijingWeekStartMs(Date.parse(ctx.range.from))
      : beijingWeekStartMs(earliestMs);
  const lastWeekMs = beijingWeekStartMs(ctx.nowMs);
  const points: AnalyticsTrendPoint[] = [];
  for (
    let weekMs = firstWeekMs;
    weekMs <= lastWeekMs && points.length < TREND_BUCKET_MAX;
    weekMs += 7 * DAY_MS
  ) {
    const key = weekKeyOfMs(weekMs);
    const weekAttempts = byWeek.get(key) ?? [];
    let judged = 0;
    let correct = 0;
    for (const attempt of weekAttempts) {
      for (const response of ctx.responsesByAttempt.get(attempt.id) ?? []) {
        if (response.finalCorrect === null) continue; // D4：待批不进分母
        judged += 1;
        if (response.finalCorrect) correct += 1;
      }
    }
    points.push({
      weekStart: key,
      attemptCount: weekAttempts.length,
      judgedCount: judged,
      correctCount: correct,
      correctRate: judged > 0 ? correct / judged : null,
    });
  }
  return points;
}

// ---------- 学生 × 考点正确率（D4 双口径） ----------

/** 考点行聚合（D4：待批单独计数不进分母；错误多的在前——薄弱优先展示） */
function buildKnowledgeRows(
  ctx: AnalyticsContext,
  scoped: readonly ScopedResponse[],
): AnalyticsKnowledgeRow[] {
  interface Tally {
    correct: number;
    wrong: number;
    pending: number;
  }
  const byKnowledge = new Map<string, Tally>();
  const tallyOf = (name: string): Tally => {
    let tally = byKnowledge.get(name);
    if (tally === undefined) {
      tally = { correct: 0, wrong: 0, pending: 0 };
      byKnowledge.set(name, tally);
    }
    return tally;
  };
  for (const { response } of scoped) {
    const knowledge = knowledgeOfResponse(response, ctx.knowledgeFallback);
    if (knowledge.length === 0) continue;
    if (response.finalCorrect === null) {
      for (const name of knowledge) tallyOf(name).pending += 1;
    } else if (response.finalCorrect) {
      for (const name of knowledge) tallyOf(name).correct += 1;
    } else {
      for (const name of knowledge) tallyOf(name).wrong += 1;
    }
  }
  return [...byKnowledge.entries()]
    .map(([knowledge, tally]) => {
      const judged = tally.correct + tally.wrong;
      return {
        knowledge,
        correctCount: tally.correct,
        wrongCount: tally.wrong,
        pendingCount: tally.pending,
        judgedCount: judged,
        correctRate: judged > 0 ? tally.correct / judged : null,
      };
    })
    .sort(
      (a, b) =>
        b.wrongCount - a.wrongCount ||
        a.knowledge.localeCompare(b.knowledge, "zh-Hans-CN"),
    );
}

// ---------- 下节课重点卡片（D5 focusDays） ----------

/**
 * 「下节课重点」（focusDays 周期，默认 14 天，与 days 解耦）：错误最多 3 考点
 * + 每考点代表错题（周期内该考点错误次数最多的题；同次数取最近提交的错例）。
 * 窗口 = [now - focusDays, now]，作答口径同 D1（作业全部 + 课程首次）。
 */
function buildFocusCard(db: Db, ctx: AnalyticsContext): AnalyticsFocusCard {
  const fromIso = new Date(
    ctx.nowMs - ctx.query.focusDays * DAY_MS,
  ).toISOString();
  const focusAttempts = ctx.allAttempts.filter(
    (attempt) =>
      attempt.status !== "draft" &&
      attempt.submittedAt !== null &&
      attempt.submittedAt >= fromIso &&
      attempt.submittedAt <= ctx.range.to &&
      attempt.sourceType !== "wrong" &&
      (attempt.sourceType === "assignment" || attempt.attemptNo === 1),
  );
  // focus 窗口与 days 窗口独立：其作答的 responses 单独装载
  // （ctx.responsesByAttempt 只覆盖 qualifying = days 窗口）
  const responsesByAttempt = new Map<string, ResponseRow[]>();
  for (const ids of chunk(focusAttempts.map((attempt) => attempt.id))) {
    for (const row of db
      .select()
      .from(responses)
      .where(inArray(responses.attemptId, ids))
      .all()) {
      const list = responsesByAttempt.get(row.attemptId);
      if (list === undefined) responsesByAttempt.set(row.attemptId, [row]);
      else list.push(row);
    }
  }
  const scopedResponses: ScopedResponse[] = [];
  for (const attempt of focusAttempts) {
    for (const response of responsesByAttempt.get(attempt.id) ?? []) {
      scopedResponses.push({ response, attempt });
    }
  }

  interface PointTally {
    correct: number;
    wrong: number;
    /** 该考点周期内的错例（questionId → 次数 + 最近一次错例） */
    wrongByQuestion: Map<string, { count: number; worst: ScopedResponse }>;
  }
  const byKnowledge = new Map<string, PointTally>();
  const tallyOf = (name: string): PointTally => {
    let tally = byKnowledge.get(name);
    if (tally === undefined) {
      tally = { correct: 0, wrong: 0, wrongByQuestion: new Map() };
      byKnowledge.set(name, tally);
    }
    return tally;
  };
  for (const item of scopedResponses) {
    const finalCorrect = item.response.finalCorrect;
    if (finalCorrect === null) continue; // 待批不算错（与 D4 同精神）
    const knowledge = knowledgeOfResponse(item.response, ctx.knowledgeFallback);
    for (const name of knowledge) {
      const tally = tallyOf(name);
      if (finalCorrect) {
        tally.correct += 1;
        continue;
      }
      tally.wrong += 1;
      const entry = tally.wrongByQuestion.get(item.response.questionId);
      if (entry === undefined) {
        tally.wrongByQuestion.set(item.response.questionId, {
          count: 1,
          worst: item,
        });
      } else {
        entry.count += 1;
        if (
          (item.attempt.submittedAt ?? "") >
          (entry.worst.attempt.submittedAt ?? "")
        ) {
          entry.worst = item;
        }
      }
    }
  }

  // 学生姓名（代表错题展示；域内学生一次性读全）
  const studentNames = new Map(
    db
      .select({ id: students.id, displayName: students.displayName })
      .from(students)
      .where(eq(students.teacherId, ctx.teacherId))
      .all()
      .map((row) => [row.id, row.displayName] as const),
  );

  const points: AnalyticsFocusPoint[] = [...byKnowledge.entries()]
    .filter(([, tally]) => tally.wrong > 0)
    .sort(
      (a, b) =>
        b[1].wrong - a[1].wrong || a[0].localeCompare(b[0], "zh-Hans-CN"),
    )
    .slice(0, 3)
    .map(([knowledge, tally]) => {
      // 代表错题：周期内错误次数最多的题；同次数取最近错例（worst）
      const best = [...tally.wrongByQuestion.entries()].sort(
        (a, b) =>
          b[1].count - a[1].count ||
          (b[1].worst.attempt.submittedAt ?? "").localeCompare(
            a[1].worst.attempt.submittedAt ?? "",
          ) ||
          a[0].localeCompare(b[0]),
      )[0];
      const item = best?.[1].worst;
      const meta = item
        ? ctx.questionMeta.get(item.response.questionId)
        : undefined;
      const snapshot = item ? snapshotOfRow(item.response) : null;
      const judged = tally.correct + tally.wrong;
      return {
        knowledge,
        wrongCount: tally.wrong,
        judgedCount: judged,
        correctRate: judged > 0 ? tally.correct / judged : null,
        representative: {
          questionId: item?.response.questionId ?? "",
          stemMd: snapshot?.stemMd ?? meta?.stemMd ?? "",
          type:
            snapshot?.type ??
            (meta?.type as AnalyticsQuestionRow["type"] | undefined) ??
            "fill",
          difficulty: snapshot?.difficulty ?? meta?.difficulty ?? 2,
          knowledge: snapshot?.knowledge ?? [],
          attemptId: item?.attempt.id ?? "",
          studentId: item?.attempt.studentId ?? "",
          studentName:
            (item ? studentNames.get(item.attempt.studentId) : undefined) ?? "",
          answerText: item
            ? serializeStudentAnswer(answerOf(item.response.answerJson))
            : null,
          submittedAt: item?.attempt.submittedAt ?? "",
        },
      };
    });

  return { focusDays: ctx.query.focusDays, from: fromIso, points };
}

// ---------- 离线作答占比（T4.0 聚合消费，D13） ----------

/**
 * 离线作答占比：统计范围内每个已交卷 attempt 装载事件流
 * （events_attempt_client_ts_idx 定位）→ computeAttemptTraceMetrics 得每题
 * offlineShare（net_offline 区间 ∩ focus 区间 ÷ activeSec）→ 按 activeSec
 * 加权聚合为单一占比。原始 events 不出库（D13）。
 */
function buildOffline(
  db: Db,
  ctx: AnalyticsContext,
  scoped: readonly Attempt[],
): AnalyticsOffline {
  let activeSecTotal = 0;
  let offlineSecTotal = 0;
  for (const ids of chunk(scoped.map((attempt) => attempt.id))) {
    // 事件行按 attemptId 装载（clientTs 升序与纯函数内部排序无关，安全）
    const rawRowsByAttempt = new Map<
      string,
      Array<{
        type: string;
        clientTs: number;
        serverTs: string;
        payloadJson: string;
      }>
    >();
    for (const row of db
      .select({
        attemptId: events.attemptId,
        type: events.type,
        clientTs: events.clientTs,
        serverTs: events.serverTs,
        payloadJson: events.payloadJson,
      })
      .from(events)
      .where(inArray(events.attemptId, ids))
      .all()) {
      if (row.attemptId === null) continue; // 按 attemptId 过滤的行恒非空，防御
      const projected = {
        type: row.type,
        clientTs: row.clientTs,
        serverTs: row.serverTs,
        payloadJson: row.payloadJson,
      };
      const list = rawRowsByAttempt.get(row.attemptId);
      if (list === undefined) rawRowsByAttempt.set(row.attemptId, [projected]);
      else list.push(projected);
    }
    for (const attemptId of ids) {
      // 每题 activeSec（responses 权威口径）作分母；metrics 只对有事件证据的题立户
      const activeSecByQuestion: Record<string, number> = {};
      for (const response of ctx.responsesByAttempt.get(attemptId) ?? []) {
        if (response.activeSec !== null && response.activeSec > 0) {
          activeSecByQuestion[response.questionId] = response.activeSec;
        }
      }
      const trace: TraceEvent[] = traceEventsFromRows(
        rawRowsByAttempt.get(attemptId) ?? [],
      );
      const metrics = computeAttemptTraceMetrics(trace, activeSecByQuestion);
      for (const [questionId, sec] of Object.entries(activeSecByQuestion)) {
        activeSecTotal += sec;
        offlineSecTotal += (metrics[questionId]?.offlineShare ?? 0) * sec;
      }
    }
  }
  return {
    offlineShare:
      activeSecTotal > 0 ? Math.min(1, offlineSecTotal / activeSecTotal) : 0,
    activeSecTotal,
    offlineSecTotal: Math.round(offlineSecTotal),
  };
}

// ---------- 用时异常题（D6） ----------

/**
 * 学生的用时异常题：activeSec > 该题中位数 2 倍（slow）或 hintsUsed ≥ 2
 * （hints）；中位数取 ctx.domainMedianByQuestion（域内全部已交作答口径，见
 * buildContext 注释）。按提交时间倒序。
 */
function buildAnomalies(
  ctx: AnalyticsContext,
  scoped: readonly Attempt[],
): AnalyticsAnomalyQuestion[] {
  const out: AnalyticsAnomalyQuestion[] = [];
  for (const attempt of scoped) {
    for (const response of ctx.responsesByAttempt.get(attempt.id) ?? []) {
      const medianSec =
        ctx.domainMedianByQuestion.get(response.questionId) ?? null;
      const reasons: Array<"slow" | "hints"> = [];
      if (
        response.activeSec !== null &&
        medianSec !== null &&
        response.activeSec > 2 * medianSec
      ) {
        reasons.push("slow");
      }
      if (response.hintsUsed >= 2) reasons.push("hints");
      if (reasons.length === 0) continue;
      const snapshot = snapshotOfRow(response);
      const meta = ctx.questionMeta.get(response.questionId);
      out.push({
        attemptId: attempt.id,
        questionId: response.questionId,
        stemMd: snapshot?.stemMd ?? meta?.stemMd ?? "",
        type:
          snapshot?.type ??
          (meta?.type as AnalyticsQuestionRow["type"] | undefined) ??
          "fill",
        difficulty: snapshot?.difficulty ?? meta?.difficulty ?? 2,
        knowledge:
          snapshot?.knowledge ??
          ctx.knowledgeFallback.get(response.questionId) ??
          [],
        activeSec: response.activeSec,
        medianSec,
        multipleOfMedian:
          response.activeSec !== null && medianSec !== null && medianSec > 0
            ? round2(response.activeSec / medianSec)
            : null,
        hintsUsed: response.hintsUsed,
        reasons,
        submittedAt: attempt.submittedAt ?? "",
      });
    }
  }
  return out.sort(
    (a, b) =>
      b.submittedAt.localeCompare(a.submittedAt) ||
      a.questionId.localeCompare(b.questionId),
  );
}

// ---------- 重做概览（画像页，D1 独立指标） ----------

/**
 * 该生的课程练习重做概览：按 (课程, 单元) 分组；不受 days 限制（重做是该生的
 * 结构性事实——首次作答可能远在窗口外，重做数不该随之缩水）。attemptCount 含
 * 未交草稿；redoCount = attemptCount - 1；firstScore 取首个已交卷（D1）。
 */
function buildRedoRows(
  ctx: AnalyticsContext,
  studentId: string,
): AnalyticsRedoRow[] {
  const groups = new Map<string, Attempt[]>();
  for (const attempt of ctx.allAttempts) {
    if (
      attempt.studentId !== studentId ||
      attempt.sourceType !== "course" ||
      attempt.courseId === null ||
      attempt.unitId === null
    ) {
      continue;
    }
    const key = `${attempt.courseId}:${attempt.unitId}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [attempt]);
    else list.push(attempt);
  }
  const rows: AnalyticsRedoRow[] = [];
  for (const [key, group] of groups) {
    const sep = key.indexOf(":");
    if (sep <= 0) continue;
    const courseId = key.slice(0, sep);
    const unitId = key.slice(sep + 1);
    const submitted = group.filter((attempt) => attempt.submittedAt !== null);
    rows.push({
      courseId,
      courseName: ctx.courseNames.get(courseId) ?? null,
      unitId,
      unitTitle: ctx.unitTitles.get(unitId) ?? unitId,
      attemptCount: group.length,
      redoCount: group.length - 1,
      firstScore:
        submitted[0] === undefined ? null : effectiveScore(submitted[0]),
      latestSubmittedAt: submitted[submitted.length - 1]?.submittedAt ?? null,
    });
  }
  return rows.sort(
    (a, b) =>
      (a.courseName ?? "").localeCompare(b.courseName ?? "", "zh-Hans-CN") ||
      a.unitTitle.localeCompare(b.unitTitle, "zh-Hans-CN"),
  );
}

// ---------- 错题列表（画像页，T4.2 随契约补齐） ----------

/** 错题行上限（一对一规模防御；超出只保留最近的——契约注释同值） */
const WRONG_QUESTION_ROW_MAX = 200;

/**
 * 学生错题行：qualifying 响应中 finalCorrect=false 的逐题行（D4：待批 null
 * 不在列表）；同题多次判错取最新一次 qualifying 作答为代表（attemptId 跳详情、
 * answerText 取该次错误答案）；题干/题型/难度/考点与题目视角同源（快照优先、
 * 当前库 questionMeta 兜底）。排序 submittedAt 倒序（同刻 attemptId、
 * questionId 降序兜底稳定），截 200 条。复用已装载的 responses，零额外查询。
 */
function buildWrongQuestionRows(
  ctx: AnalyticsContext,
  responses: readonly ScopedResponse[],
): AnalyticsWrongQuestionRow[] {
  // questionId → 最新一次判错的响应（submittedAt/attemptId 降序取最大）
  const latestByQuestion = new Map<string, ScopedResponse>();
  for (const item of responses) {
    if (item.response.finalCorrect !== false) continue;
    const prev = latestByQuestion.get(item.response.questionId);
    if (prev === undefined || laterThan(item.attempt, prev.attempt)) {
      latestByQuestion.set(item.response.questionId, item);
    }
  }

  const rows: AnalyticsWrongQuestionRow[] = [];
  for (const [questionId, { response, attempt }] of latestByQuestion) {
    const meta = ctx.questionMeta.get(questionId);
    const snapshot = snapshotOfRow(response);
    const unitId = meta?.unitId ?? null;
    rows.push({
      questionId,
      unitId,
      unitTitle: unitId !== null ? (ctx.unitTitles.get(unitId) ?? null) : null,
      type:
        snapshot?.type ??
        (meta?.type as AnalyticsWrongQuestionRow["type"] | undefined) ??
        "fill",
      difficulty: snapshot?.difficulty ?? meta?.difficulty ?? 2,
      knowledge:
        snapshot?.knowledge ??
        knowledgeOfResponse(response, ctx.knowledgeFallback),
      stemMd: snapshot?.stemMd ?? meta?.stemMd ?? "",
      attemptId: attempt.id,
      answerText: serializeStudentAnswer(answerOf(response.answerJson)),
      submittedAt: attempt.submittedAt ?? "",
    });
  }
  return rows
    .sort(
      (a, b) =>
        b.submittedAt.localeCompare(a.submittedAt) ||
        b.attemptId.localeCompare(a.attemptId) ||
        b.questionId.localeCompare(a.questionId),
    )
    .slice(0, WRONG_QUESTION_ROW_MAX);
}

/** 「候选是否比现有代表作答更新」（submittedAt 同刻按 attemptId 降序兜底） */
function laterThan(candidate: Attempt, current: Attempt): boolean {
  const a = candidate.submittedAt ?? "";
  const b = current.submittedAt ?? "";
  return a > b || (a === b && candidate.id > current.id);
}

// ---------- 讲义阅读地图（画像页，T4.0b 聚合消费） ----------

/**
 * 该生读过的讲义地图：events 有归属讲义行的讲义（events_student_lecture_
 * client_ts_idx 定位 distinct），courseId 筛选时只保留该课程目录引用的讲义；
 * lectureReadingMapFor 已过滤软删讲义（返回 null 跳过）。按标题排序。
 */
function buildLectureEntries(
  db: Db,
  ctx: AnalyticsContext,
  studentId: string,
): AnalyticsLectureMapEntry[] {
  const readIds = db
    .selectDistinct({ lectureId: events.lectureId })
    .from(events)
    .where(and(eq(events.studentId, studentId), isNotNull(events.lectureId)))
    .all()
    .map((row) => row.lectureId)
    .filter((id): id is string => id !== null);
  if (readIds.length === 0) return [];

  let scopedIds = readIds;
  if (ctx.query.courseId !== undefined) {
    const inCourse = new Set(
      db
        .select({ refId: courseItems.refId })
        .from(courseItems)
        .where(
          and(
            eq(courseItems.courseId, ctx.query.courseId),
            eq(courseItems.kind, "lecture"),
          ),
        )
        .all()
        .map((row) => row.refId)
        .filter((id): id is string => id !== null),
    );
    scopedIds = readIds.filter((id) => inCourse.has(id));
  }

  const entries: AnalyticsLectureMapEntry[] = [];
  for (const lectureId of scopedIds) {
    const map = lectureReadingMapFor(db, studentId, lectureId);
    if (map === null) continue; // 讲义不存在或已软删
    const lecture = db
      .select({ title: lectures.title, updatedAt: lectures.updatedAt })
      .from(lectures)
      .where(eq(lectures.id, lectureId))
      .get();
    if (lecture === undefined) continue; // 防御：map 非空则行必存在
    entries.push({
      lectureId,
      title: lecture.title,
      updatedAt: lecture.updatedAt,
      map: {
        sections: map.sections.map((section) => ({ ...section })),
        folds: map.folds.map((fold) => ({ ...fold })),
        steps: map.steps.map((step) => ({
          ...step,
          paceSec: [...step.paceSec],
        })),
        summary: { ...map.summary },
      },
    });
  }
  return entries.sort(
    (a, b) =>
      a.title.localeCompare(b.title, "zh-Hans-CN") ||
      a.lectureId.localeCompare(b.lectureId),
  );
}

// ---------- 题目视角（D1/D4/D6 聚合） ----------

/** 高频错误答案的题型集合（judge 恒为「错误」无分布意义；手写为自由文本不聚合） */
const WRONG_ANSWER_TYPES = new Set(["fill", "choice", "multi"]);

/**
 * 题目统计行：按 questionId 聚合 qualifying 响应（D1 口径）——正确率（D4）、
 * 平均/中位用时、高频错误答案分布（top N）、异常作答数（D6 全域中位数口径）、
 * 题干取最近一次提交的快照原文（快照缺失按当前库兜底）。
 * 排序：当前库单元内题序（库中已无该题的行——如教师已软删——追加在末尾）。
 */
function buildQuestionRows(ctx: AnalyticsContext): AnalyticsQuestionRow[] {
  const scoped = scopedResponsesOf(ctx, ctx.qualifying);
  interface QuestionGroup {
    readonly rows: ScopedResponse[];
    latestSubmittedAt: string | null;
    latestAttemptId: string;
    latestSnapshot: Question | null;
  }
  const byQuestion = new Map<string, QuestionGroup>();
  for (const item of scoped) {
    let group = byQuestion.get(item.response.questionId);
    if (group === undefined) {
      group = {
        rows: [],
        latestSubmittedAt: null,
        latestAttemptId: "",
        latestSnapshot: null,
      };
      byQuestion.set(item.response.questionId, group);
    }
    group.rows.push(item);
    const submittedAt = item.attempt.submittedAt ?? "";
    if (
      group.latestSubmittedAt === null ||
      submittedAt > group.latestSubmittedAt ||
      (submittedAt === group.latestSubmittedAt &&
        item.attempt.id > group.latestAttemptId)
    ) {
      group.latestSubmittedAt = submittedAt;
      group.latestAttemptId = item.attempt.id;
      group.latestSnapshot = snapshotOfRow(item.response);
    }
  }

  const rows: AnalyticsQuestionRow[] = [];
  for (const [questionId, group] of byQuestion) {
    const meta = ctx.questionMeta.get(questionId);
    const snapshot = group.latestSnapshot;
    const type =
      snapshot?.type ??
      (meta?.type as AnalyticsQuestionRow["type"] | undefined) ??
      "fill";
    let judged = 0;
    let correct = 0;
    let pending = 0;
    const secs: number[] = [];
    let anomalyCount = 0;
    const wrongAnswerCount = new Map<string, number>();
    for (const { response } of group.rows) {
      if (response.finalCorrect === null) {
        pending += 1; // D4：待批单列，不进分母
      } else if (response.finalCorrect) {
        judged += 1;
        correct += 1;
      } else {
        judged += 1;
        if (WRONG_ANSWER_TYPES.has(type)) {
          const key = serializeStudentAnswer(answerOf(response.answerJson));
          const mapKey = key ?? "\u0000未作答";
          wrongAnswerCount.set(mapKey, (wrongAnswerCount.get(mapKey) ?? 0) + 1);
        }
      }
      if (response.activeSec !== null) secs.push(response.activeSec);
      // D6 判定（与画像异常同一口径：全域中位数 + 提示数）
      const domainMedian = ctx.domainMedianByQuestion.get(questionId) ?? null;
      if (
        (response.activeSec !== null &&
          domainMedian !== null &&
          response.activeSec > 2 * domainMedian) ||
        response.hintsUsed >= 2
      ) {
        anomalyCount += 1;
      }
    }
    const wrongAnswers: AnalyticsWrongAnswer[] = [...wrongAnswerCount.entries()]
      .map(([key, count]) => ({
        // 「\u0000未作答」哨兵键 → 契约的 null 条目（Phase3 D1 未作答判错）
        answerText: key === "\u0000未作答" ? null : key,
        count,
      }))
      .sort(
        (a, b) =>
          b.count - a.count ||
          (a.answerText ?? "￿").localeCompare(
            b.answerText ?? "￿",
            "zh-Hans-CN",
          ),
      )
      .slice(0, ANALYTICS_WRONG_ANSWER_TOP_N);

    const unitId = meta?.unitId ?? null;
    rows.push({
      questionId,
      unitId,
      unitTitle: unitId !== null ? (ctx.unitTitles.get(unitId) ?? null) : null,
      type,
      difficulty: snapshot?.difficulty ?? meta?.difficulty ?? 2,
      knowledge:
        snapshot?.knowledge ?? ctx.knowledgeFallback.get(questionId) ?? [],
      stemMd: snapshot?.stemMd ?? meta?.stemMd ?? "",
      submittedCount: group.rows.length,
      judgedCount: judged,
      correctCount: correct,
      pendingCount: pending,
      correctRate: judged > 0 ? correct / judged : null,
      avgSec:
        secs.length > 0
          ? Math.round(secs.reduce((sum, sec) => sum + sec, 0) / secs.length)
          : null,
      medianSec: medianOf(secs),
      anomalyCount,
      wrongAnswers,
      lastSubmittedAt: group.latestSubmittedAt,
    });
  }

  // 排序：库内题按（单元 id、题序）；库中已无该题的行（软删/异常）追加在末尾
  return rows.sort((a, b) => {
    const metaA = ctx.questionMeta.get(a.questionId);
    const metaB = ctx.questionMeta.get(b.questionId);
    if (metaA !== undefined && metaB !== undefined) {
      return (
        metaA.unitId.localeCompare(metaB.unitId) ||
        metaA.order - metaB.order ||
        a.questionId.localeCompare(b.questionId)
      );
    }
    if (metaA !== undefined) return -1;
    if (metaB !== undefined) return 1;
    return a.questionId.localeCompare(b.questionId);
  });
}

// ---------- 公共接口 ----------

/**
 * GET /api/teacher/analytics/overview：总览页数据（完成矩阵 + 周趋势 + 下节课
 * 重点 + 关键计数 + 离线占比 + 重做计数）。教师域隔离（D7）；courseId 筛选
 * （D3）；days 窗口只作用于趋势/重点/离线/重做/汇总（D5），矩阵与待批数不受
 * days 影响（矩阵是当下状态、待批是当下批改队列）。
 */
export function getAnalyticsOverview(
  db: Db,
  teacherId: string,
  query: AnalyticsQuery,
  now: Date | string = new Date(),
): AnalyticsOverviewData {
  // 查询归一化（路由层已解析过，幂等；直接调 service 的测试与后续 MCP 复用同默认值）
  const ctx = buildContext(
    db,
    teacherId,
    analyticsQuerySchema.parse(query),
    now,
  );
  const matrix = buildMatrix(db, ctx);
  const trend = buildTrend(ctx, ctx.qualifying);
  const focus = buildFocusCard(db, ctx);
  const offline = buildOffline(db, ctx, ctx.qualifying);

  // 待批数（D4 共享谓词；D3 域+课程筛选、不受 days——旧作业的待批同样要批）
  const pendingByAttempt = pendingMarkCounts(db, ctx.allAttempts);
  let pendingMarkCount = 0;
  for (const count of pendingByAttempt.values()) pendingMarkCount += count;

  // 周期内发生的课程练习重做次数（D1 独立指标；attemptNo>1 且交卷落窗）
  const fromIso = ctx.range.from;
  const redoCount = ctx.allAttempts.filter(
    (attempt) =>
      attempt.sourceType === "course" &&
      attempt.attemptNo > 1 &&
      attempt.submittedAt !== null &&
      (fromIso === null || attempt.submittedAt >= fromIso) &&
      attempt.submittedAt <= ctx.range.to,
  ).length;

  // 周期内全域汇总（D4 口径）
  let judged = 0;
  let correct = 0;
  for (const { response } of scopedResponsesOf(ctx, ctx.qualifying)) {
    if (response.finalCorrect === null) continue;
    judged += 1;
    if (response.finalCorrect) correct += 1;
  }

  return {
    range: ctx.range,
    focusDays: ctx.query.focusDays,
    matrix,
    trend,
    focus,
    pendingMarkCount,
    studentCount: ctx.studentRows.length,
    redoCount,
    offline,
    overall: {
      judgedCount: judged,
      correctCount: correct,
      correctRate: judged > 0 ? correct / judged : null,
    },
  };
}

/**
 * GET /api/teacher/analytics/student/:id：学生画像页数据。学生不属于本教师 →
 * 404 STUDENT_NOT_FOUND（D7，不暴露存在性）；其余指标按 days 窗口，redo 与
 * 讲义地图不受 days（重做是结构性事实；阅读历史按讲义聚合）。
 */
export function getAnalyticsStudent(
  db: Db,
  teacherId: string,
  studentId: string,
  query: AnalyticsQuery,
  now: Date | string = new Date(),
): AnalyticsStudentData {
  query = analyticsQuerySchema.parse(query);
  const row = db
    .select({
      id: students.id,
      displayName: students.displayName,
      archivedAt: students.archivedAt,
    })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.teacherId, teacherId)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "STUDENT_NOT_FOUND", "学生不存在");
  }

  const ctx = buildContext(db, teacherId, query, now);
  const scoped = qualifyingOfStudent(ctx, studentId);
  const responses = scopedResponsesOf(ctx, scoped);
  let judged = 0;
  let correct = 0;
  let pending = 0;
  for (const { response } of responses) {
    if (response.finalCorrect === null) pending += 1;
    else {
      judged += 1;
      if (response.finalCorrect) correct += 1;
    }
  }

  return {
    studentId: row.id,
    studentName: row.displayName,
    archived: row.archivedAt !== null,
    range: ctx.range,
    trend: buildTrend(ctx, scoped),
    knowledge: buildKnowledgeRows(ctx, responses),
    totals: {
      judgedCount: judged,
      correctCount: correct,
      pendingCount: pending,
      correctRate: judged > 0 ? correct / judged : null,
    },
    anomalies: buildAnomalies(ctx, scoped),
    redo: buildRedoRows(ctx, studentId),
    wrongQuestions: buildWrongQuestionRows(ctx, responses),
    offline: buildOffline(db, ctx, scoped),
    lectures: buildLectureEntries(db, ctx, studentId),
  };
}

/**
 * GET /api/teacher/analytics/questions：题目视角统计（正确率/平均用时/中位用时/
 * 高频错误答案/异常计数）。教师域隔离（D7）；D1/D4/D5 口径同总览。
 */
export function getAnalyticsQuestions(
  db: Db,
  teacherId: string,
  query: AnalyticsQuery,
  now: Date | string = new Date(),
): AnalyticsQuestionsData {
  const ctx = buildContext(
    db,
    teacherId,
    analyticsQuerySchema.parse(query),
    now,
  );
  return { range: ctx.range, questions: buildQuestionRows(ctx) };
}
