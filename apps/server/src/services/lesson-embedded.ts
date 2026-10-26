import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { lectures, units } from "../db/schema.ts";

/**
 * 讲练嵌入单元的唯一判定（讲练一体 2026-10 的「讲练页一件事」）：
 * 嵌入单元 = units.lectureId 指向 kind='lesson' 讲义。判定**不看软删**——讲义
 * 软删恢复后单元仍是嵌入单元，调用方自行按各自的未删口径过滤外层行。
 *
 * 资源库单元列表、文件夹计数、课程目录/详情/计数、D8 配套展开共用这一谓词。
 * 2026-10-20 的两处回归（课程目录里多出「讲义 + 66 题」两个条目、文件夹计数
 * 把一篇讲练页算成 2）都是因为新读取面各自手写过滤时漏掉了这里。
 */

/** 本教师域内 kind='lesson' 讲义 id 集（含软删：判定不随 deletedAt 漂移） */
function lessonLectureIds(db: Db, teacherId: string): Set<string> {
  return new Set(
    db
      .select({ id: lectures.id })
      .from(lectures)
      .where(
        and(eq(lectures.teacherId, teacherId), eq(lectures.kind, "lesson")),
      )
      .all()
      .map((row) => row.id),
  );
}

/**
 * 从已加载的行派生嵌入单元 id 集（调用方已读全 units/lectures 时用它，
 * 避免为判定再查一次库）。
 */
export function embeddedUnitIdsFrom(
  unitRows: Iterable<{ id: string; lectureId: string | null }>,
  lessonLectureIdSet: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const row of unitRows) {
    if (row.lectureId !== null && lessonLectureIdSet.has(row.lectureId)) {
      ids.add(row.id);
    }
  }
  return ids;
}

/** 本教师域内嵌入单元 id 集（未加载资源行时的直接查询） */
export function lessonEmbeddedUnitIds(db: Db, teacherId: string): Set<string> {
  return embeddedUnitIdsFrom(
    db
      .select({ id: units.id, lectureId: units.lectureId })
      .from(units)
      .where(eq(units.teacherId, teacherId))
      .all(),
    lessonLectureIds(db, teacherId),
  );
}

/** 课程目录条目是否指向嵌入单元（教师端各读取面统一用它过滤） */
export function isEmbeddedUnitItem(
  item: { readonly kind: string; readonly refId: string | null },
  embeddedUnitIds: ReadonlySet<string>,
): boolean {
  return (
    item.kind === "unit" &&
    item.refId !== null &&
    embeddedUnitIds.has(item.refId)
  );
}
