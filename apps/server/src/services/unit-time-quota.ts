import { inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { units } from "../db/schema";
import { practiceDefaultsOf } from "./practice-workflow-service";

/**
 * 模块参考时间配额（2026-11-09 模块 7「按模块看结果」）：单元 frontmatter
 * `practice.timeLimitMinutes` 的当前值（units.practiceDefaultsJson，解析走
 * practiceDefaultsOf 单源）。结果页把它与该模块的题内活动用时并列——只是
 * 参考，不是时钟、不参与任何判定。无推荐 / 坏数据 / 非单元 id 不出现在表里。
 */
export function unitTimeQuotasOf(
  db: Db,
  unitIds: readonly string[],
): Map<string, number> {
  const quotas = new Map<string, number>();
  if (unitIds.length === 0) return quotas;
  const rows = db
    .select({ id: units.id, col: units.practiceDefaultsJson })
    .from(units)
    .where(inArray(units.id, [...new Set(unitIds)]))
    .all();
  for (const row of rows) {
    const minutes = practiceDefaultsOf(row.col)?.timeLimitMinutes;
    if (minutes !== undefined) quotas.set(row.id, minutes);
  }
  return quotas;
}
