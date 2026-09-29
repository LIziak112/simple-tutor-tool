import type { LibraryBatchRequest } from "@tutor/contract";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import {
  assignments,
  assignmentUnits,
  attempts,
  courseItems,
  courses,
  ink,
  knowledgePoints,
  lectures,
  libraryFolders,
  questionKnowledge,
  questions,
  responses,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { addCourseItems } from "./course-service.ts";

/**
 * LibraryService（T2A.1 服务层 + T2A.2 资源库页面业务）——文件夹 CRUD、讲义/单元
 * 软删与恢复、彻底删除（purge）、使用情况查询、列表检索、元数据编辑、批量操作、
 * 导出为可重新导入的 v2 Markdown。
 *
 * - 文件夹（D2）：一级不可嵌套；「未归类」= folderId NULL，不是行，不可删不可改名；
 *   删除文件夹时内容移入未归类（返回移动数量供确认弹层展示）；
 * - 软删/恢复（D3）：deletedAt 置值/清空，幂等；purge 仅当无作答记录与作业引用
 *   （409 RESOURCE_IN_USE），同时清理课程目录引用条目，避免悬空；
 * - 使用情况（D3 删除确认弹层数据源）：被哪些课程引用（条目级可见性）、
 *   被哪些未删除作业使用、关联作答数；
 * - 导出（T2A.2）：单元 = frontmatter + 未软删各题 sourceMd 按序拼接（已删题不导出，
 *   防止「导出→再导入」经 D18 同 id 恢复规则复活）；讲义 = kind: lecture 头 + markdown 原文。
 */

/** 文件夹数据（含资源计数；HTTP 契约 libraryFolderSchema 同形） */
export interface LibraryFolderData {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  /** 文件夹内未删除讲义数 */
  readonly lectureCount: number;
  /** 文件夹内未删除单元数 */
  readonly unitCount: number;
  readonly createdAt: string;
}

/** 使用情况：引用该资源的课程（条目级「当前对学生是否可见」；契约 libraryUsageCourseSchema 同形） */
export interface LibraryUsageCourseRef {
  readonly id: string;
  readonly name: string;
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

/** 全部文件夹（order 升序，同 order 按名排序稳定输出），含未删除资源计数。「未归类」不是行，不在此列 */
export function listFolders(db: Db): LibraryFolderData[] {
  const rows = db
    .select()
    .from(libraryFolders)
    .orderBy(asc(libraryFolders.order), asc(libraryFolders.name))
    .all();
  const lectureCounts = new Map<string, number>();
  for (const row of db
    .select({
      folderId: lectures.folderId,
      count: sql<number>`count(*)`,
    })
    .from(lectures)
    .where(isNull(lectures.deletedAt))
    .groupBy(lectures.folderId)
    .all()) {
    if (row.folderId !== null) {
      lectureCounts.set(row.folderId, Number(row.count));
    }
  }
  const unitCounts = new Map<string, number>();
  for (const row of db
    .select({
      folderId: units.folderId,
      count: sql<number>`count(*)`,
    })
    .from(units)
    .where(isNull(units.deletedAt))
    .groupBy(units.folderId)
    .all()) {
    if (row.folderId !== null) {
      unitCounts.set(row.folderId, Number(row.count));
    }
  }
  return rows.map((row) => ({
    ...row,
    lectureCount: lectureCounts.get(row.id) ?? 0,
    unitCount: unitCounts.get(row.id) ?? 0,
  }));
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
  return { ...row, lectureCount: 0, unitCount: 0 };
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
  // 改名不动资源计数，按库内现值取（listFolders 同口径）
  const [lectureCount, unitCount] = countFolderResources(db, id);
  return { ...row, name, lectureCount, unitCount };
}

/** 文件夹内未删除讲义/单元计数（rename 返回值用；「未归类」不在调用范围） */
function countFolderResources(db: Db, id: string): [number, number] {
  const lectureCount = db
    .select({ id: lectures.id })
    .from(lectures)
    .where(and(eq(lectures.folderId, id), isNull(lectures.deletedAt)))
    .all().length;
  const unitCount = db
    .select({ id: units.id })
    .from(units)
    .where(and(eq(units.folderId, id), isNull(units.deletedAt)))
    .all().length;
  return [lectureCount, unitCount];
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
      id: courses.id,
      name: courses.title,
      visible: courseItems.visible,
      publishAt: courseItems.publishAt,
    })
    .from(courseItems)
    .innerJoin(courses, eq(courseItems.courseId, courses.id))
    .where(and(eq(courseItems.kind, kind), eq(courseItems.refId, refId)))
    .orderBy(asc(courses.order), asc(courses.title))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      visible: itemVisibleNow(row.visible, row.publishAt, nowIso),
    }));
}

/**
 * 使用某单元的未删除作业（T2A.7 起走 assignment_units 关联，多单元作业按行命中）。
 */
function usageAssignmentRefs(
  db: Db,
  unitId: string,
): LibraryUsageAssignmentRef[] {
  return (
    db
      .select({
        id: assignments.id,
        title: assignments.title,
        dueAt: assignments.dueAt,
      })
      .from(assignmentUnits)
      .innerJoin(assignments, eq(assignmentUnits.assignmentId, assignments.id))
      .where(
        and(eq(assignmentUnits.unitId, unitId), isNull(assignments.deletedAt)),
      )
      // 确定性排序：单元被多作业引用时面板顺序不依赖 SQLite 实现（新布置的在前）
      .orderBy(desc(assignments.createdAt), asc(assignments.id))
      .all()
  );
}

/**
 * 单元集合的作答数（D3 保守口径，含草稿——「没有任何作答记录」按存在性判断）：
 * - attempts.unitId 直接命中（course 来源与旧 assignment 行）；
 * - assignment 来源经 assignment_units 关联（T2A.7 起新 attempt 的 unitId 为
 *   null，单按 unitId 计数会漏）。
 */
function attemptCountByUnits(db: Db, unitIds: readonly string[]): number {
  if (unitIds.length === 0) return 0;
  const assignmentIds = [
    ...new Set(
      db
        .select({ assignmentId: assignmentUnits.assignmentId })
        .from(assignmentUnits)
        .where(inArray(assignmentUnits.unitId, [...unitIds]))
        .all()
        .map((row) => row.assignmentId),
    ),
  ];
  const counted = new Set<string>(
    db
      .select({ id: attempts.id })
      .from(attempts)
      .where(inArray(attempts.unitId, [...unitIds]))
      .all()
      .map((row) => row.id),
  );
  if (assignmentIds.length > 0) {
    for (const row of db
      .select({ id: attempts.id })
      .from(attempts)
      .where(
        and(
          isNotNull(attempts.assignmentId),
          inArray(attempts.assignmentId, assignmentIds),
        ),
      )
      .all()) {
      // 同一 attempt 可能既 unitId 命中又经 assignment 关联（旧数据），按 id 去重
      counted.add(row.id);
    }
  }
  return counted.size;
}

/**
 * 单元使用情况：课程引用（条目级可见性）、未删除作业、作答数。
 * now 可注入（publishAt 判断）。作答数口径见 attemptCountByUnits。
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
  return {
    courses: usageCourseRefs(db, "unit", id, nowIso),
    assignments: usageAssignmentRefs(db, id),
    attemptCount: attemptCountByUnits(db, [id]),
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
  return {
    courses: usageCourseRefs(db, "lecture", id, nowIso),
    assignments: [],
    attemptCount: attemptCountByUnits(db, companionUnitIds),
  };
}

// ---------- T2A.2：列表检索（讲义库 / 题库 / 回收站） ----------

/** 列表筛选条件（GET /library/lectures、/units 的查询参数语义） */
export interface LibraryListFilter {
  /** undefined = 全部文件夹；null = 未归类（"none"）；UUID = 指定文件夹 */
  readonly folderId?: string | null | undefined;
  /** 搜索词：标题 / 单元 id / topic / 讲义标题 / 考点（小写包含匹配） */
  readonly q?: string | undefined;
  /** true = 回收站（deletedAt 非空）；false = 未删除 */
  readonly deleted: boolean;
}

/** 讲义库列表项（契约 libraryLectureSummarySchema 同形） */
export interface LibraryLectureSummaryRow {
  readonly id: string;
  readonly title: string;
  readonly folderId: string | null;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly courseCount: number;
}

/** 题库列表项（契约 libraryUnitSummarySchema 同形） */
export interface LibraryUnitSummaryRow {
  readonly id: string;
  readonly title: string;
  readonly topic: string | null;
  readonly folderId: string | null;
  readonly lectureId: string | null;
  readonly lectureTitle: string | null;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly questionCount: number;
  readonly typeDistribution: Record<string, number>;
  readonly knowledge: string[];
  readonly courseCount: number;
  readonly assignmentCount: number;
  readonly questions: {
    id: string;
    type: string;
    difficulty: number;
    knowledge: string[];
    version: number;
  }[];
}

/** folderId 过滤条件（undefined 放行全部） */
function folderMatches(
  rowFolderId: string | null,
  filterFolderId: string | null | undefined,
): boolean {
  if (filterFolderId === undefined) return true;
  if (filterFolderId === null) return rowFolderId === null;
  return rowFolderId === filterFolderId;
}

/** 每个资源被课程引用的次数（course_items 按 refId 分组） */
function courseCountByRef(db: Db): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of db
    .select({ refId: courseItems.refId })
    .from(courseItems)
    .all()) {
    if (row.refId === null) continue;
    map.set(row.refId, (map.get(row.refId) ?? 0) + 1);
  }
  return map;
}

/** 讲义库列表（order 升序；回收站按删除时间倒序再按 order 稳定输出） */
export function listLibraryLectures(
  db: Db,
  filter: LibraryListFilter,
): LibraryLectureSummaryRow[] {
  const q = filter.q?.trim().toLowerCase() ?? "";
  const courseCounts = courseCountByRef(db);
  const rows = db
    .select()
    .from(lectures)
    .orderBy(asc(lectures.order), asc(lectures.title))
    .all()
    .filter((row) => folderMatches(row.folderId, filter.folderId))
    .filter((row) =>
      filter.deleted ? row.deletedAt !== null : row.deletedAt === null,
    )
    .filter((row) => q.length === 0 || row.title.toLowerCase().includes(q))
    .map((row) => ({
      id: row.id,
      title: row.title,
      folderId: row.folderId,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      courseCount: courseCounts.get(row.id) ?? 0,
    }));
  if (filter.deleted) {
    // 回收站：最近删除的排前面，方便找回
    rows.sort((a, b) =>
      a.deletedAt === b.deletedAt
        ? 0
        : (a.deletedAt ?? "") < (b.deletedAt ?? "")
          ? 1
          : -1,
    );
  }
  return rows;
}

/** 题库列表（单元 order 升序；含题数/题型分布/考点/引用数/作业数/题目摘要） */
export function listLibraryUnits(
  db: Db,
  filter: LibraryListFilter,
): LibraryUnitSummaryRow[] {
  const q = filter.q?.trim().toLowerCase() ?? "";
  const courseCounts = courseCountByRef(db);
  // 配套讲义标题（软删讲义不出现，与「资源软删不出现在列表」口径一致：
  // 软删后 lectureTitle 显示为 null，恢复后自动回来）
  const lectureTitles = new Map(
    db
      .select({ id: lectures.id, title: lectures.title })
      .from(lectures)
      .where(isNull(lectures.deletedAt))
      .all()
      .map((row) => [row.id, row.title] as const),
  );
  // 使用各单元的未删除作业数（T2A.7 起走 assignment_units 关联；复合主键保证
  // 同一作业对同一单元只贡献 1）
  const assignmentCounts = new Map<string, number>();
  for (const row of db
    .select({ unitId: assignmentUnits.unitId })
    .from(assignmentUnits)
    .innerJoin(assignments, eq(assignmentUnits.assignmentId, assignments.id))
    .where(isNull(assignments.deletedAt))
    .all()) {
    assignmentCounts.set(
      row.unitId,
      (assignmentCounts.get(row.unitId) ?? 0) + 1,
    );
  }
  // 未删除题目摘要（type/difficulty/version + 考点），按单元分组、按题序
  const questionRows = db
    .select({
      id: questions.id,
      unitId: questions.unitId,
      order: questions.order,
      type: questions.type,
      difficulty: questions.difficulty,
      version: questions.version,
    })
    .from(questions)
    .where(isNull(questions.deletedAt))
    .orderBy(asc(questions.unitId), asc(questions.order), asc(questions.id))
    .all();
  const knowledgeByQuestion = new Map<string, string[]>();
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
    .orderBy(asc(knowledgePoints.name))
    .all()) {
    const list = knowledgeByQuestion.get(row.questionId);
    if (list === undefined) {
      knowledgeByQuestion.set(row.questionId, [row.name]);
    } else {
      list.push(row.name);
    }
  }
  const questionsByUnit = new Map<
    string,
    {
      id: string;
      type: string;
      difficulty: number;
      knowledge: string[];
      version: number;
    }[]
  >();
  for (const qRow of questionRows) {
    const summary = {
      id: qRow.id,
      type: qRow.type,
      difficulty: qRow.difficulty,
      knowledge: knowledgeByQuestion.get(qRow.id) ?? [],
      version: qRow.version,
    };
    const list = questionsByUnit.get(qRow.unitId);
    if (list === undefined) {
      questionsByUnit.set(qRow.unitId, [summary]);
    } else {
      list.push(summary);
    }
  }

  const rows = db
    .select()
    .from(units)
    .orderBy(asc(units.order), asc(units.title))
    .all()
    .filter((row) => folderMatches(row.folderId, filter.folderId))
    .filter((row) =>
      filter.deleted ? row.deletedAt !== null : row.deletedAt === null,
    )
    .map((row) => {
      const unitQuestions = questionsByUnit.get(row.id) ?? [];
      const typeDistribution: Record<string, number> = {};
      const knowledgeSet = new Set<string>();
      for (const item of unitQuestions) {
        typeDistribution[item.type] = (typeDistribution[item.type] ?? 0) + 1;
        for (const name of item.knowledge) knowledgeSet.add(name);
      }
      return {
        id: row.id,
        title: row.title,
        topic: row.topic,
        folderId: row.folderId,
        lectureId: row.lectureId,
        lectureTitle:
          row.lectureId === null
            ? null
            : (lectureTitles.get(row.lectureId) ?? null),
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
        questionCount: unitQuestions.length,
        typeDistribution,
        knowledge: [...knowledgeSet].sort((a, b) => a.localeCompare(b)),
        courseCount: courseCounts.get(row.id) ?? 0,
        assignmentCount: assignmentCounts.get(row.id) ?? 0,
        questions: unitQuestions,
      };
    })
    // 搜索口径（§4-3）：标题 / 单元 id / topic / 考点（含配套讲义标题兜底）
    .filter(
      (row) =>
        q.length === 0 ||
        row.title.toLowerCase().includes(q) ||
        row.id.toLowerCase().includes(q) ||
        (row.topic?.toLowerCase().includes(q) ?? false) ||
        row.knowledge.some((name) => name.toLowerCase().includes(q)),
    );
  if (filter.deleted) {
    rows.sort((a, b) =>
      a.deletedAt === b.deletedAt
        ? 0
        : (a.deletedAt ?? "") < (b.deletedAt ?? "")
          ? 1
          : -1,
    );
  }
  return rows;
}

// ---------- T2A.2：单元 / 讲义元数据编辑 ----------

/** 校验文件夹存在（folderId null = 未归类，跳过）；不存在 → 404 FOLDER_NOT_FOUND */
function assertFolderExists(db: Db, folderId: string): void {
  if (
    db
      .select({ id: libraryFolders.id })
      .from(libraryFolders)
      .where(eq(libraryFolders.id, folderId))
      .get() === undefined
  ) {
    throw new HttpError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
  }
}

/**
 * 单元元数据编辑（PATCH /api/teacher/units/:id）：标题 / 主题 / 文件夹 / 配套讲义。
 * 字段缺省 = 不改；显式 null = 清空。注意：重新导入同 id 单元会用文件内容覆盖
 * 标题与主题（页面有说明文案）。
 */
export function updateUnitMeta(
  db: Db,
  id: string,
  input: {
    title?: string | undefined;
    topic?: string | null | undefined;
    folderId?: string | null | undefined;
    lectureId?: string | null | undefined;
  },
): {
  id: string;
  title: string;
  topic: string | null;
  folderId: string | null;
  lectureId: string | null;
  updatedAt: string;
} {
  const row = db.select().from(units).where(eq(units.id, id)).get();
  if (row === undefined) {
    throw new HttpError(404, "UNIT_NOT_FOUND", "练习单元不存在");
  }
  const patch: Partial<typeof units.$inferInsert> = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new HttpError(422, "VALIDATION_ERROR", "单元标题不能为空");
    }
    patch.title = title;
  }
  if (input.topic !== undefined) patch.topic = input.topic;
  if (input.folderId !== undefined) {
    if (input.folderId !== null) assertFolderExists(db, input.folderId);
    patch.folderId = input.folderId;
  }
  if (input.lectureId !== undefined) {
    if (input.lectureId !== null) {
      const lecture = db
        .select({ id: lectures.id, deletedAt: lectures.deletedAt })
        .from(lectures)
        .where(eq(lectures.id, input.lectureId))
        .get();
      if (lecture === undefined || lecture.deletedAt !== null) {
        throw new HttpError(
          404,
          "LECTURE_NOT_FOUND",
          "配套讲义不存在（可能已被删除）",
        );
      }
    }
    patch.lectureId = input.lectureId;
  }
  const updatedAt = new Date().toISOString();
  if (Object.keys(patch).length > 0) {
    patch.updatedAt = updatedAt;
    db.update(units).set(patch).where(eq(units.id, id)).run();
  }
  return {
    id,
    title: patch.title ?? row.title,
    topic: patch.topic !== undefined ? patch.topic : row.topic,
    folderId: patch.folderId !== undefined ? patch.folderId : row.folderId,
    lectureId: patch.lectureId !== undefined ? patch.lectureId : row.lectureId,
    updatedAt: Object.keys(patch).length > 0 ? updatedAt : row.updatedAt,
  };
}

/**
 * 讲义归属编辑（PATCH /api/teacher/lectures/:id）：移动文件夹。
 * 只改 folderId，不触碰 markdown / 标题 / updatedAt（内容编辑走现有 PUT 接口）。
 */
export function updateLectureFolder(
  db: Db,
  id: string,
  input: { folderId?: string | null | undefined },
): { id: string; title: string; folderId: string | null } {
  const row = db
    .select({
      id: lectures.id,
      title: lectures.title,
      folderId: lectures.folderId,
    })
    .from(lectures)
    .where(eq(lectures.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
  }
  if (input.folderId !== undefined) {
    if (input.folderId !== null) assertFolderExists(db, input.folderId);
    db.update(lectures)
      .set({ folderId: input.folderId })
      .where(eq(lectures.id, id))
      .run();
    return { id: row.id, title: row.title, folderId: input.folderId };
  }
  return { id: row.id, title: row.title, folderId: row.folderId };
}

// ---------- T2A.2：彻底删除（purge，D3 条件） ----------

/** 组装「正在使用」的中文说明（409 message 用，确认弹层另有结构化数据） */
function describeUsage(usage: LibraryResourceUsage): string {
  const parts: string[] = [];
  if (usage.attemptCount > 0) {
    parts.push(`${usage.attemptCount} 条作答记录`);
  }
  if (usage.assignments.length > 0) {
    parts.push(`${usage.assignments.length} 个作业`);
  }
  return parts.length > 0 ? `该资源仍有${parts.join("、")}，不能彻底删除` : "";
}

/**
 * 单元彻底删除（D3）：仅当没有任何作答记录与作业引用时允许。
 * 额外防御：responses / ink 中仍引用本单元题目的行同样视为「在使用」（题目跨单元
 * 移动等历史数据可能造成 attempt 之外的引用，宁可拒绝不可悬空）。
 * 删除范围：课程目录引用条目 + 题目考点关联 + 题目行 + 单元行（knowledge_points 全局共享保留）。
 */
export function purgeUnit(db: Db, id: string): void {
  const row = db
    .select({ id: units.id })
    .from(units)
    .where(eq(units.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "UNIT_NOT_FOUND", "练习单元不存在");
  }
  const usage = getUnitUsage(db, id);
  const unitQuestionIds = db
    .select({ id: questions.id })
    .from(questions)
    .where(eq(questions.unitId, id))
    .all()
    .map((q) => q.id);
  const responseRefCount =
    unitQuestionIds.length === 0
      ? 0
      : db
          .select({ id: responses.id })
          .from(responses)
          .where(inArray(responses.questionId, unitQuestionIds))
          .all().length;
  const inkRefCount =
    unitQuestionIds.length === 0
      ? 0
      : db
          .select({ id: ink.id })
          .from(ink)
          .where(inArray(ink.questionId, unitQuestionIds))
          .all().length;
  if (
    usage.attemptCount > 0 ||
    usage.assignments.length > 0 ||
    responseRefCount > 0 ||
    inkRefCount > 0
  ) {
    const reason =
      describeUsage(usage) ||
      `该单元的题目仍被 ${responseRefCount + inkRefCount} 条作答/笔迹记录引用，不能彻底删除`;
    throw new HttpError(409, "RESOURCE_IN_USE", reason);
  }
  db.transaction((tx) => {
    tx.delete(courseItems)
      .where(and(eq(courseItems.kind, "unit"), eq(courseItems.refId, id)))
      .run();
    if (unitQuestionIds.length > 0) {
      tx.delete(questionKnowledge)
        .where(inArray(questionKnowledge.questionId, unitQuestionIds))
        .run();
    }
    tx.delete(questions).where(eq(questions.unitId, id)).run();
    tx.delete(units).where(eq(units.id, id)).run();
  });
}

/**
 * 讲义彻底删除（D3）：作答数经配套单元保守合计（getLectureUsage），>0 拒绝；
 * 作业不直接引用讲义。删除范围：配套关联解除（units.lectureId 置 NULL）+
 * 课程目录引用条目 + 讲义行。
 */
export function purgeLecture(db: Db, id: string): void {
  const row = db
    .select({ id: lectures.id })
    .from(lectures)
    .where(eq(lectures.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
  }
  const usage = getLectureUsage(db, id);
  if (usage.attemptCount > 0) {
    throw new HttpError(409, "RESOURCE_IN_USE", describeUsage(usage));
  }
  db.transaction((tx) => {
    tx.update(units)
      .set({ lectureId: null })
      .where(eq(units.lectureId, id))
      .run();
    tx.delete(courseItems)
      .where(and(eq(courseItems.kind, "lecture"), eq(courseItems.refId, id)))
      .run();
    tx.delete(lectures).where(eq(lectures.id, id)).run();
  });
}

// ---------- T2A.2：批量操作（§4-2） ----------

/** 批量操作的单条结果 */
export interface BatchItemResult {
  readonly id: string;
  readonly ok: boolean;
  readonly skipped?: boolean;
  readonly error?: string;
  readonly message?: string;
}

/** 单条操作 → 结果（HttpError 转 {ok:false}，不抛出） */
function tryItem(id: string, fn: () => void): BatchItemResult {
  try {
    fn();
    return { id, ok: true };
  } catch (err) {
    if (err instanceof HttpError) {
      return { id, ok: false, error: err.code, message: err.message };
    }
    return {
      id,
      ok: false,
      error: "INTERNAL",
      message: "操作失败，请稍后重试",
    };
  }
}

/**
 * 批量操作（POST /api/teacher/library/batch）：move / delete / restore / addToCourse。
 * 参数级错误（folderId / courseId 缺失或不存在）整体抛出；单条资源失败逐条记录不中断。
 * addToCourse 重复加入按跳过处理（导入/添加幂等场景，不报错）。
 */
export function batchLibrary(
  db: Db,
  input: LibraryBatchRequest,
): { results: BatchItemResult[] } {
  if (input.action === "move") {
    if (input.folderId === undefined) {
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "移动到文件夹需要 folderId（移入未归类传 null）",
      );
    }
    if (input.folderId !== null) assertFolderExists(db, input.folderId);
    const folderId = input.folderId;
    const results = input.ids.map((id) =>
      tryItem(id, () => {
        if (input.kind === "unit") {
          updateUnitMeta(db, id, { folderId });
        } else {
          updateLectureFolder(db, id, { folderId });
        }
      }),
    );
    return { results };
  }
  if (input.action === "delete") {
    const results = input.ids.map((id) =>
      tryItem(id, () => {
        if (input.kind === "unit") softDeleteUnit(db, id);
        else softDeleteLecture(db, id);
      }),
    );
    return { results };
  }
  if (input.action === "restore") {
    const results = input.ids.map((id) =>
      tryItem(id, () => {
        if (input.kind === "unit") restoreUnit(db, id);
        else restoreLecture(db, id);
      }),
    );
    return { results };
  }
  // addToCourse（复用 CourseService.addCourseItems；重复 → 跳过）
  if (input.courseId === undefined) {
    throw new HttpError(422, "VALIDATION_ERROR", "加入课程需要 courseId");
  }
  const course = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.id, input.courseId))
    .get();
  if (course === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
  const results = input.ids.map((id) =>
    tryItem(id, () => {
      addCourseItems(
        db,
        input.courseId as string,
        [{ kind: input.kind, refId: id }],
        { visible: input.visible ?? true },
      );
    }),
  );
  // 重复加入 → ok=true + skipped（幂等跳过，不当作失败）
  return {
    results: results.map((result) =>
      result.ok
        ? result
        : result.error === "DUPLICATE_COURSE_ITEM"
          ? {
              id: result.id,
              ok: true,
              skipped: true,
              message: "已在本课程目录中，跳过",
            }
          : result,
    ),
  };
}

// ---------- T2A.2：导出为可重新导入的 v2 Markdown ----------

/** 文件名安全化（替换 Windows 保留字符与控制符，\p{Cc} = Unicode 控制字符类） */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\p{Cc}]/gu, "_").trim();
  return cleaned.length > 0 ? cleaned : "export";
}

/** YAML 双引号标量（与 md-dsl edit-context 的 wrapSingleQuestionMd 同一口径） */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * 给题目 sourceMd 的容器开始行注入显式 id 属性（无 id 时）。
 * 为什么：缺省题目 id 按「单元slug-序号」由文档内位置推导——单元删过题后导出，
 * 剩余题的缺省 id 会整体前移（练习四-2 变成练习四-1），「导出→再导入」会错位更新
 * 到别的题目、破坏学情统计的 id 延续。注入显式 id 让往返后题目身份完全稳定。
 * sourceMd 第一行必为 `::::question{…}` 或 `::::question`（解析器提取口径），
 * 已带 id= 属性则原样返回。
 */
function ensureQuestionId(sourceMd: string, id: string): string {
  const newlineIndex = sourceMd.indexOf("\n");
  const firstLine =
    newlineIndex === -1 ? sourceMd : sourceMd.slice(0, newlineIndex);
  const rest = newlineIndex === -1 ? "" : sourceMd.slice(newlineIndex);
  const match = /^(:{4}question)(\{.*)?$/.exec(firstLine);
  if (match === null) return sourceMd; // 结构异常（不应发生）：不改动，交给 lint
  const [, prefix, attrs = ""] = match;
  if (/(^|\s)id\s*=/.test(attrs)) return sourceMd; // 已有显式 id
  // 注入进属性花括号内：{type=judge …} → {type=judge … id="…"}；
  // 无属性则补 {id="…"}。属性未闭合（不以 } 结尾）属异常形态，不改动交给 lint。
  let injected: string;
  if (attrs.length === 0) {
    injected = `${prefix}{id=${JSON.stringify(id)}}`;
  } else if (attrs.endsWith("}")) {
    injected = `${prefix}${attrs.slice(0, -1)} id=${JSON.stringify(id)}}`;
  } else {
    return sourceMd;
  }
  return `${injected}${rest}`;
}

/**
 * 导出单元（GET /api/teacher/units/:id/export.md）：
 * frontmatter（kind: practice、unit、lecture（配套讲义标题，若有）、topic（若有））
 * + 未删除各题 sourceMd 按题序拼接（空行分隔；缺省 id 的题注入显式 id，见
 * ensureQuestionId）。已删题不导出——防止「导出→再导入」经 D18 的同 id 恢复规则
 * 复活已删题；另有已删题时 frontmatter 后以 HTML 注释注明（lint 不产生
 * error/warning，往返测试覆盖）。单元不存在 → 404。
 */
export function exportUnitMd(
  db: Db,
  id: string,
): { markdown: string; filename: string } {
  const unit = db.select().from(units).where(eq(units.id, id)).get();
  if (unit === undefined) {
    throw new HttpError(404, "UNIT_NOT_FOUND", "练习单元不存在");
  }
  const lines: string[] = [
    "---",
    "kind: practice",
    `unit: ${yamlString(unit.id)}`,
  ];
  let lectureTitle: string | null = null;
  if (unit.lectureId !== null) {
    const lecture = db
      .select({ title: lectures.title })
      .from(lectures)
      .where(eq(lectures.id, unit.lectureId))
      .get();
    if (lecture !== undefined) {
      lectureTitle = lecture.title;
      lines.push(`lecture: ${yamlString(lectureTitle)}`);
    }
  }
  if (unit.topic !== null) {
    lines.push(`topic: ${yamlString(unit.topic)}`);
  }
  lines.push("---", "");
  const deletedQuestionCount = db
    .select({ id: questions.id })
    .from(questions)
    .where(and(eq(questions.unitId, id), isNotNull(questions.deletedAt)))
    .all().length;
  if (deletedQuestionCount > 0) {
    lines.push(
      `<!-- 导出说明：本单元另有 ${deletedQuestionCount} 道已删除的题目未导出（防止重新导入时恢复已删题）。 -->`,
      "",
    );
  }
  const liveQuestions = db
    .select({ id: questions.id, sourceMd: questions.sourceMd })
    .from(questions)
    .where(and(eq(questions.unitId, id), isNull(questions.deletedAt)))
    .orderBy(asc(questions.order), asc(questions.id))
    .all()
    .map((row) => ensureQuestionId(row.sourceMd, row.id));
  lines.push(liveQuestions.join("\n\n"), "");
  return {
    markdown: lines.join("\n"),
    filename: `${safeFilename(unit.id)}.md`,
  };
}

/**
 * 导出讲义（GET /api/teacher/lectures/:id/export.md）：
 * `---\nkind: lecture\n---\n\n` + markdown 原文（可原样重新导入；文件名 = 讲义标题）。
 * 讲义不存在 → 404。
 */
export function exportLectureMd(
  db: Db,
  id: string,
): { markdown: string; filename: string } {
  const row = db
    .select({ title: lectures.title, markdown: lectures.markdown })
    .from(lectures)
    .where(eq(lectures.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
  }
  const markdown = `---\nkind: lecture\n---\n\n${row.markdown}`;
  return { markdown, filename: `${safeFilename(row.title)}.md` };
}
