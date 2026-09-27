import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  assignments,
  attempts,
  courseItems,
  courses,
  lectures,
  libraryFolders,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";

/**
 * LibraryService（T2A.1）——资源库服务层：文件夹 CRUD、讲义/单元软删与恢复、
 * 使用情况查询。HTTP 接口（/api/teacher/library/*）属 T2A.2，本模块先落业务逻辑。
 *
 * - 文件夹（D2）：一级不可嵌套；「未归类」= folderId NULL，不是行，不可删不可改名；
 *   删除文件夹时内容移入未归类（本模块返回移动数量，确认弹层属 T2A.2 UI）；
 * - 软删/恢复（D3）：deletedAt 置值/清空，幂等；彻底删除（purge）属 T2A.2；
 * - 使用情况（D3 删除确认弹层数据源）：被哪些课程引用（条目级可见性）、
 *   被哪些未删除作业使用、关联作答数。
 */

/** 文件夹数据（服务层形状；HTTP 契约在 T2A.2 定义） */
export interface LibraryFolderData {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly createdAt: string;
}

/** 使用情况：引用该资源的课程（条目级「当前对学生是否可见」） */
export interface LibraryUsageCourseRef {
  readonly courseId: string;
  readonly courseTitle: string;
  /** 条目此刻是否满足可见性（visible 且 publishAt 已到；D5 的条目级条件） */
  readonly visible: boolean;
}

/** 使用情况：使用该资源的未删除作业 */
export interface LibraryUsageAssignmentRef {
  readonly id: string;
  readonly title: string;
  readonly dueAt: string | null;
}

/** 资源使用情况（D3：删除前确认弹层 / T2A.2 彻底删除条件判断的数据源） */
export interface LibraryResourceUsage {
  readonly courses: LibraryUsageCourseRef[];
  readonly assignments: LibraryUsageAssignmentRef[];
  readonly attemptCount: number;
}

// ---------- 文件夹 CRUD ----------

/** 全部文件夹（order 升序，同 order 按名排序稳定输出）。「未归类」不是行，不在此列 */
export function listFolders(db: Db): LibraryFolderData[] {
  return db
    .select()
    .from(libraryFolders)
    .orderBy(asc(libraryFolders.order), asc(libraryFolders.name))
    .all();
}

/** 按 id 取文件夹行，不存在 → 404 FOLDER_NOT_FOUND */
function requireFolder(db: Db, id: string) {
  const row = db
    .select()
    .from(libraryFolders)
    .where(eq(libraryFolders.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
  }
  return row;
}

/** 同名文件夹是否已存在（folderId 不设库级唯一约束，重名校验在应用层） */
function folderNameTaken(db: Db, name: string): boolean {
  return (
    db
      .select({ id: libraryFolders.id })
      .from(libraryFolders)
      .where(eq(libraryFolders.name, name))
      .get() !== undefined
  );
}

/** 新建文件夹（追加到末尾）。同名已存在 → 409 FOLDER_NAME_EXISTS（应用层校验，见 D2） */
export function createFolder(
  db: Db,
  input: { name: string },
): LibraryFolderData {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "文件夹名不能为空");
  }
  if (folderNameTaken(db, name)) {
    throw new HttpError(409, "FOLDER_NAME_EXISTS", "已存在同名文件夹");
  }
  const maxOrder = db
    .select({ order: libraryFolders.order })
    .from(libraryFolders)
    .all()
    .reduce((max, row) => Math.max(max, row.order), -1);
  const row = {
    id: crypto.randomUUID(),
    name,
    order: maxOrder + 1,
    createdAt: new Date().toISOString(),
  };
  db.insert(libraryFolders).values(row).run();
  return row;
}

/** 文件夹改名。不存在 → 404；同名已存在 → 409（「未归类」不是行，无此概念） */
export function renameFolder(
  db: Db,
  id: string,
  input: { name: string },
): LibraryFolderData {
  const row = requireFolder(db, id);
  const name = input.name.trim();
  if (name.length === 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "文件夹名不能为空");
  }
  if (name !== row.name && folderNameTaken(db, name)) {
    throw new HttpError(409, "FOLDER_NAME_EXISTS", "已存在同名文件夹");
  }
  if (name !== row.name) {
    db.update(libraryFolders)
      .set({ name })
      .where(eq(libraryFolders.id, id))
      .run();
  }
  return { ...row, name };
}

/**
 * 删除文件夹：内容（讲义/单元）移入「未归类」（folderId 置 NULL）后删除文件夹行。
 * 返回移动数量（确认弹层显示「将移动 N 篇讲义、M 个单元」属 T2A.2 UI）。
 */
export function deleteFolder(
  db: Db,
  id: string,
): { movedLectures: number; movedUnits: number } {
  requireFolder(db, id);
  let movedLectures = 0;
  let movedUnits = 0;
  db.transaction((tx) => {
    movedLectures = tx
      .update(lectures)
      .set({ folderId: null })
      .where(eq(lectures.folderId, id))
      .run().changes;
    movedUnits = tx
      .update(units)
      .set({ folderId: null })
      .where(eq(units.folderId, id))
      .run().changes;
    tx.delete(libraryFolders).where(eq(libraryFolders.id, id)).run();
  });
  return { movedLectures, movedUnits };
}

/** 文件夹拖拽排序：ids 为全部文件夹的完整新顺序，order 按下标（0 起）重写 */
export function reorderFolders(db: Db, ids: readonly string[]): void {
  const rows = db.select({ id: libraryFolders.id }).from(libraryFolders).all();
  const liveIds = new Set(rows.map((row) => row.id));
  const missing = ids.find((id) => !liveIds.has(id));
  if (missing !== undefined) {
    throw new HttpError(
      404,
      "FOLDER_NOT_FOUND",
      `排序失败：文件夹「${missing}」不存在`,
    );
  }
  db.transaction((tx) => {
    for (const [index, id] of ids.entries()) {
      tx.update(libraryFolders)
        .set({ order: index })
        .where(eq(libraryFolders.id, id))
        .run();
    }
  });
}

// ---------- 讲义/单元软删与恢复（D3） ----------

/** 讲义软删（DELETE /api/teacher/lectures/:id 的实现，T2A.1 起物理删除取消）。
 *  行不存在 → 404；已软删幂等成功。关联单元的 lectureId 保留（恢复即回到原状）。 */
export function softDeleteLecture(db: Db, id: string): void {
  const row = db
    .select({ id: lectures.id, deletedAt: lectures.deletedAt })
    .from(lectures)
    .where(eq(lectures.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
  }
  if (row.deletedAt !== null) return; // 幂等：重复删除同样成功
  db.update(lectures)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(lectures.id, id))
    .run();
}

/** 讲义从回收站恢复（deletedAt 清空，幂等）。行不存在 → 404 */
export function restoreLecture(db: Db, id: string): void {
  const row = db
    .select({ id: lectures.id })
    .from(lectures)
    .where(eq(lectures.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
  }
  db.update(lectures).set({ deletedAt: null }).where(eq(lectures.id, id)).run();
}

/** 单元软删（D3；T2A.2 暴露 DELETE /api/teacher/units/:id）。幂等，404 同上 */
export function softDeleteUnit(db: Db, id: string): void {
  const row = db
    .select({ id: units.id, deletedAt: units.deletedAt })
    .from(units)
    .where(eq(units.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "UNIT_NOT_FOUND", "练习单元不存在");
  }
  if (row.deletedAt !== null) return;
  db.update(units)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(units.id, id))
    .run();
}

/** 单元从回收站恢复（幂等）。行不存在 → 404 */
export function restoreUnit(db: Db, id: string): void {
  const row = db
    .select({ id: units.id })
    .from(units)
    .where(eq(units.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "UNIT_NOT_FOUND", "练习单元不存在");
  }
  db.update(units).set({ deletedAt: null }).where(eq(units.id, id)).run();
}

// ---------- 使用情况查询（D3 删除确认弹层数据源） ----------

/** 条目此刻是否满足条目级可见（D5 条件 3 的口径：visible 且 publishAt ≤ 现在） */
function itemVisibleNow(
  visible: boolean,
  publishAt: string | null,
  nowIso: string,
): boolean {
  return visible && (publishAt === null || publishAt <= nowIso);
}

/** 某资源被哪些课程引用（经 course_items；含可见性快照，now 可注入） */
function usageCourseRefs(
  db: Db,
  kind: "lecture" | "unit",
  refId: string,
  nowIso: string,
): LibraryUsageCourseRef[] {
  return db
    .select({
      courseId: courses.id,
      courseTitle: courses.title,
      visible: courseItems.visible,
      publishAt: courseItems.publishAt,
    })
    .from(courseItems)
    .innerJoin(courses, eq(courseItems.courseId, courses.id))
    .where(and(eq(courseItems.kind, kind), eq(courseItems.refId, refId)))
    .orderBy(asc(courses.order), asc(courses.title))
    .all()
    .map((row) => ({
      courseId: row.courseId,
      courseTitle: row.courseTitle,
      visible: itemVisibleNow(row.visible, row.publishAt, nowIso),
    }));
}

/** 使用某资源的未删除作业（当前 assignments.unitId 单列引用；T2A.7 起走 assignment_units） */
function usageAssignmentRefs(
  db: Db,
  unitId: string,
): LibraryUsageAssignmentRef[] {
  return db
    .select({
      id: assignments.id,
      title: assignments.title,
      dueAt: assignments.dueAt,
    })
    .from(assignments)
    .where(and(eq(assignments.unitId, unitId), isNull(assignments.deletedAt)))
    .all();
}

/**
 * 单元使用情况：课程引用（条目级可见性）、未删除作业、作答数。
 * now 可注入（publishAt 判断）。作答数 = attempts.unitId 命中数（含草稿——
 * D3「没有任何作答记录」按存在性判断，草稿也是记录）。
 */
export function getUnitUsage(
  db: Db,
  id: string,
  now: Date | string = new Date(),
): LibraryResourceUsage {
  const unit = db
    .select({ id: units.id })
    .from(units)
    .where(eq(units.id, id))
    .get();
  if (unit === undefined) {
    throw new HttpError(404, "UNIT_NOT_FOUND", "练习单元不存在");
  }
  const nowIso = typeof now === "string" ? now : now.toISOString();
  const attemptCount = db
    .select({ id: attempts.id })
    .from(attempts)
    .where(eq(attempts.unitId, id))
    .all().length;
  return {
    courses: usageCourseRefs(db, "unit", id, nowIso),
    assignments: usageAssignmentRefs(db, id),
    attemptCount,
  };
}

/**
 * 讲义使用情况。讲义不被作业直接引用（作业以单元为内容，现状与 T2A.7 后均如此）
 * → assignments 恒为空数组；作答数取「配套单元」（units.lectureId 指向本讲义）
 * 关联的作答数——保守口径：彻底删除前宁可多算不可漏算（D3）。
 */
export function getLectureUsage(
  db: Db,
  id: string,
  now: Date | string = new Date(),
): LibraryResourceUsage {
  const lecture = db
    .select({ id: lectures.id })
    .from(lectures)
    .where(eq(lectures.id, id))
    .get();
  if (lecture === undefined) {
    throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
  }
  const nowIso = typeof now === "string" ? now : now.toISOString();
  const companionUnitIds = db
    .select({ id: units.id })
    .from(units)
    .where(eq(units.lectureId, id))
    .all()
    .map((row) => row.id);
  const attemptCount =
    companionUnitIds.length === 0
      ? 0
      : db
          .select({ id: attempts.id })
          .from(attempts)
          .where(inArray(attempts.unitId, companionUnitIds))
          .all().length;
  return {
    courses: usageCourseRefs(db, "lecture", id, nowIso),
    assignments: [],
    attemptCount,
  };
}
