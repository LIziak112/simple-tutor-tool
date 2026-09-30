import type {
  StudentCourseDetailData,
  StudentCourseSummary,
  StudentLectureCourseGroup,
  StudentLectureDetail,
  StudentLectureListData,
  StudentLectureSummary,
  StudentUnitAttemptSummary,
  StudentUnitLandingData,
} from "@tutor/contract";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  attempts,
  courseStudents,
  courses,
  lectures,
  questions,
  students,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { listVisibleItems, requireVisibleCourseUnit } from "./course-service";
import { pendingMarkCounts } from "./pending-mark.ts";

/**
 * 学生端课程与讲义读路径（T2A.5，核心切换：可见性模型从「全量讲义 + deletedAt 过滤」
 * 窗口期实现切换到 D5）。四个入口全部复用 listVisibleItems → canStudentSeeItem
 * 唯一判定（清单 §2 D5），隐藏/未到发布/资源已删除条目零信息（不出现在条目列表，
 * 也不计入任何计数）：
 * - listStudentCourses：我的课程（成员 + 课程未归档），可见讲义/单元计数 +
 *   completedUnitCount（T2A.6 起 = 至少交卷 1 次的可见单元数，首页课程卡片进度）；
 * - getStudentCourseDetail：课程可见目录（单元条目带题数 + 课程练习作答摘要，D10）；
 * - getStudentUnitLanding（T2A.6）：单元落地信息——题数/题型分布/历次作答/
 *   首次/最近/最高分/是否有未交卷作答；
 * - listStudentLectures：可见讲义 = 所在全部课程中可见讲义条目的并集（双视图）；
 * - getStudentLecture：讲义详情 + 课程上下文 +「本课配套练习」（D8）。
 *
 * 错误口径（D22）：非成员/学生已归档/课程已归档 → 403 COURSE_ACCESS_DENIED；
 * 课程或讲义不存在/条目隐藏/未到发布/资源已删除 → 404 NOT_FOUND（不暴露存在性）。
 * now 可注入（publishAt 到点判断；路由传真实时间，测试传固定时间）。
 *
 * 安全口径（AGENTS.md 第 3 条）：全部查询只 SELECT 目录与资源元信息列，
 * 不触碰 questions 的任何内容列（题数只做 COUNT(*)；题型分布只按 type 分组）。
 *
 * T2B.5（D10）：学生侧无会话教师，units/questions 的全部查询按课程根行
 * （courses.teacherId，目录/落地页/配套练习）或学生归属（students.teacherId，
 * 跨课程 topic 聚合）推导教师域带入——复合主键后同 id 单元/题目分属不同教师，
 * 目录与题数不可串域；对外行为零变化（讲义/课程 id 为 uuid 全局唯一，无需域）。
 */

/** 学生可见的课程上下文（D5 条件 1、2：成员 + 双方未归档）。teacherId 为课程
 * 根行的教师域（T2B.5，D10：课程目录/题数/配套练习的资源侧查询全部按它域内读） */
interface VisibleCourse {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly order: number;
  readonly teacherId: string;
}

/**
 * 该生为成员且未归档的课程（按 course.order 升序）。
 * 学生已归档 → 空数组（requireStudent 守卫已拦 401，此处防御性兜底）。
 * D9 异常行防御：无教师域的课程行（回填后不应存在）无从判定资源归属 → 跳过。
 */
function visibleCoursesOfStudent(db: Db, studentId: string): VisibleCourse[] {
  const student = db
    .select({ id: students.id, archivedAt: students.archivedAt })
    .from(students)
    .where(eq(students.id, studentId))
    .get();
  if (student === undefined || student.archivedAt !== null) return [];
  return db
    .select({
      id: courses.id,
      title: courses.title,
      description: courses.description,
      order: courses.order,
      teacherId: courses.teacherId,
    })
    .from(courseStudents)
    .innerJoin(courses, eq(courseStudents.courseId, courses.id))
    .where(
      and(eq(courseStudents.studentId, studentId), isNull(courses.archivedAt)),
    )
    .orderBy(asc(courses.order), asc(courses.title))
    .all()
    .filter((course): course is VisibleCourse => course.teacherId !== null);
}

/**
 * 若干单元的未删除题目数（D5 条件 4 与「n 题」展示共用；只 COUNT，不读内容列）。
 * T2B.5：按课程根行的教师域域内统计（D10——同 id 单元分属不同教师，计数不可混）。
 */
function liveQuestionCounts(
  db: Db,
  teacherId: string,
  unitIds: readonly string[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (unitIds.length === 0) return map;
  for (const row of db
    .select({ unitId: questions.unitId })
    .from(questions)
    .where(
      and(
        eq(questions.teacherId, teacherId),
        inArray(questions.unitId, [...unitIds]),
        isNull(questions.deletedAt),
      ),
    )
    .all()) {
    map.set(row.unitId, (map.get(row.unitId) ?? 0) + 1);
  }
  return map;
}

/** 403 COURSE_ACCESS_DENIED（D22：非成员 / 学生已归档 / 课程已归档） */
function courseAccessDenied(): HttpError {
  return new HttpError(
    403,
    "COURSE_ACCESS_DENIED",
    "无法访问该课程（可能已被移出，或课程已结束归档）",
  );
}

/** 学生归属教师域（T2B.5，D10/D14：一生一位；D9 异常行 null → 调用方按空处理） */
function studentTeacherIdOf(db: Db, studentId: string): string | null {
  return (
    db
      .select({ teacherId: students.teacherId })
      .from(students)
      .where(eq(students.id, studentId))
      .get()?.teacherId ?? null
  );
}

/** 404 NOT_FOUND（D22：不暴露存在性——课程/讲义不存在、条目隐藏等统一口径） */
function notFound(): HttpError {
  return new HttpError(
    404,
    "NOT_FOUND",
    "没有找到该内容（可能尚未发布或已被移除）",
  );
}

// ---------- 我的课程（GET /api/student/courses） ----------

/**
 * 某学生在某课程的各单元课程练习作答汇总（D10；只统计 sourceType='course'——
 * 作业作答不计入，互不计次）。返回 unitId → 摘要（含 pendingCount：D4 共享
 * 待批谓词——已交卷 attempt 中 finalCorrect 为空的题数，draft 恒 0；不再叠加
 * answerJson 非空条件，只写笔迹未填最终答案的手写题也计入）。
 */
export function courseUnitAttemptSummaries(
  db: Db,
  studentId: string,
  courseId: string,
): Map<string, StudentUnitAttemptSummary> {
  const rows = db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.studentId, studentId),
        eq(attempts.sourceType, "course"),
        eq(attempts.courseId, courseId),
      ),
    )
    .orderBy(asc(attempts.attemptNo))
    .all();
  if (rows.length === 0) return new Map();

  // 待批题数（按 attempt 聚合后归到单元；draft 恒 0）
  const pendingByAttempt = pendingMarkCounts(db, rows);

  interface CellState extends StudentUnitAttemptSummary {
    firstSubmittedSeen: boolean;
  }
  const byUnit = new Map<string, CellState>();
  for (const row of rows) {
    const unitId = row.unitId ?? "";
    const cell =
      byUnit.get(unitId) ??
      ({
        count: 0,
        submittedCount: 0,
        hasDraft: false,
        firstScore: null,
        latestScore: null,
        bestScore: null,
        pendingCount: 0,
        firstSubmittedSeen: false,
      } satisfies CellState);
    cell.count += 1;
    cell.pendingCount += pendingByAttempt.get(row.id) ?? 0;
    const score = row.scoreFinal ?? row.scoreAuto;
    if (row.status === "draft") {
      cell.hasDraft = true;
    } else {
      cell.submittedCount += 1;
      // attemptNo 升序遍历：首个交卷即首次得分（无可判分保持 null），
      // 最后一个交卷即最近得分；最高分取非空得分的最大值（教师侧统计优先用首次分）
      if (!cell.firstSubmittedSeen) {
        cell.firstSubmittedSeen = true;
        cell.firstScore = score;
      }
      cell.latestScore = score;
      if (score !== null) {
        cell.bestScore = Math.max(cell.bestScore ?? 0, score);
      }
    }
    byUnit.set(unitId, cell);
  }

  const result = new Map<string, StudentUnitAttemptSummary>();
  for (const [unitId, cell] of byUnit) {
    const { firstSubmittedSeen: _omit, ...summary } = cell;
    result.set(unitId, summary);
  }
  return result;
}

/**
 * 我的课程列表（成员 + 未归档课程，order 升序）。
 * 可见计数取自 listVisibleItems（隐藏条目不计入）；completedUnitCount =
 * 至少交卷 1 次的可见单元数（T2A.6 起接入课程练习作答；作业作答不计入）。
 * 归档课程与非成员课程完全不出现在列表（零信息）。
 */
export function listStudentCourses(
  db: Db,
  studentId: string,
  now: Date | string = new Date(),
): { courses: StudentCourseSummary[] } {
  const visibleCourses = visibleCoursesOfStudent(db, studentId);
  const courseSummaries: StudentCourseSummary[] = visibleCourses.map(
    (course) => {
      const items = listVisibleItems(db, studentId, course.id, now);
      const unitItems = items.filter((item) => item.kind === "unit");
      const summaries = courseUnitAttemptSummaries(db, studentId, course.id);
      return {
        id: course.id,
        name: course.title,
        description: course.description,
        visibleLectureCount: items.filter((item) => item.kind === "lecture")
          .length,
        visibleUnitCount: unitItems.length,
        completedUnitCount: unitItems.filter(
          (item) =>
            item.refId !== null &&
            (summaries.get(item.refId)?.submittedCount ?? 0) > 0,
        ).length,
      };
    },
  );
  return { courses: courseSummaries };
}

// ---------- 课程可见目录（GET /api/student/courses/:id） ----------

/**
 * 某课程的可见目录（D5 过滤，order 升序；单元条目带未删除题数 + 课程练习作答
 * 摘要（T2A.6 起，目录单元项据此显示「未做/进行中/已完成/有待批」））。
 * 课程不存在 → 404 NOT_FOUND；非成员/学生已归档/课程已归档 → 403
 * COURSE_ACCESS_DENIED（D22）。隐藏条目零信息。
 * T2B.5：题数按课程根行 teacherId 域内统计（D10，对外行为不变）。
 */
export function getStudentCourseDetail(
  db: Db,
  studentId: string,
  courseId: string,
  now: Date | string = new Date(),
): StudentCourseDetailData {
  const course = db
    .select({
      id: courses.id,
      title: courses.title,
      description: courses.description,
      archivedAt: courses.archivedAt,
      teacherId: courses.teacherId,
    })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (course === undefined) {
    throw notFound();
  }
  const student = db
    .select({ id: students.id, archivedAt: students.archivedAt })
    .from(students)
    .where(eq(students.id, studentId))
    .get();
  const isMember =
    db
      .select({ studentId: courseStudents.studentId })
      .from(courseStudents)
      .where(
        and(
          eq(courseStudents.courseId, courseId),
          eq(courseStudents.studentId, studentId),
        ),
      )
      .get() !== undefined;
  if (
    !isMember ||
    (student !== undefined && student.archivedAt !== null) ||
    student === undefined ||
    course.archivedAt !== null
  ) {
    throw courseAccessDenied();
  }
  // D9 异常行防御：无教师域的课程无从判定资源归属 → 按不可见处理（fail closed）
  if (course.teacherId === null) {
    throw notFound();
  }

  const items = listVisibleItems(db, studentId, courseId, now);
  const unitIds = items
    .filter((item) => item.kind === "unit")
    .map((item) => item.refId as string);
  const counts = liveQuestionCounts(db, course.teacherId, unitIds);
  const attemptSummaries = courseUnitAttemptSummaries(db, studentId, courseId);
  return {
    id: course.id,
    name: course.title,
    description: course.description,
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      refId: item.refId,
      title: item.title,
      order: item.order,
      questionCount:
        item.kind === "unit" ? (counts.get(item.refId ?? "") ?? 0) : null,
      // 单元条目的课程练习作答摘要（从未做为 null；作业作答不计入）
      attempt:
        item.kind === "unit"
          ? (attemptSummaries.get(item.refId ?? "") ?? null)
          : null,
    })),
  };
}

// ---------- 单元落地页（GET /api/student/courses/:id/units/:unitId，T2A.6） ----------

/**
 * 单元落地信息（D10）：题数、题型分布、历次作答列表（attemptNo、状态、得分、
 * 交卷时间）、首次/最近/最高分、是否存在未交卷作答。
 * 访问权：requireVisibleCourseUnit（D5 + D22——非成员/归档 403、不可见 404）。
 * 安全：只读 questions 的 type 列做分布统计，不触碰任何内容列。
 * T2B.5：单元标题/题数/题型分布按课程根行 teacherId 域内读（D10，对外行为不变）。
 */
export function getStudentUnitLanding(
  db: Db,
  studentId: string,
  courseId: string,
  unitId: string,
  now: Date | string = new Date(),
): StudentUnitLandingData {
  // 访问权门（D5 + D22；返回值不需要——标题/主题直接取资源当前值）
  requireVisibleCourseUnit(db, studentId, courseId, unitId, now);
  const course = db
    .select({ title: courses.title, teacherId: courses.teacherId })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (course === undefined || course.teacherId === null) {
    throw notFound(); // 防御：可见门通过后资源必存在（D9 异常行 fail closed）
  }
  const unit = db
    .select({ title: units.title, topic: units.topic })
    .from(units)
    .where(
      and(
        eq(units.teacherId, course.teacherId),
        eq(units.id, unitId),
        isNull(units.deletedAt),
      ),
    )
    .get();
  if (unit === undefined) {
    throw notFound(); // 防御：可见门通过后资源必存在
  }

  // 题数与题型分布（只按 type 分组计数；域内统计）
  const typeDistribution: Record<string, number> = {};
  let questionCount = 0;
  for (const row of db
    .select({ type: questions.type })
    .from(questions)
    .where(
      and(
        eq(questions.teacherId, course.teacherId),
        eq(questions.unitId, unitId),
        isNull(questions.deletedAt),
      ),
    )
    .all()) {
    questionCount += 1;
    typeDistribution[row.type] = (typeDistribution[row.type] ?? 0) + 1;
  }

  // 历次作答（attemptNo 降序，最近在前）
  const attemptRows: Attempt[] = db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.studentId, studentId),
        eq(attempts.sourceType, "course"),
        eq(attempts.courseId, courseId),
        eq(attempts.unitId, unitId),
      ),
    )
    .orderBy(desc(attempts.attemptNo))
    .all();
  const attemptsByUnit = courseUnitAttemptSummaries(db, studentId, courseId);

  return {
    courseId,
    courseName: course.title,
    unitId,
    title: unit.title,
    topic: unit.topic,
    questionCount,
    typeDistribution,
    attempts: attemptRows.map((row) => ({
      attemptId: row.id,
      attemptNo: row.attemptNo,
      status: row.status,
      score: row.scoreFinal ?? row.scoreAuto,
      startedAt: row.startedAt,
      submittedAt: row.submittedAt,
    })),
    summary: attemptsByUnit.get(unitId) ?? null,
  };
}

// ---------- 可见讲义（GET /api/student/lectures） ----------

/** 某课程可见讲义条目（listVisibleItems 的 lecture 过滤；保持条目顺序） */
function visibleLectureItems(
  db: Db,
  studentId: string,
  courseId: string,
  now: Date | string,
) {
  return listVisibleItems(db, studentId, courseId, now).filter(
    (item) => item.kind === "lecture",
  );
}

/** 该生可见单元条目的去重集合（topic 聚合只由可见配套单元贡献，D8 + 隐藏零信息） */
function visibleUnitItemsOfStudent(
  db: Db,
  visibleCourses: readonly VisibleCourse[],
  studentId: string,
  now: Date | string,
): { refId: string; order: number }[] {
  const seen = new Set<string>();
  const result: { refId: string; order: number }[] = [];
  for (const course of visibleCourses) {
    for (const item of listVisibleItems(db, studentId, course.id, now)) {
      if (item.kind !== "unit" || item.refId === null || seen.has(item.refId)) {
        continue;
      }
      seen.add(item.refId);
      result.push({ refId: item.refId, order: item.order });
    }
  }
  return result;
}

/**
 * 讲义 id → 可见配套单元中排序最靠前的 topic（单元 order 兜底课程条目 order）。
 * 只读 units 的 topic/order/lectureId/deletedAt 元信息列。
 * T2B.5：按学生归属教师的域域内读（可见课程全部归属该教师，D10/D14）。
 */
function visibleCompanionTopics(
  db: Db,
  teacherId: string,
  visibleUnits: readonly { refId: string; order: number }[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (visibleUnits.length === 0) return map;
  const rows = db
    .select({
      id: units.id,
      lectureId: units.lectureId,
      topic: units.topic,
      order: units.order,
    })
    .from(units)
    .where(
      and(
        eq(units.teacherId, teacherId),
        inArray(
          units.id,
          visibleUnits.map((unit) => unit.refId),
        ),
        isNull(units.deletedAt),
      ),
    )
    .orderBy(asc(units.order))
    .all();
  const unitOrderById = new Map(
    visibleUnits.map((unit) => [unit.refId, unit.order] as const),
  );
  // 稳定排序：单元库内 order（units.order，跨课程可比）优先，可见条目 order 兜底
  const sorted = [...rows].sort(
    (a, b) =>
      a.order - b.order ||
      (unitOrderById.get(a.id) ?? 0) - (unitOrderById.get(b.id) ?? 0),
  );
  for (const row of sorted) {
    if (row.lectureId === null || row.topic === null) continue;
    if (!map.has(row.lectureId)) map.set(row.lectureId, row.topic);
  }
  return map;
}

/**
 * 可见讲义双视图（D5：所在全部课程可见讲义条目的并集）：
 * - lectures：去重并集（同一讲义多课只出现一次），排序取最优位置
 *   （course.order → 首个可见条目 order → 标题兜底）；
 * - courses：按课程分组（只含有可见讲义的课程；组内按目录条目 order）。
 * topic 只由对该生可见的配套单元贡献（隐藏单元零信息）。
 */
export function listStudentLectures(
  db: Db,
  studentId: string,
  now: Date | string = new Date(),
): StudentLectureListData {
  const visibleCourses = visibleCoursesOfStudent(db, studentId);

  // 每篇可见讲义在各课程中的条目位置（courseIndex 已按 order 升序）
  const lectureRows = new Map<
    string,
    { id: string; title: string; updatedAt: string; order: number }
  >();
  /** 讲义 id → (courseIndex, itemOrder) 最优位置（去重列表排序用） */
  const bestKeyByLecture = new Map<string, readonly [number, number]>();
  const groups: StudentLectureCourseGroup[] = [];

  for (const [courseIndex, course] of visibleCourses.entries()) {
    const items = visibleLectureItems(db, studentId, course.id, now);
    if (items.length === 0) continue;
    const ids = items.map((item) => item.refId as string);
    const rows = db
      .select({
        id: lectures.id,
        title: lectures.title,
        updatedAt: lectures.updatedAt,
        order: lectures.order,
      })
      .from(lectures)
      .where(inArray(lectures.id, ids))
      .all();
    const rowById = new Map(rows.map((row) => [row.id, row] as const));
    const summaries: StudentLectureSummary[] = [];
    for (const item of items) {
      const row = rowById.get(item.refId ?? "");
      if (row === undefined) continue; // 资源行缺失（不应发生）：跳过
      lectureRows.set(row.id, row);
      const key: readonly [number, number] = [courseIndex, item.order];
      const existing = bestKeyByLecture.get(row.id);
      if (
        existing === undefined ||
        key[0] < existing[0] ||
        (key[0] === existing[0] && key[1] < existing[1])
      ) {
        bestKeyByLecture.set(row.id, key);
      }
      summaries.push({
        id: row.id,
        title: row.title,
        topic: null, // 稍后统一填充（可见配套单元聚合）
        updatedAt: row.updatedAt,
      });
    }
    groups.push({
      courseId: course.id,
      courseName: course.title,
      lectures: summaries,
    });
  }

  // topic：可见配套单元（跨课程去重）中排序最靠前者的主题
  //（配套单元按学生归属教师的域读，T2B.5 D10；异常行无域 → 无 topic，fail closed）
  const teacherIdOfStudent = studentTeacherIdOf(db, studentId);
  const topics =
    teacherIdOfStudent === null
      ? new Map<string, string>()
      : visibleCompanionTopics(
          db,
          teacherIdOfStudent,
          visibleUnitItemsOfStudent(db, visibleCourses, studentId, now),
        );
  const withTopic = (
    summary: StudentLectureSummary,
  ): StudentLectureSummary => ({
    ...summary,
    topic: topics.get(summary.id) ?? null,
  });

  // 去重并集：最优位置排序（标题兜底，保证输出稳定）
  const deduped = [...lectureRows.values()].sort((a, b) => {
    const ka = bestKeyByLecture.get(a.id) ?? [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ];
    const kb = bestKeyByLecture.get(b.id) ?? [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ];
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return a.title.localeCompare(b.title);
  });

  return {
    lectures: deduped.map((row) =>
      withTopic({
        id: row.id,
        title: row.title,
        topic: null,
        updatedAt: row.updatedAt,
      }),
    ),
    courses: groups.map((group) => ({
      courseId: group.courseId,
      courseName: group.courseName,
      lectures: group.lectures.map(withTopic),
    })),
  };
}

// ---------- 讲义详情（GET /api/student/lectures/:id?courseId=） ----------

/**
 * 讲义详情 + 课程上下文 + 本课配套练习（D8）。
 * - courseId 指定时：课程不存在 → 404 NOT_FOUND；非成员/学生已归档/课程已归档 →
 *   403 COURSE_ACCESS_DENIED；该讲义在该课程不可见（隐藏/未到发布/已删除/不在
 *   目录中）→ 404 NOT_FOUND（D22）；
 * - courseId 缺省时：取第一个（course.order → 条目 order）该生可见该讲义的课程；
 *   任何课程都看不到 → 404 NOT_FOUND（不暴露存在性）；
 * - companionUnits：同课程内 units.lectureId = 该讲义且对该生可见的单元条目
 *   （目录条目顺序），带未删除题数——「即将开放」语义，作答入口 T2A.6 开放。
 * 只 SELECT lectures 的 markdown 元信息列；不触碰 questions 内容列。
 */
export function getStudentLecture(
  db: Db,
  studentId: string,
  lectureId: string,
  courseId?: string | undefined,
  now: Date | string = new Date(),
): StudentLectureDetail {
  const visibleCourses = visibleCoursesOfStudent(db, studentId);

  /** 课程上下文 + 该课程的可见目录（一次选出） */
  let found:
    | { course: VisibleCourse; items: ReturnType<typeof listVisibleItems> }
    | undefined;

  if (courseId !== undefined) {
    const course = visibleCourses.find((entry) => entry.id === courseId);
    if (course === undefined) {
      // 课程存在性三分：不存在 → 404；存在但非成员/学生已归档/课程已归档 → 403（D22）
      const exists =
        db
          .select({ id: courses.id })
          .from(courses)
          .where(eq(courses.id, courseId))
          .get() !== undefined;
      throw exists ? courseAccessDenied() : notFound();
    }
    found = { course, items: listVisibleItems(db, studentId, courseId, now) };
  } else {
    // 缺省：第一个（已按 order 排序）可见该讲义的课程
    for (const course of visibleCourses) {
      const items = listVisibleItems(db, studentId, course.id, now);
      if (
        items.some(
          (item) => item.kind === "lecture" && item.refId === lectureId,
        )
      ) {
        found = { course, items };
        break;
      }
    }
  }
  if (found === undefined) {
    throw notFound();
  }
  const { course: context, items: contextItems } = found;

  // 讲义在该课程目录中可见（D5 已滤隐藏/未到发布/软删/资源缺失）
  const lectureItem = contextItems.find(
    (item) => item.kind === "lecture" && item.refId === lectureId,
  );
  if (lectureItem === undefined) {
    throw notFound();
  }
  const row = db
    .select({
      id: lectures.id,
      title: lectures.title,
      markdown: lectures.markdown,
      updatedAt: lectures.updatedAt,
    })
    .from(lectures)
    .where(and(eq(lectures.id, lectureId), isNull(lectures.deletedAt)))
    .get();
  if (row === undefined) {
    throw notFound(); // 防御：可见条目不应指向缺失/已删讲义（D5 条件 4 已滤）
  }

  // 本课配套练习（D8）：同课程可见单元条目中 units.lectureId 指向该讲义者
  //（域内读：context.teacherId 为课程根行的教师域，T2B.5 D10）
  const visibleUnitItems = contextItems.filter(
    (item) => item.kind === "unit" && item.refId !== null,
  );
  const companionUnitIds: string[] = [];
  if (visibleUnitItems.length > 0) {
    const rows = db
      .select({ id: units.id, lectureId: units.lectureId })
      .from(units)
      .where(
        and(
          eq(units.teacherId, context.teacherId),
          inArray(
            units.id,
            visibleUnitItems.map((item) => item.refId as string),
          ),
          eq(units.lectureId, lectureId),
          isNull(units.deletedAt),
        ),
      )
      .all();
    const companionIds = new Set(rows.map((unit) => unit.id));
    for (const item of visibleUnitItems) {
      // 按目录条目顺序输出配套单元
      if (companionIds.has(item.refId as string)) {
        companionUnitIds.push(item.refId as string);
      }
    }
  }
  const counts = liveQuestionCounts(db, context.teacherId, companionUnitIds);
  const titles = new Map(
    db
      .select({ id: units.id, title: units.title })
      .from(units)
      .where(
        and(
          eq(units.teacherId, context.teacherId),
          inArray(units.id, companionUnitIds),
        ),
      )
      .all()
      .map((unit) => [unit.id, unit.title] as const),
  );

  return {
    id: row.id,
    title: row.title,
    markdown: row.markdown,
    updatedAt: row.updatedAt,
    courseId: context.id,
    courseName: context.title,
    companionUnits: companionUnitIds.map((id) => ({
      id,
      title: titles.get(id) ?? "",
      questionCount: counts.get(id) ?? 0,
    })),
  };
}
