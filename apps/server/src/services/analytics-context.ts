import type {
  AnalyticsQuery,
  AnalyticsRange,
  AnalyticsStudentRow,
} from "@tutor/contract";
import {
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  assignments,
  attempts,
  courseStudents,
  courses,
  knowledgePoints,
  questionKnowledge,
  questions,
  type ResponseRow,
  responses,
  students,
  units,
} from "../db/schema";
import { chunk } from "../lib/chunk";
import { analyticsTimesOf } from "./analytics-time";
import { recordableAttemptWhere } from "./attempt-recordability.ts";
import { attemptResultCounts } from "./result-counts";

export const DAY_MS = 86_400_000;

/** 数值中位数（空数组为 null；偶数个取中间两数平均） */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (sorted.length % 2 === 1) return upper ?? null;
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

export interface AnalyticsContext {
  readonly resultCounts: ReturnType<typeof attemptResultCounts>;
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
  readonly times: ReturnType<typeof analyticsTimesOf>;
  readonly domainMedianByQuestion: ReadonlyMap<string, number>;
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
export function buildContext(
  db: Db,
  teacherId: string,
  query: AnalyticsQuery,
  now: Date | string,
  view:
    | { kind: "overview" | "questions" }
    | { kind: "student"; studentId: string },
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
  const studentRows: AnalyticsStudentRow[] =
    view.kind === "overview" && courseScopeValid
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
              .where(
                and(
                  eq(courseStudents.courseId, query.courseId),
                  eq(students.teacherId, teacherId),
                ),
              )
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

  // 旧作业卷的 courseId 为空时才回看作业所属课程。快照归属优先。
  const courseId = query.courseId;
  const courseCondition =
    courseId === undefined
      ? undefined
      : or(
          eq(attempts.courseId, courseId),
          and(
            isNull(attempts.courseId),
            exists(
              db
                .select({ id: assignments.id })
                .from(assignments)
                .where(
                  and(
                    eq(assignments.id, attempts.assignmentId),
                    eq(assignments.teacherId, teacherId),
                    eq(assignments.courseId, courseId),
                  ),
                ),
            ),
          ),
        );
  const timeCondition = and(
    ne(attempts.status, "draft"),
    isNotNull(attempts.submittedAt),
    fromIso === null ? undefined : gte(attempts.submittedAt, fromIso),
    lte(attempts.submittedAt, nowIso),
    ne(attempts.sourceType, "wrong"),
    or(eq(attempts.sourceType, "assignment"), eq(attempts.attemptNo, 1)),
  );
  const rows = courseScopeValid
    ? db
        .select({
          attempt: attempts,
          qualifies: sql<number>`case when ${timeCondition} then 1 else 0 end`,
        })
        .from(attempts)
        .innerJoin(students, eq(attempts.studentId, students.id))
        .where(
          and(
            eq(students.teacherId, teacherId),
            recordableAttemptWhere(),
            courseCondition,
            view.kind === "student"
              ? eq(attempts.studentId, view.studentId)
              : undefined,
            view.kind === "questions" ? timeCondition : undefined,
          ),
        )
        .orderBy(asc(attempts.submittedAt), asc(attempts.id))
        .all()
    : [];
  const allAttempts = rows.map(({ attempt }) => attempt);
  const qualifying = rows
    .filter(({ qualifies }) => qualifies === 1)
    .map(({ attempt }) => attempt);
  const responsesByAttempt = loadAnalyticsResponses(
    db,
    qualifying.map(({ id }) => id),
  );
  const questionIds = new Set<string>();
  if (view.kind !== "overview") {
    for (const rows of responsesByAttempt.values()) {
      for (const row of rows) questionIds.add(row.questionId);
    }
  }
  const domainMedianByQuestion =
    questionIds.size === 0
      ? new Map<string, number>()
      : loadDomainMedians(db, teacherId, [...questionIds]);

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
    resultCounts:
      view.kind === "questions"
        ? new Map()
        : attemptResultCounts(db, allAttempts),
    range: { days: query.days, from: fromIso, to: nowIso },
    nowMs,
    studentRows,
    courseNames,
    unitTitles,
    qualifying,
    responsesByAttempt,
    allAttempts,
    times: analyticsTimesOf(db, teacherId),
    domainMedianByQuestion,
    questionMeta,
    knowledgeFallback,
  };
}

/** 以作答 ID 批取响应，供统计窗口和重点窗口共用。 */
export function loadAnalyticsResponses(
  db: Db,
  attemptIds: readonly string[],
): Map<string, ResponseRow[]> {
  const byAttempt = new Map<string, ResponseRow[]>();
  for (const ids of chunk(attemptIds)) {
    for (const row of db
      .select()
      .from(responses)
      .where(inArray(responses.attemptId, ids))
      .all()) {
      const list = byAttempt.get(row.attemptId);
      if (list === undefined) byAttempt.set(row.attemptId, [row]);
      else list.push(row);
    }
  }
  return byAttempt;
}

/** 只查需要展示的题，按秒数分桶。中位数仍使用本教师域内所有已交作答。 */
function loadDomainMedians(
  db: Db,
  teacherId: string,
  questionIds: readonly string[],
): ReadonlyMap<string, number> {
  const medianInput = db.$with("median_input").as(
    db
      .select({
        questionId: responses.questionId,
        activeSec: responses.activeSec,
        count: sql<number>`count(*)`.as("sample_count"),
      })
      .from(responses)
      .innerJoin(attempts, eq(attempts.id, responses.attemptId))
      .innerJoin(students, eq(students.id, attempts.studentId))
      .where(
        and(
          eq(students.teacherId, teacherId),
          ne(attempts.status, "draft"),
          isNotNull(responses.activeSec),
          sql`${responses.questionId} in (select value from json_each(${JSON.stringify(questionIds)}))`,
        ),
      )
      .groupBy(responses.questionId, responses.activeSec),
  );
  const bins = db
    .with(medianInput)
    .select()
    .from(medianInput)
    .orderBy(asc(medianInput.questionId), asc(medianInput.activeSec))
    .all();
  const medians = new Map<string, number>();
  const sizes = new Map<string, number>();
  for (const bin of bins)
    sizes.set(bin.questionId, (sizes.get(bin.questionId) ?? 0) + bin.count);

  let questionId: string | undefined;
  let offset = 0;
  let lower: number | undefined;
  for (const bin of bins) {
    if (bin.activeSec === null) continue;
    if (bin.questionId !== questionId) {
      questionId = bin.questionId;
      offset = 0;
      lower = undefined;
    }
    const size = sizes.get(questionId) ?? 0;
    const nextOffset = offset + bin.count;
    if (lower === undefined && nextOffset > Math.floor((size - 1) / 2))
      lower = bin.activeSec;
    if (
      lower !== undefined &&
      offset <= Math.floor(size / 2) &&
      nextOffset > Math.floor(size / 2)
    ) {
      medians.set(questionId, (lower + bin.activeSec) / 2);
    }
    offset = nextOffset;
  }
  return medians;
}
