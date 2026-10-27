import {
  type CourseCatalogCommand,
  courseCatalogCommandSchema,
} from "@tutor/contract";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type CourseItem,
  courseItems,
  courses,
  lectures,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";

/** 名称在课程内唯一；资源原名完整保留，文件夹可指定含后缀长度上限。 */
export function uniqueCatalogTitle(
  title: string,
  used: Set<string>,
  maxLength = Number.POSITIVE_INFINITY,
): string {
  const base = title.trim().slice(0, maxLength) || "未命名";
  let candidate = base;
  for (let n = 2; used.has(candidate.toLocaleLowerCase()); n += 1) {
    const suffix = `（${n}）`;
    candidate = `${base.slice(0, maxLength - suffix.length)}${suffix}`;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

export function catalogRows(db: Db, courseId: string): CourseItem[] {
  return db
    .select()
    .from(courseItems)
    .where(eq(courseItems.courseId, courseId))
    .orderBy(asc(courseItems.order), asc(courseItems.id))
    .all();
}

export function requireCatalogParent(
  db: Db,
  courseId: string,
  parentId: string | null,
): void {
  if (parentId === null) return;
  const parent = db
    .select()
    .from(courseItems)
    .where(
      and(
        eq(courseItems.courseId, courseId),
        eq(courseItems.id, parentId),
        eq(courseItems.kind, "section"),
      ),
    )
    .get();
  if (!parent)
    throw new HttpError(
      404,
      "COURSE_FOLDER_NOT_FOUND",
      "目标文件夹不存在，请刷新目录后重试",
    );
}

/** 按来源相对路径逐层归档；同一路径在重试、改名后仍复用原文件夹。 */
export function ensureCourseFolderPath(
  db: Db,
  teacherId: string,
  courseId: string,
  baseParentId: string | null,
  path: readonly string[],
): string | null {
  if (
    !db
      .select({ id: courses.id })
      .from(courses)
      .where(and(eq(courses.id, courseId), eq(courses.teacherId, teacherId)))
      .get()
  )
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  requireCatalogParent(db, courseId, baseParentId);
  let parentId = baseParentId;
  let key = baseParentId ?? "root";
  for (const segment of path) {
    if (segment === "." || segment === ".." || /[\\/]/.test(segment))
      throw new HttpError(422, "INVALID_FOLDER_PATH", "目录路径不合法");
    key += `/${segment}`;
    const rows = catalogRows(db, courseId);
    const existing = rows.find(
      (row) =>
        row.kind === "section" &&
        (row.importPath === key ||
          (row.parentId === parentId && row.title === segment)),
    );
    if (existing) {
      parentId = existing.id;
      if (existing.importPath === null)
        db.update(courseItems)
          .set({ importPath: key })
          .where(eq(courseItems.id, existing.id))
          .run();
    } else {
      const created = executeCatalogCommand(db, teacherId, courseId, {
        action: "createFolder",
        title: segment,
        parentId,
      });
      parentId = created.id;
      if (parentId)
        db.update(courseItems)
          .set({ importPath: key })
          .where(eq(courseItems.id, parentId))
          .run();
    }
  }
  return parentId;
}

/** 仅在写事务/一次性迁入中补齐目录名称，不修改资源原件。 */
export function ensureCatalogTitles(db: Db, courseId: string): Set<string> {
  const course = db
    .select()
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  const used = new Set<string>();
  for (const row of catalogRows(db, courseId)) {
    const resource =
      row.kind === "lecture"
        ? db
            .select({ title: lectures.title })
            .from(lectures)
            .where(
              and(
                eq(lectures.id, row.refId ?? ""),
                eq(lectures.teacherId, course?.teacherId ?? ""),
              ),
            )
            .get()
        : row.kind === "unit"
          ? db
              .select({ title: units.title })
              .from(units)
              .where(
                and(
                  eq(units.id, row.refId ?? ""),
                  eq(units.teacherId, course?.teacherId ?? ""),
                ),
              )
              .get()
          : undefined;
    const title = uniqueCatalogTitle(
      row.title ?? resource?.title ?? "内容已移除",
      used,
      row.kind === "section" ? 100 : undefined,
    );
    if (row.title !== title)
      db.update(courseItems)
        .set({ title })
        .where(eq(courseItems.id, row.id))
        .run();
  }
  return used;
}

/** 祖先链同样受可见与定时门约束；异常图失败关闭。 */
export function catalogAncestorsVisible(
  row: CourseItem,
  byId: ReadonlyMap<string, CourseItem>,
  now: Date | string,
): boolean {
  const visited = new Set([row.id]);
  let parentId = row.parentId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (
      parent?.kind !== "section" ||
      visited.has(parent.id) ||
      !parent.visible ||
      (parent.publishAt !== null &&
        Date.parse(parent.publishAt) > new Date(now).getTime())
    )
      return false;
    visited.add(parent.id);
    parentId = parent.parentId;
  }
  return true;
}

export function executeCatalogCommand(
  db: Db,
  teacherId: string,
  courseId: string,
  input: CourseCatalogCommand,
): { id: string | null } {
  const command = courseCatalogCommandSchema.parse(input);
  return db.transaction(() => {
    if (
      !db
        .select({ id: courses.id })
        .from(courses)
        .where(and(eq(courses.id, courseId), eq(courses.teacherId, teacherId)))
        .get()
    )
      throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
    const rows = catalogRows(db, courseId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ids =
      "ids" in command ? command.ids : "id" in command ? [command.id] : [];
    if (new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id)))
      throw new HttpError(409, "CATALOG_CHANGED", "目录已变化，请刷新后重试");
    const selected = new Set(ids);
    function descendants(id: string): boolean {
      const visited = new Set<string>();
      let current = byId.get(id);
      while (current) {
        if (selected.has(current.id)) return true;
        if (visited.has(current.id))
          throw new HttpError(409, "CATALOG_CYCLE", "文件夹不能循环嵌套");
        visited.add(current.id);
        current =
          current.parentId === null ? undefined : byId.get(current.parentId);
      }
      return false;
    }
    if ("parentId" in command)
      requireCatalogParent(db, courseId, command.parentId);
    if (command.action === "createFolder") {
      const used = ensureCatalogTitles(db, courseId);
      const id = crypto.randomUUID();
      db.insert(courseItems)
        .values({
          id,
          courseId,
          parentId: command.parentId,
          kind: "section",
          title: uniqueCatalogTitle(command.title, used, 100),
          order: Math.max(-1, ...rows.map((row) => row.order)) + 1,
          visible: true,
          createdAt: new Date().toISOString(),
        })
        .run();
      return { id };
    }
    if (command.action === "rename") {
      ensureCatalogTitles(db, courseId);
      if (
        catalogRows(db, courseId).some(
          (row) =>
            row.id !== command.id &&
            row.title?.toLocaleLowerCase() ===
              command.title.toLocaleLowerCase(),
        )
      )
        throw new HttpError(
          409,
          "DUPLICATE_CATALOG_TITLE",
          "本课程已有同名内容，请换一个名称",
        );
      db.update(courseItems)
        .set({ title: command.title })
        .where(eq(courseItems.id, command.id))
        .run();
    } else if (command.action === "move") {
      if (command.parentId !== null && descendants(command.parentId))
        throw new HttpError(409, "CATALOG_CYCLE", "不能移入自身或子文件夹");
      let order = Math.max(-1, ...rows.map((row) => row.order)) + 1;
      for (const row of rows.filter(
        (row) =>
          selected.has(row.id) &&
          (row.parentId === null || !descendants(row.parentId)),
      )) {
        db.update(courseItems)
          .set({ parentId: command.parentId, order: order++ })
          .where(eq(courseItems.id, row.id))
          .run();
      }
    } else if (command.action === "reorder") {
      const siblings = rows.filter((row) => row.parentId === command.parentId);
      if (
        siblings.length !== ids.length ||
        siblings.some((row) => !selected.has(row.id))
      )
        throw new HttpError(
          409,
          "CATALOG_CHANGED",
          "同级内容已变化，请刷新后重试",
        );
      const orders = siblings.map((row) => row.order).sort((a, b) => a - b);
      ids.forEach((id, index) => {
        db.update(courseItems)
          .set({ order: orders[index] ?? index })
          .where(eq(courseItems.id, id))
          .run();
      });
    } else if (command.action === "setVisibility") {
      // 显示保留原定时计划；隐藏与显示只修改显式选择的节点，祖先门统一生效。
      db.update(courseItems)
        .set({ visible: command.visible })
        .where(inArray(courseItems.id, ids))
        .run();
    } else if (command.action === "remove") {
      if (command.keepChildren) {
        for (const row of rows.filter(
          (row) =>
            !selected.has(row.id) &&
            row.parentId !== null &&
            descendants(row.parentId),
        )) {
          let parentId = row.parentId;
          while (parentId !== null && selected.has(parentId))
            parentId = byId.get(parentId)?.parentId ?? null;
          if (parentId !== row.parentId)
            db.update(courseItems)
              .set({ parentId })
              .where(eq(courseItems.id, row.id))
              .run();
        }
      }
      const removed = rows
        .filter(
          (row) =>
            selected.has(row.id) ||
            (!command.keepChildren && descendants(row.id)),
        )
        .map((row) => row.id);
      if (removed.length)
        db.delete(courseItems).where(inArray(courseItems.id, removed)).run();
    }
    return { id: null };
  });
}
