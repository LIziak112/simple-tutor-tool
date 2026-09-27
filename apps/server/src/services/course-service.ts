import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type CourseItem,
  type CourseItemKind,
  courseItems,
  courseStudents,
  courses,
  lectures,
  questions,
  students,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { canStudentSeeItem } from "./visibility.ts";

/**
 * CourseService（T2A.1）——课程目录条目与课程成员的服务层（课程本体的
 * 创建/改名/删除仍在 content-service，兼容现有接口）。HTTP 接口属 T2A.4。
 *
 * - 目录条目（D6）：section/lecture/unit；同一资源在同一课程唯一
 *   （库级唯一约束 + 服务层 409 DUPLICATE_COURSE_ITEM）；新添加默认 visible=true；
 * - 排序：ids 为该课程全部条目的完整新顺序，order 按下标重写；
 * - 成员（D7）：只由教师添加/移出；移出即删行（作答数据不动）；
 * - listVisibleItems：按 D5（canStudentSeeItem 唯一判定）过滤出某学生此刻
 *   在某课程可见的目录条目（学生可见预览 / T2A.5 学生端接口共用）。
 */

/** 新增目录条目的输入（kind 决定 refId/title 的必填性，见 addCourseItems 校验） */
export interface CourseItemInput {
  readonly kind: CourseItemKind;
  /** lecture/unit 必填（资源 id）；section 必须为空 */
  readonly refId?: string | null;
  /** section 必填（分节标题）；lecture/unit 必须为空（标题取资源当前值） */
  readonly title?: string | null;
}

/** 学生可见的目录条目（listVisibleItems 返回形状） */
export interface VisibleCourseItem {
  readonly id: string;
  readonly kind: CourseItemKind;
  readonly refId: string | null;
  /** section = 分节标题；lecture/unit = 资源当前标题 */
  readonly title: string;
  readonly order: number;
}

/** 课程不存在 → 404（与 content-service 同码） */
function requireCourse(db: Db, id: string): void {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
}

/** 校验条目输入的 kind 相关必填性（422 VALIDATION_ERROR） */
function validateItemInput(item: CourseItemInput): void {
  if (item.kind === "section") {
    if (item.refId !== undefined && item.refId !== null) {
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "分节标题不引用资源，不能携带 refId",
      );
    }
    if (
      item.title === undefined ||
      item.title === null ||
      item.title.trim().length === 0
    ) {
      throw new HttpError(422, "VALIDATION_ERROR", "分节标题不能为空");
    }
    return;
  }
  if (
    item.refId === undefined ||
    item.refId === null ||
    item.refId.length === 0
  ) {
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      item.kind === "lecture"
        ? "讲义条目必须携带 refId"
        : "单元条目必须携带 refId",
    );
  }
  if (item.title !== undefined && item.title !== null) {
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "讲义/单元条目的标题取资源当前值，不能携带 title",
    );
  }
}

/**
 * 追加目录条目到课程末尾（D6）。默认 visible=true（添加对话框「添加后对学生可见」
 * 开关默认开，T2A.4 UI）。同一资源在本课程已存在（或同批内重复）→ 409
 * DUPLICATE_COURSE_ITEM；引用的资源不存在或已软删 → 404（资源侧错误码）。
 */
export function addCourseItems(
  db: Db,
  courseId: string,
  items: readonly CourseItemInput[],
  options: { visible?: boolean } = {},
): CourseItem[] {
  requireCourse(db, courseId);
  for (const item of items) validateItemInput(item);

  // 同批内重复先拦（避免只靠库级约束报生硬错误）
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind === "section") continue; // 分节可多条（清单 §3：同名限制走应用层，不强制）
    const key = `${item.kind}:${item.refId}`;
    if (seen.has(key)) {
      throw new HttpError(
        409,
        "DUPLICATE_COURSE_ITEM",
        "同一资源在同一次添加中出现了多次",
      );
    }
    seen.add(key);
  }

  // 库内已存在的同类条目 → 409
  const refIds = items
    .filter((item) => item.kind !== "section")
    .map((item) => item.refId as string);
  if (refIds.length > 0) {
    const existing = db
      .select({ kind: courseItems.kind, refId: courseItems.refId })
      .from(courseItems)
      .where(
        and(
          eq(courseItems.courseId, courseId),
          inArray(courseItems.refId, refIds),
        ),
      )
      .all();
    for (const row of existing) {
      if (seen.has(`${row.kind}:${row.refId}`)) {
        throw new HttpError(
          409,
          "DUPLICATE_COURSE_ITEM",
          "该资源已在本课程目录中，不能重复添加",
        );
      }
    }
  }

  // 资源存在性 + 未软删校验（已删除的资源不能加入课程，D3）
  for (const item of items) {
    if (item.kind === "lecture") {
      const row = db
        .select({ id: lectures.id, deletedAt: lectures.deletedAt })
        .from(lectures)
        .where(eq(lectures.id, item.refId as string))
        .get();
      if (row === undefined) {
        throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
      }
      if (row.deletedAt !== null) {
        throw new HttpError(
          404,
          "LECTURE_NOT_FOUND",
          "讲义不存在（可能已被删除）",
        );
      }
    } else if (item.kind === "unit") {
      const row = db
        .select({ id: units.id, deletedAt: units.deletedAt })
        .from(units)
        .where(eq(units.id, item.refId as string))
        .get();
      if (row === undefined) {
        throw new HttpError(404, "UNIT_NOT_FOUND", "练习单元不存在");
      }
      if (row.deletedAt !== null) {
        throw new HttpError(
          404,
          "UNIT_NOT_FOUND",
          "练习单元不存在（可能已被删除）",
        );
      }
    }
  }

  const visible = options.visible ?? true; // D6：新添加默认可见
  const now = new Date().toISOString();
  let nextOrder =
    db
      .select({ order: courseItems.order })
      .from(courseItems)
      .where(eq(courseItems.courseId, courseId))
      .all()
      .reduce((max, row) => Math.max(max, row.order), -1) + 1;

  const inserted: CourseItem[] = [];
  db.transaction((tx) => {
    for (const item of items) {
      const row: CourseItem = {
        id: crypto.randomUUID(),
        courseId,
        kind: item.kind,
        refId: item.kind === "section" ? null : (item.refId as string),
        title: item.kind === "section" ? (item.title as string).trim() : null,
        order: nextOrder,
        visible,
        publishAt: null,
        createdAt: now,
      };
      nextOrder += 1;
      tx.insert(courseItems).values(row).run();
      inserted.push(row);
    }
  });
  return inserted;
}

/** 目录条目更新：visible / publishAt（显式 null = 取消定时）/ title（仅 section）。 */
export function updateCourseItem(
  db: Db,
  id: string,
  input: { visible?: boolean; publishAt?: string | null; title?: string },
): CourseItem {
  const row = db.select().from(courseItems).where(eq(courseItems.id, id)).get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_ITEM_NOT_FOUND", "目录条目不存在");
  }
  const patch: Partial<typeof courseItems.$inferInsert> = {};
  if (input.visible !== undefined) patch.visible = input.visible;
  if (input.publishAt !== undefined) patch.publishAt = input.publishAt;
  if (input.title !== undefined) {
    if (row.kind !== "section") {
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "只有分节标题可以修改标题（讲义/单元标题取资源当前值）",
      );
    }
    const title = input.title.trim();
    if (title.length === 0) {
      throw new HttpError(422, "VALIDATION_ERROR", "分节标题不能为空");
    }
    patch.title = title;
  }
  if (Object.keys(patch).length > 0) {
    db.update(courseItems).set(patch).where(eq(courseItems.id, id)).run();
  }
  return { ...row, ...patch } as CourseItem;
}

/** 从课程目录移除条目（不触碰资源库本体）。不存在 → 404 */
export function deleteCourseItem(db: Db, id: string): void {
  const row = db
    .select({ id: courseItems.id })
    .from(courseItems)
    .where(eq(courseItems.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_ITEM_NOT_FOUND", "目录条目不存在");
  }
  db.delete(courseItems).where(eq(courseItems.id, id)).run();
}

/**
 * 课程目录排序：ids 必须恰好为该课程全部条目的完整新顺序（order 按下标 0 起重写）。
 * 缺失或包含他课程条目 → 404 COURSE_ITEM_NOT_FOUND，事务回滚保持原顺序。
 */
export function reorderCourseItems(
  db: Db,
  courseId: string,
  ids: readonly string[],
): void {
  requireCourse(db, courseId);
  const rows = db
    .select({ id: courseItems.id })
    .from(courseItems)
    .where(eq(courseItems.courseId, courseId))
    .all();
  const liveIds = new Set(rows.map((row) => row.id));
  const missing = ids.find((id) => !liveIds.has(id));
  if (missing !== undefined || ids.length !== liveIds.size) {
    throw new HttpError(
      404,
      "COURSE_ITEM_NOT_FOUND",
      "排序失败：ids 必须是该课程目录条目的完整列表",
    );
  }
  db.transaction((tx) => {
    for (const [index, id] of ids.entries()) {
      tx.update(courseItems)
        .set({ order: index })
        .where(eq(courseItems.id, id))
        .run();
    }
  });
}

// ---------- 课程成员（D7） ----------

/** 添加成员：学生不存在 → 404 STUDENT_NOT_FOUND；已在课幂等跳过 */
export function addCourseMembers(
  db: Db,
  courseId: string,
  studentIds: readonly string[],
): void {
  requireCourse(db, courseId);
  const ids = [...new Set(studentIds)];
  if (ids.length > 0) {
    const found = db
      .select({ id: students.id })
      .from(students)
      .where(inArray(students.id, ids))
      .all();
    const foundIds = new Set(found.map((row) => row.id));
    const missing = ids.find((id) => !foundIds.has(id));
    if (missing !== undefined) {
      throw new HttpError(404, "STUDENT_NOT_FOUND", "学生不存在");
    }
  }
  const now = new Date().toISOString();
  db.transaction((tx) => {
    for (const studentId of ids) {
      tx.insert(courseStudents)
        .values({ courseId, studentId, joinedAt: now })
        .onConflictDoNothing()
        .run();
    }
  });
}

/** 移出成员：删 course_students 行（作答数据保留，D7）。不在课的学生幂等无操作 */
export function removeCourseMembers(
  db: Db,
  courseId: string,
  studentIds: readonly string[],
): void {
  requireCourse(db, courseId);
  const ids = [...new Set(studentIds)];
  if (ids.length === 0) return;
  db.transaction((tx) => {
    for (const studentId of ids) {
      tx.delete(courseStudents)
        .where(
          and(
            eq(courseStudents.courseId, courseId),
            eq(courseStudents.studentId, studentId),
          ),
        )
        .run();
    }
  });
}

/** 成员名单（学生姓名排序稳定输出） */
export function listCourseMembers(
  db: Db,
  courseId: string,
): { studentId: string; displayName: string; joinedAt: string }[] {
  requireCourse(db, courseId);
  return db
    .select({
      studentId: students.id,
      displayName: students.displayName,
      joinedAt: courseStudents.joinedAt,
    })
    .from(courseStudents)
    .innerJoin(students, eq(courseStudents.studentId, students.id))
    .where(eq(courseStudents.courseId, courseId))
    .orderBy(asc(students.displayName))
    .all();
}

/** 某学生是否为某课程成员 */
export function isCourseMember(
  db: Db,
  courseId: string,
  studentId: string,
): boolean {
  return (
    db
      .select({ studentId: courseStudents.studentId })
      .from(courseStudents)
      .where(
        and(
          eq(courseStudents.courseId, courseId),
          eq(courseStudents.studentId, studentId),
        ),
      )
      .get() !== undefined
  );
}

// ---------- 学生可见目录（D5；学生可见预览与 T2A.5 学生接口共用） ----------

/**
 * 某学生此刻在某课程可见的目录条目（按 order 升序）。
 * 非成员 / 学生归档 / 课程不存在或已归档 → 空数组（D5 条件 1、2；
 * 接口层 403/404 的区分属 T2A.4/T2A.5）。now 可注入（publishAt 到点判断）。
 */
export function listVisibleItems(
  db: Db,
  studentId: string,
  courseId: string,
  now: Date | string = new Date(),
): VisibleCourseItem[] {
  const student = db
    .select({ id: students.id, archivedAt: students.archivedAt })
    .from(students)
    .where(eq(students.id, studentId))
    .get();
  if (student === undefined || student.archivedAt !== null) return [];

  const course = db
    .select({ id: courses.id, archivedAt: courses.archivedAt })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (course === undefined || course.archivedAt !== null) return [];

  const isMember = isCourseMember(db, courseId, studentId);
  const studentArchived = false; // 上方已拦截归档学生

  // 资源侧数据一次读全（教师端量级：一对一辅导，内存分组足够）
  const lectureRows = db
    .select({
      id: lectures.id,
      title: lectures.title,
      deletedAt: lectures.deletedAt,
    })
    .from(lectures)
    .all();
  const lectureById = new Map(lectureRows.map((row) => [row.id, row]));
  const unitRows = db
    .select({ id: units.id, title: units.title, deletedAt: units.deletedAt })
    .from(units)
    .all();
  const unitById = new Map(unitRows.map((row) => [row.id, row]));
  const liveQuestionCountByUnit = new Map<string, number>();
  for (const row of db
    .select({ unitId: questions.unitId })
    .from(questions)
    .where(isNull(questions.deletedAt))
    .all()) {
    liveQuestionCountByUnit.set(
      row.unitId,
      (liveQuestionCountByUnit.get(row.unitId) ?? 0) + 1,
    );
  }

  const items = db
    .select()
    .from(courseItems)
    .where(eq(courseItems.courseId, courseId))
    .orderBy(asc(courseItems.order), asc(courseItems.id))
    .all();

  const visibleItems: VisibleCourseItem[] = [];
  for (const item of items) {
    let title: string;
    let resourceDeleted: boolean;
    let unitLiveQuestionCount: number | null;
    if (item.kind === "section") {
      title = item.title ?? "";
      resourceDeleted = false;
      unitLiveQuestionCount = null;
    } else if (item.kind === "lecture") {
      const lecture = lectureById.get(item.refId ?? "");
      if (lecture === undefined) continue; // 资源行缺失（不应发生）：跳过
      title = lecture.title;
      resourceDeleted = lecture.deletedAt !== null;
      unitLiveQuestionCount = null;
    } else {
      const unit = unitById.get(item.refId ?? "");
      if (unit === undefined) continue;
      title = unit.title;
      resourceDeleted = unit.deletedAt !== null;
      unitLiveQuestionCount = liveQuestionCountByUnit.get(unit.id) ?? 0;
    }
    const visible = canStudentSeeItem(
      {
        studentArchived,
        isMember,
        courseArchived: false, // 上方已拦截归档课程
        itemVisible: item.visible,
        publishAt: item.publishAt,
        resourceDeleted,
        unitLiveQuestionCount,
      },
      now,
    );
    if (visible) {
      visibleItems.push({
        id: item.id,
        kind: item.kind,
        refId: item.refId,
        title,
        order: item.order,
      });
    }
  }
  return visibleItems;
}
