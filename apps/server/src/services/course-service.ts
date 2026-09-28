import type {
  CourseDetailData,
  CourseDetailItem,
  CourseItemAdded,
  CourseItemSkipped,
  CourseProgressCell,
  CourseProgressData,
  CourseProgressUnit,
  CourseStudentViewData,
  CourseSummary,
} from "@tutor/contract";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  assignments,
  attempts,
  type CourseItem,
  type CourseItemKind,
  courseItems,
  courseStudents,
  courses,
  lectures,
  questions,
  responses,
  students,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { canStudentSeeItem } from "./visibility.ts";

/**
 * CourseService（T2A.1 建条目/成员服务层；T2A.4 扩展教师端课程接口的数据组装）：
 * - 目录条目（D6）：section/lecture/unit；同一资源在同一课程唯一
 *   （库级唯一约束 + addCourseItems 409 DUPLICATE_COURSE_ITEM）；新添加默认 visible=true；
 * - appendCourseItems（T2A.4 批量口径）：重复条目**跳过并返回清单**（与单条 409 不同），
 *   支持 withCompanionUnits（D8 配套练习一并添加，紧跟对应讲义之后）；
 * - 排序：ids 为该课程全部条目的完整新顺序，order 按下标重写；
 * - 成员（D7）：只由教师添加/移出；移出即删行（作答数据不动）；
 * - 列表/详情（T2A.4）：成员数、条目数、可见条目数（口径见 courseSummarySchema 注释）、
 *   状态标签（§4-4）与 hasAttempts（D4 删除条件）；
 * - 学生可见目录（D5，canStudentSeeItem 唯一判定）：listVisibleItems 供学生可见预览
 *   （getStudentView）与 T2A.5 学生端接口共用。
 */

/** 新增目录条目的输入（kind 决定 refId/title 的必填性，见 addCourseItems 校验） */
export interface CourseItemInput {
  readonly kind: CourseItemKind;
  /** lecture/unit 必填（资源 id）；section 必须为空 */
  readonly refId?: string | null | undefined;
  /** section 必填（分节标题）；lecture/unit 必须为空（标题取资源当前值） */
  readonly title?: string | null | undefined;
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

/**
 * 批量追加目录条目（T2A.4，POST /api/teacher/courses/:id/items）。
 * 与 addCourseItems（409 口径）不同：**重复条目跳过并记入 skipped 清单**，不报错（D6）。
 * - 同一资源已在本课程 → skipped（reason「已在本课程」）；同批内重复 → 后者 skipped
 *   （reason「同一次添加中重复」）；分节可多条，不判重；
 * - withCompanionUnits（D8）：为每个**本批新添**的讲义追加以其为配套讲义
 *   （units.lectureId）且未软删的单元，位置紧跟该讲义之后；配套单元同样逐条判重
 *   （已在课程/本批已含 → skipped）。已被跳过的讲义不再展开配套（其配套或早已入课，
 *   或由教师在题库页签显式添加）；
 * - 资源不存在或已软删仍抛 404（fail fast，全批不落库）；kind 相关校验同 addCourseItems；
 * - visible 对整批（含配套单元）统一生效（D6「添加后对学生可见」开关，缺省 true）。
 */
export function appendCourseItems(
  db: Db,
  courseId: string,
  items: readonly CourseItemInput[],
  options: {
    visible?: boolean | undefined;
    withCompanionUnits?: boolean | undefined;
  } = {},
): { added: CourseItemAdded[]; skipped: CourseItemSkipped[] } {
  requireCourse(db, courseId);
  for (const item of items) validateItemInput(item);

  const skipped: CourseItemSkipped[] = [];
  /** 本批计划落库的条目（companion 标记用于响应区分展示） */
  const planned: (CourseItemInput & { companion: boolean })[] = [];
  /** 本批已占用的资源键（kind:refId），批内判重用 */
  const plannedKeys = new Set<string>();

  /** 记一条跳过（title 尽力补全：讲义/单元由调用点从资源映射取） */
  function skip(item: CourseItemInput, reason: string, title: string | null) {
    skipped.push({
      kind: item.kind,
      refId: item.refId ?? null,
      title,
      reason,
    });
  }

  // 已在本课程的资源键
  const existingKeys = new Set(
    db
      .select({ kind: courseItems.kind, refId: courseItems.refId })
      .from(courseItems)
      .where(eq(courseItems.courseId, courseId))
      .all()
      .map((row) => `${row.kind}:${row.refId}`),
  );

  // 批内输入判重与展开
  for (const item of items) {
    if (item.kind === "section") {
      // 分节多条合法（D6：SQLite 唯一约束不判 NULL；同名限制不做强制）
      planned.push({ ...item, companion: false });
      continue;
    }
    const key = `${item.kind}:${item.refId}`;
    if (existingKeys.has(key)) {
      skip(item, "已在本课程", null); // title 稍后统一补全
      continue;
    }
    if (plannedKeys.has(key)) {
      skip(item, "同一次添加中重复", null);
      continue;
    }
    plannedKeys.add(key);
    planned.push({ ...item, companion: false });
  }

  // D8 配套练习：本批新添讲义的配套单元，紧跟该讲义之后插入
  if (options.withCompanionUnits === true) {
    const addedLectureIds = planned
      .filter((item) => item.kind === "lecture")
      .map((item) => item.refId as string);
    if (addedLectureIds.length > 0) {
      const companionUnits = db
        .select({ id: units.id, lectureId: units.lectureId })
        .from(units)
        .where(
          and(
            inArray(units.lectureId, addedLectureIds),
            isNull(units.deletedAt),
          ),
        )
        .orderBy(asc(units.order), asc(units.title))
        .all();
      const companionsByLecture = new Map<string, string[]>();
      for (const row of companionUnits) {
        if (row.lectureId === null) continue;
        const list = companionsByLecture.get(row.lectureId);
        if (list === undefined) {
          companionsByLecture.set(row.lectureId, [row.id]);
        } else {
          list.push(row.id);
        }
      }
      const expanded: (CourseItemInput & { companion: boolean })[] = [];
      for (const item of planned) {
        expanded.push(item);
        if (item.kind !== "lecture") continue;
        for (const unitId of companionsByLecture.get(item.refId as string) ??
          []) {
          const key = `unit:${unitId}`;
          if (existingKeys.has(key) || plannedKeys.has(key)) {
            skip({ kind: "unit", refId: unitId }, "已在本课程", null);
            continue;
          }
          plannedKeys.add(key);
          expanded.push({ kind: "unit", refId: unitId, companion: true });
        }
      }
      planned.length = 0;
      planned.push(...expanded);
    }
  }

  // 资源存在性 + 未软删校验（404；分节无资源可查）
  for (const item of planned) {
    if (item.kind === "lecture") {
      const row = db
        .select({ id: lectures.id, deletedAt: lectures.deletedAt })
        .from(lectures)
        .where(eq(lectures.id, item.refId as string))
        .get();
      if (row === undefined || row.deletedAt !== null) {
        throw new HttpError(
          404,
          "LECTURE_NOT_FOUND",
          row === undefined ? "讲义不存在" : "讲义不存在（可能已被删除）",
        );
      }
    } else if (item.kind === "unit") {
      const row = db
        .select({ id: units.id, deletedAt: units.deletedAt })
        .from(units)
        .where(eq(units.id, item.refId as string))
        .get();
      if (row === undefined || row.deletedAt !== null) {
        throw new HttpError(
          404,
          "UNIT_NOT_FOUND",
          row === undefined
            ? "练习单元不存在"
            : "练习单元不存在（可能已被删除）",
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

  // 显示标题：lecture/unit 取资源当前标题（引用而非复制，D1）
  const lectureTitles = new Map(
    db
      .select({ id: lectures.id, title: lectures.title })
      .from(lectures)
      .all()
      .map((row) => [row.id, row.title] as const),
  );
  const unitTitles = new Map(
    db
      .select({ id: units.id, title: units.title })
      .from(units)
      .all()
      .map((row) => [row.id, row.title] as const),
  );

  const added: CourseItemAdded[] = [];
  db.transaction((tx) => {
    for (const item of planned) {
      const id = crypto.randomUUID();
      const title =
        item.kind === "section"
          ? (item.title as string).trim()
          : item.kind === "lecture"
            ? (lectureTitles.get(item.refId as string) ?? "")
            : (unitTitles.get(item.refId as string) ?? "");
      tx.insert(courseItems)
        .values({
          id,
          courseId,
          kind: item.kind,
          refId: item.kind === "section" ? null : (item.refId as string),
          title: item.kind === "section" ? (item.title as string).trim() : null,
          order: nextOrder,
          visible,
          publishAt: null,
          createdAt: now,
        })
        .run();
      added.push({
        id,
        kind: item.kind,
        refId: item.kind === "section" ? null : (item.refId as string),
        title,
        order: nextOrder,
        visible,
        companion: item.companion,
      });
      nextOrder += 1;
    }
  });

  // 跳过清单补全显示标题（尽力：资源可能仍在库）
  for (const entry of skipped) {
    if (entry.title !== null) continue;
    entry.title =
      entry.kind === "lecture"
        ? (lectureTitles.get(entry.refId ?? "") ?? null)
        : entry.kind === "unit"
          ? (unitTitles.get(entry.refId ?? "") ?? null)
          : null;
  }

  return { added, skipped };
}

/** 目录条目更新：visible / publishAt（显式 null = 取消定时）/ title（仅 section）。 */
export function updateCourseItem(
  db: Db,
  id: string,
  input: {
    visible?: boolean | undefined;
    publishAt?: string | null | undefined;
    title?: string | undefined;
  },
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
  const { lectureById, unitById, liveQuestionCountByUnit } =
    loadResourceContext(db);

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
      unitLiveQuestionCount =
        liveQuestionCountByUnit.get(item.refId ?? "") ?? 0;
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

// ---------- 单元可见性门（T2A.6：课程练习入口与作答访问权共用） ----------

/** 403 COURSE_ACCESS_DENIED（D22：非成员 / 学生已归档 / 课程已归档） */
function courseAccessDenied(): HttpError {
  return new HttpError(
    403,
    "COURSE_ACCESS_DENIED",
    "无法访问该课程（可能已被移出，或课程已结束归档）",
  );
}

/** 404 NOT_FOUND（D22：不暴露存在性——课程/单元不存在、条目隐藏等统一口径） */
function courseItemNotFound(): HttpError {
  return new HttpError(
    404,
    "NOT_FOUND",
    "没有找到该内容（可能尚未发布或已被移除）",
  );
}

/**
 * 校验某学生此刻能在某课程看到某单元（D5 + D22），失败抛 403/404：
 * - 课程不存在 → 404 NOT_FOUND；
 * - 非成员 / 学生已归档 / 课程已归档 → 403 COURSE_ACCESS_DENIED；
 * - 单元条目不在该课程目录、隐藏、未到 publishAt、单元软删或无未删题 →
 *   404 NOT_FOUND（不暴露存在性）。
 *
 * T2A.6 的三类调用方：课程单元落地页/开始练习（student.ts）、课程来源 attempt
 * 的取卷与草稿访问权（attempt-service，D7——移出成员后未交卷草稿 403）。
 * 返回可见条目（含标题）供调用方组装响应。
 */
export function requireVisibleCourseUnit(
  db: Db,
  studentId: string,
  courseId: string,
  unitId: string,
  now: Date | string = new Date(),
): VisibleCourseItem {
  const course = db
    .select({ id: courses.id, archivedAt: courses.archivedAt })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (course === undefined) {
    throw courseItemNotFound();
  }
  const student = db
    .select({ id: students.id, archivedAt: students.archivedAt })
    .from(students)
    .where(eq(students.id, studentId))
    .get();
  if (
    student === undefined ||
    student.archivedAt !== null ||
    !isCourseMember(db, courseId, studentId) ||
    course.archivedAt !== null
  ) {
    throw courseAccessDenied();
  }
  const item = listVisibleItems(db, studentId, courseId, now).find(
    (entry) => entry.kind === "unit" && entry.refId === unitId,
  );
  if (item === undefined) {
    throw courseItemNotFound();
  }
  return item;
}

// ---------- T2A.4：教师端课程列表 / 详情 / 学生可见预览 ----------

/** 资源侧上下文（可见目录/详情共用：一次读全，内存分组——教师端量级小） */
interface ResourceContext {
  readonly lectureById: Map<
    string,
    { title: string; deletedAt: string | null; updatedAt: string }
  >;
  readonly unitById: Map<
    string,
    { title: string; deletedAt: string | null; updatedAt: string }
  >;
  readonly liveQuestionCountByUnit: Map<string, number>;
}

/** 读全讲义/单元摘要与未删除题目计数（D5 条件 4 与状态标签共用） */
function loadResourceContext(db: Db): ResourceContext {
  const lectureById = new Map(
    db
      .select({
        id: lectures.id,
        title: lectures.title,
        deletedAt: lectures.deletedAt,
        updatedAt: lectures.updatedAt,
      })
      .from(lectures)
      .all()
      .map((row) => [row.id, row] as const),
  );
  const unitById = new Map(
    db
      .select({
        id: units.id,
        title: units.title,
        deletedAt: units.deletedAt,
        updatedAt: units.updatedAt,
      })
      .from(units)
      .all()
      .map((row) => [row.id, row] as const),
  );
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
  return { lectureById, unitById, liveQuestionCountByUnit };
}

/**
 * D4 删除条件：课程是否关联作答/作业记录（T2A.7 口径，直接按 courseId 判）：
 * - ∃ attempts.courseId = 该课程（课程练习作答，含未交卷草稿）；
 * - ∃ assignments.courseId = 该课程（按课程布置的作业——多单元作业 attempt 的
 *   unitId 为 null，原「按单元交集」口径会漏判；assignments 命中也挡删除，
 *   保护 assignments.courseId 外键）。
 * 任一命中即拒删（提示改用归档）。
 */
export function courseHasAttempts(db: Db, courseId: string): boolean {
  const attemptHit =
    db
      .select({ id: attempts.id })
      .from(attempts)
      .where(eq(attempts.courseId, courseId))
      .get() !== undefined;
  if (attemptHit) return true;
  return (
    db
      .select({ id: assignments.id })
      .from(assignments)
      .where(eq(assignments.courseId, courseId))
      .get() !== undefined
  );
}

/** 有课程练习作答记录的课程 id 集合（attempts.courseId；D4 列表口径之一） */
function attemptedCourseIds(db: Db): Set<string> {
  return new Set(
    db
      .select({ courseId: attempts.courseId })
      .from(attempts)
      .where(isNotNull(attempts.courseId))
      .all()
      .map((row) => row.courseId as string),
  );
}

/** 关联了作业的课程 id 集合（assignments.courseId；D4 列表口径之二，T2A.7） */
function assignedCourseIds(db: Db): Set<string> {
  return new Set(
    db
      .select({ courseId: assignments.courseId })
      .from(assignments)
      .where(isNotNull(assignments.courseId))
      .all()
      .map((row) => row.courseId as string),
  );
}

/**
 * 教师端课程列表（GET /api/teacher/courses?archived，T2A.4）。
 * archived：true = 只列已归档，false = 只列未归档（D4 教师端可筛选查看）。
 * memberIds 随列表下发（学生页「所在课程」/「管理课程」数据源，量级小）。
 */
export function listCoursesForTeacher(
  db: Db,
  filter: { archived: boolean },
): CourseSummary[] {
  const rows = db
    .select()
    .from(courses)
    .orderBy(asc(courses.order), asc(courses.title))
    .all()
    .filter((row) =>
      filter.archived ? row.archivedAt !== null : row.archivedAt === null,
    );
  if (rows.length === 0) return [];

  const { lectureById, unitById } = loadResourceContext(db);
  const itemsByCourse = new Map<string, CourseItem[]>();
  for (const row of db
    .select()
    .from(courseItems)
    .orderBy(asc(courseItems.order), asc(courseItems.id))
    .all()) {
    const list = itemsByCourse.get(row.courseId) ?? [];
    list.push(row);
    itemsByCourse.set(row.courseId, list);
  }
  const membersByCourse = new Map<string, string[]>();
  for (const row of db
    .select({
      courseId: courseStudents.courseId,
      studentId: courseStudents.studentId,
    })
    .from(courseStudents)
    .orderBy(asc(courseStudents.joinedAt), asc(courseStudents.studentId))
    .all()) {
    const list = membersByCourse.get(row.courseId) ?? [];
    list.push(row.studentId);
    membersByCourse.set(row.courseId, list);
  }
  // D4 口径（T2A.7）：attempts.courseId 或 assignments.courseId 命中即有关联
  const attempted = attemptedCourseIds(db);
  const assigned = assignedCourseIds(db);

  return rows.map((course) => {
    const items = itemsByCourse.get(course.id) ?? [];
    // 可见条目数（courseSummarySchema 注释口径）：visible=true 且资源未软删
    const visibleItemCount = items.filter((item) => {
      if (!item.visible) return false;
      if (item.kind === "lecture") {
        const lecture = lectureById.get(item.refId ?? "");
        return lecture !== undefined && lecture.deletedAt === null;
      }
      if (item.kind === "unit") {
        const unit = unitById.get(item.refId ?? "");
        return unit !== undefined && unit.deletedAt === null;
      }
      return true; // 分节无资源引用
    }).length;
    const hasAttempts = attempted.has(course.id) || assigned.has(course.id);
    const memberIds = membersByCourse.get(course.id) ?? [];
    return {
      id: course.id,
      name: course.title,
      description: course.description,
      archived: course.archivedAt !== null,
      archivedAt: course.archivedAt,
      order: course.order,
      memberCount: memberIds.length,
      itemCount: items.length,
      visibleItemCount,
      memberIds,
      hasAttempts,
      createdAt: course.createdAt,
    };
  });
}

/** 目录条目的状态标签（§4-4；优先级：已删除 > 无题目 > 隐藏 > 定时 > 可见） */
function itemStatus(
  item: CourseItem,
  resourceDeleted: boolean,
  liveQuestionCount: number | null,
  now: Date,
): CourseDetailItem["status"] {
  if (resourceDeleted) return "deleted";
  if (liveQuestionCount !== null && liveQuestionCount < 1)
    return "no-questions";
  if (!item.visible) return "hidden";
  if (item.publishAt !== null && Date.parse(item.publishAt) > now.getTime()) {
    return "scheduled";
  }
  return "visible";
}

/**
 * 课程详情（GET /api/teacher/courses/:id，T2A.4）：目录条目（含资源摘要与状态
 * 标签数据）+ 成员列表 + hasAttempts（删除按钮禁用判断）。now 可注入（定时测试）。
 */
export function getCourseDetail(
  db: Db,
  id: string,
  now: Date = new Date(),
): CourseDetailData {
  const course = db.select().from(courses).where(eq(courses.id, id)).get();
  if (course === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
  const { lectureById, unitById, liveQuestionCountByUnit } =
    loadResourceContext(db);
  const items = db
    .select()
    .from(courseItems)
    .where(eq(courseItems.courseId, id))
    .orderBy(asc(courseItems.order), asc(courseItems.id))
    .all();
  const detailItems: CourseDetailItem[] = items.map((item) => {
    if (item.kind === "section") {
      return {
        id: item.id,
        kind: item.kind,
        refId: null,
        title: item.title ?? "",
        order: item.order,
        visible: item.visible,
        publishAt: item.publishAt,
        status: itemStatus(item, false, null, now),
        questionCount: null,
        resourceUpdatedAt: null,
        createdAt: item.createdAt,
      };
    }
    if (item.kind === "lecture") {
      const lecture = lectureById.get(item.refId ?? "");
      const deleted = lecture === undefined || lecture.deletedAt !== null;
      return {
        id: item.id,
        kind: item.kind,
        refId: item.refId,
        title: lecture?.title ?? "（讲义已删除）",
        order: item.order,
        visible: item.visible,
        publishAt: item.publishAt,
        status: itemStatus(item, deleted, null, now),
        questionCount: null,
        resourceUpdatedAt: lecture?.updatedAt ?? null,
        createdAt: item.createdAt,
      };
    }
    const unit = unitById.get(item.refId ?? "");
    const deleted = unit === undefined || unit.deletedAt !== null;
    const liveCount = liveQuestionCountByUnit.get(item.refId ?? "") ?? 0;
    return {
      id: item.id,
      kind: item.kind,
      refId: item.refId,
      title: unit?.title ?? "（单元已删除）",
      order: item.order,
      visible: item.visible,
      publishAt: item.publishAt,
      status: itemStatus(item, deleted, liveCount, now),
      questionCount: liveCount,
      resourceUpdatedAt: unit?.updatedAt ?? null,
      createdAt: item.createdAt,
    };
  });
  const members = db
    .select({
      studentId: students.id,
      displayName: students.displayName,
      joinedAt: courseStudents.joinedAt,
      studentArchivedAt: students.archivedAt,
    })
    .from(courseStudents)
    .innerJoin(students, eq(courseStudents.studentId, students.id))
    .where(eq(courseStudents.courseId, id))
    .orderBy(asc(students.displayName))
    .all()
    .map((row) => ({
      studentId: row.studentId,
      displayName: row.displayName,
      joinedAt: row.joinedAt,
      archived: row.studentArchivedAt !== null,
    }));
  return {
    id: course.id,
    name: course.title,
    description: course.description,
    archived: course.archivedAt !== null,
    archivedAt: course.archivedAt,
    order: course.order,
    hasAttempts: courseHasAttempts(db, id),
    items: detailItems,
    members,
    createdAt: course.createdAt,
  };
}

/**
 * 学生可见预览（GET /api/teacher/courses/:id/student-view，§4-10，T2A.4）：
 * 按 D5（listVisibleItems → canStudentSeeItem 唯一判定）计算该成员此刻可见的
 * 目录，只含目录元信息，不含任何题目内容。courseArchived / studentArchived /
 * isMember 供前端解释空目录原因。
 */
export function getStudentView(
  db: Db,
  courseId: string,
  studentId: string,
  now: Date | string = new Date(),
): CourseStudentViewData {
  const course = db
    .select({ id: courses.id, archivedAt: courses.archivedAt })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (course === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
  const student = db
    .select({
      id: students.id,
      displayName: students.displayName,
      archivedAt: students.archivedAt,
    })
    .from(students)
    .where(eq(students.id, studentId))
    .get();
  if (student === undefined) {
    throw new HttpError(404, "STUDENT_NOT_FOUND", "学生不存在");
  }
  const isMember = isCourseMember(db, courseId, studentId);
  const items = listVisibleItems(db, studentId, courseId, now);
  return {
    studentId,
    studentName: student.displayName,
    courseArchived: course.archivedAt !== null,
    studentArchived: student.archivedAt !== null,
    isMember,
    items,
  };
}

// ---------- T2A.6：教师进度矩阵（GET /api/teacher/courses/:id/progress） ----------

/**
 * 课程练习作答的聚合口径（D10；学生端 studentUnitAttemptSummarySchema 同一定义）：
 * - 只统计 sourceType='course' 的作答（作业作答不计入）；
 * - 得分 = scoreFinal ?? scoreAuto（0–100 整数百分比；两者皆空为 null）；
 * - 首次/最近/最高得分只取**已交卷**（submitted/graded）作答，按 attemptNo 排序；
 * - pendingCount：待批题数 = 已作答（answerJson 非空）但 autoCorrect 与
 *   finalCorrect 均为空的 responses 行数（未作答题不进待批）。
 */
interface CourseAttemptAggregate {
  count: number;
  submittedCount: number;
  hasDraft: boolean;
  firstScore: number | null;
  latestScore: number | null;
  bestScore: number | null;
  pendingCount: number;
}

/** 行 → 有效得分（scoreFinal ?? scoreAuto） */
function effectiveScore(row: {
  scoreAuto: number | null;
  scoreFinal: number | null;
}): number | null {
  return row.scoreFinal ?? row.scoreAuto;
}

/**
 * 教师进度矩阵（T2A.6）：成员 × 可见单元，每格课程练习统计 + 历次列表。
 * - 行（members）：全部课程成员（含已归档学生——教师侧保留统计视角），按姓名排序；
 * - 列（units）：对学生可见的单元条目（visible=true 且已到 publishAt 且资源
 *   未删且有未删题，D5 的资源侧口径），按目录条目顺序；
 * - cells：只含有作答的单元格，缺席（从未做过）由前端按空渲染；
 * - 点击单元格的历次列表内联在 cell.history（详情页属 T3.1）。
 * now 可注入（publishAt 到点判断）。
 */
export function getCourseProgress(
  db: Db,
  courseId: string,
  now: Date | string = new Date(),
): CourseProgressData {
  requireCourse(db, courseId);
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();

  // 行：成员（含已归档）
  const members = db
    .select({
      studentId: students.id,
      displayName: students.displayName,
      studentArchivedAt: students.archivedAt,
    })
    .from(courseStudents)
    .innerJoin(students, eq(courseStudents.studentId, students.id))
    .where(eq(courseStudents.courseId, courseId))
    .orderBy(asc(students.displayName))
    .all()
    .map((row) => ({
      studentId: row.studentId,
      displayName: row.displayName,
      archived: row.studentArchivedAt !== null,
    }));

  // 列：可见单元（D5 资源侧口径）
  const { unitById, liveQuestionCountByUnit } = loadResourceContext(db);
  const unitItems = db
    .select({
      refId: courseItems.refId,
      order: courseItems.order,
      visible: courseItems.visible,
      publishAt: courseItems.publishAt,
    })
    .from(courseItems)
    .where(eq(courseItems.courseId, courseId))
    .orderBy(asc(courseItems.order), asc(courseItems.id))
    .all();
  const units: CourseProgressUnit[] = [];
  for (const item of unitItems) {
    if (item.refId === null) continue;
    const unit = unitById.get(item.refId);
    if (unit === undefined || unit.deletedAt !== null) continue;
    if (!item.visible) continue;
    if (item.publishAt !== null && Date.parse(item.publishAt) > nowMs) {
      continue;
    }
    if ((liveQuestionCountByUnit.get(item.refId) ?? 0) < 1) continue;
    units.push({
      unitId: item.refId,
      title: unit.title,
      order: item.order,
    });
  }

  // 课程练习作答（该课程全部成员的全部 course 作答；一对一量级内存聚合足够）
  const memberIds = new Set(members.map((member) => member.studentId));
  const courseAttempts = db
    .select()
    .from(attempts)
    .where(
      and(eq(attempts.courseId, courseId), eq(attempts.sourceType, "course")),
    )
    .orderBy(asc(attempts.attemptNo))
    .all()
    .filter((row) => memberIds.has(row.studentId));

  // 待批题数（按 attempt 聚合：answerJson 非空且 autoCorrect/finalCorrect 均空）
  const pendingByAttempt = new Map<string, number>();
  if (courseAttempts.length > 0) {
    const attemptIds = courseAttempts.map((row) => row.id);
    for (let start = 0; start < attemptIds.length; start += 500) {
      const chunk = attemptIds.slice(start, start + 500);
      for (const row of db
        .select({ attemptId: responses.attemptId })
        .from(responses)
        .where(
          and(
            inArray(responses.attemptId, chunk),
            isNotNull(responses.answerJson),
            isNull(responses.autoCorrect),
            isNull(responses.finalCorrect),
          ),
        )
        .all()) {
        pendingByAttempt.set(
          row.attemptId,
          (pendingByAttempt.get(row.attemptId) ?? 0) + 1,
        );
      }
    }
  }

  // (studentId, unitId) → 聚合 + 历次
  const aggregateByCell = new Map<
    string,
    {
      aggregate: CourseAttemptAggregate;
      history: CourseProgressCell["history"];
      firstSubmittedSeen: boolean;
    }
  >();
  for (const row of courseAttempts) {
    const key = `${row.studentId}:${row.unitId}`;
    const entry = aggregateByCell.get(key) ?? {
      aggregate: {
        count: 0,
        submittedCount: 0,
        hasDraft: false,
        firstScore: null,
        latestScore: null,
        bestScore: null,
        pendingCount: 0,
      } satisfies CourseAttemptAggregate,
      history: [] as CourseProgressCell["history"],
      firstSubmittedSeen: false,
    };
    entry.aggregate.count += 1;
    entry.aggregate.pendingCount += pendingByAttempt.get(row.id) ?? 0;
    const score = effectiveScore(row);
    if (row.status === "draft") {
      entry.aggregate.hasDraft = true;
    } else {
      entry.aggregate.submittedCount += 1;
      // 已交卷按 attemptNo 升序遍历：首个交卷即首次得分（无可判分保持 null），
      // 最后一个交卷即最近得分；最高分取非空得分的最大值
      if (!entry.firstSubmittedSeen) {
        entry.firstSubmittedSeen = true;
        entry.aggregate.firstScore = score;
      }
      entry.aggregate.latestScore = score;
      if (score !== null) {
        entry.aggregate.bestScore = Math.max(
          entry.aggregate.bestScore ?? 0,
          score,
        );
      }
    }
    entry.history.push({
      attemptId: row.id,
      attemptNo: row.attemptNo,
      status: row.status,
      score,
      submittedAt: row.submittedAt,
    });
    aggregateByCell.set(key, entry);
  }

  const cells: CourseProgressCell[] = [];
  for (const [key, entry] of aggregateByCell) {
    // key = "<studentId>:<unitId>"（studentId 是 UUID 无冒号；unitId 来自 DSL
    // 理论可含冒号——用首个冒号切分，不用 split 限参避免截断）
    const sep = key.indexOf(":");
    if (sep <= 0) continue;
    const studentId = key.slice(0, sep);
    const unitId = key.slice(sep + 1);
    // 矩阵只覆盖当前成员 × 可见单元；历史数据（已移出成员/已隐藏单元）不进矩阵
    if (!memberIds.has(studentId)) continue;
    if (!units.some((unit) => unit.unitId === unitId)) continue;
    const latest = entry.history
      .filter((h) => h.submittedAt !== null)
      .sort((a, b) => b.attemptNo - a.attemptNo)[0];
    cells.push({
      studentId,
      unitId,
      ...entry.aggregate,
      latestSubmittedAt: latest?.submittedAt ?? null,
      history: entry.history.sort((a, b) => b.attemptNo - a.attemptNo),
    });
  }

  return { courseId, members, units, cells };
}
