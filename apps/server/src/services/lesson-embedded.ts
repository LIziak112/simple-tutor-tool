import { and, eq, inArray } from "drizzle-orm";
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
export function lessonEmbeddedUnitIds(
  db: Db,
  teacherId: string,
  unitIds?: readonly string[] | undefined,
): Set<string> {
  if (unitIds !== undefined && unitIds.length === 0) return new Set();
  const rows = db
    .select({ id: units.id })
    .from(units)
    .innerJoin(
      lectures,
      and(
        eq(lectures.id, units.lectureId),
        eq(lectures.teacherId, units.teacherId),
      ),
    )
    .where(
      and(
        eq(units.teacherId, teacherId),
        eq(lectures.kind, "lesson"),
        unitIds === undefined ? undefined : inArray(units.id, [...unitIds]),
      ),
    )
    .all();
  return new Set(rows.map((row) => row.id));
}
