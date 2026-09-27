import type {
  StudentCourseDetailData,
  StudentCourseSummary,
  StudentLectureCourseGroup,
  StudentLectureDetail,
  StudentLectureListData,
  StudentLectureSummary,
} from "@tutor/contract";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  courseStudents,
  courses,
  lectures,
  questions,
  students,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { listVisibleItems } from "./course-service";

/**
 * 学生端课程与讲义读路径（T2A.5，核心切换：可见性模型从「全量讲义 + deletedAt 过滤」
 * 窗口期实现切换到 D5）。四个入口全部复用 listVisibleItems → canStudentSeeItem
 * 唯一判定（清单 §2 D5），隐藏/未到发布/资源已删除条目零信息（不出现在条目列表，
 * 也不计入任何计数）：
 * - listStudentCourses：我的课程（成员 + 课程未归档），可见讲义/单元计数 +
 *   completedUnitCount 占位 0（T2A.6 接入课程练习作答后填充）；
 * - getStudentCourseDetail：课程可见目录（单元条目带题数）；
 * - listStudentLectures：可见讲义 = 所在全部课程中可见讲义条目的并集（双视图：
 *   去重 lectures + 按课程分组 courses；同一讲义多课在分组中各自出现、去重列表
 *   只出现一次）；topic 只由**对该生可见**的配套单元贡献（隐藏单元零信息）；
 * - getStudentLecture：讲义详情 + 课程上下文（?courseId= 或取第一个可见该讲义的
 *   课程）+「本课配套练习」（D8：同课程可见的 units.lectureId=该讲义单元）。
 *
 * 错误口径（D22）：非成员/学生已归档/课程已归档 → 403 COURSE_ACCESS_DENIED；
 * 课程或讲义不存在/条目隐藏/未到发布/资源已删除 → 404 NOT_FOUND（不暴露存在性）。
 * now 可注入（publishAt 到点判断；路由传真实时间，测试传固定时间）。
 *
 * 安全口径（AGENTS.md 第 3 条）：全部查询只 SELECT 目录与资源元信息列，
 * 不触碰 questions 的任何内容列（题数只做 COUNT(*)）。
 */

/** 学生可见的课程上下文（D5 条件 1、2：成员 + 双方未归档） */
interface VisibleCourse {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly order: number;
}

/**
 * 该生为成员且未归档的课程（按 course.order 升序）。
 * 学生已归档 → 空数组（requireStudent 守卫已拦 401，此处防御性兜底）。
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
    })
    .from(courseStudents)
    .innerJoin(courses, eq(courseStudents.courseId, courses.id))
    .where(
      and(
        eq(courseStudents.studentId, studentId),
        isNull(courses.archivedAt),
      ),
    )
    .orderBy(asc(courses.order), asc(courses.title))
    .all();
}

/** 若干单元的未删除题目数（D5 条件 4 与「n 题」展示共用；只 COUNT，不读内容列） */
function liveQuestionCounts(
  db: Db,
  unitIds: readonly string[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (unitIds.length === 0) return map;
  for (const row of db
    .select({ unitId: questions.unitId })
    .from(questions)
    .where(and(inArray(questions.unitId, [...unitIds]), isNull(questions.deletedAt)))
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

/** 404 NOT_FOUND（D22：不暴露存在性——课程/讲义不存在、条目隐藏等统一口径） */
function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "没有找到该内容（可能尚未发布或已被移除）");
}

// ---------- 我的课程（GET /api/student/courses） ----------

/**
 * 我的课程列表（成员 + 未归档课程，order 升序）。
 * 可见计数取自 listVisibleItems（隐藏条目不计入）；completedUnitCount 恒 0
 * （T2A.6 前占位）。归档课程与非成员课程完全不出现在列表（零信息）。
 */
export function listStudentCourses(
  db: Db,
  studentId: string,
  now: Date | string = new Date(),
): { courses: StudentCourseSummary[] } {
  const visibleCourses = visibleCoursesOfStudent(db, studentId);
  const courseSummaries: StudentCourseSummary[] = visibleCourses.map((course) => {
    const items = listVisibleItems(db, studentId, course.id, now);
    return {
      id: course.id,
      name: course.title,
      description: course.description,
      visibleLectureCount: items.filter((item) => item.kind === "lecture").length,
      visibleUnitCount: items.filter((item) => item.kind === "unit").length,
      completedUnitCount: 0, // T2A.6：接入课程练习作答后按「至少交卷 1 次的可见单元数」填充
    };
  });
  return { courses: courseSummaries };
}

// ---------- 课程可见目录（GET /api/student/courses/:id） ----------

/**
 * 某课程的可见目录（D5 过滤，order 升序；单元条目带未删除题数）。
 * 课程不存在 → 404 NOT_FOUND；非成员/学生已归档/课程已归档 → 403
 * COURSE_ACCESS_DENIED（D22）。隐藏条目零信息。
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

  const items = listVisibleItems(db, studentId, courseId, now);
  const unitIds = items
    .filter((item) => item.kind === "unit")
    .map((item) => item.refId as string);
  const counts = liveQuestionCounts(db, unitIds);
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
    })),
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
 */
function visibleCompanionTopics(
  db: Db,
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
        inArray(units.id, visibleUnits.map((unit) => unit.refId)),
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
  const topics = visibleCompanionTopics(
    db,
    visibleUnitItemsOfStudent(db, visibleCourses, studentId, now),
  );
  const withTopic = (summary: StudentLectureSummary): StudentLectureSummary => ({
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
        items.some((item) => item.kind === "lecture" && item.refId === lectureId)
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
  const counts = liveQuestionCounts(db, companionUnitIds);
  const titles = new Map(
    db
      .select({ id: units.id, title: units.title })
      .from(units)
      .where(inArray(units.id, companionUnitIds))
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
