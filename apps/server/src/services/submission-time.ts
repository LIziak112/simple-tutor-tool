import type { ResponseRow } from "../db/schema.ts";

/** 旧焦点口径的提交写入值；没有聚焦证据与真实零秒必须区分。 */
export function submittedTimePatchOf(
  activeSecByQuestion: Readonly<Record<string, number>>,
  questionId: string,
): Pick<ResponseRow, "activeSec"> {
  return { activeSec: activeSecByQuestion[questionId] ?? null };
}

/** 卷级账只合计冻结题的封存行，不重放已提交题的回看事件。 */
export function recordedActiveSecTotal(
  rows: readonly Pick<ResponseRow, "activeSec">[],
): number | null {
  let total: number | null = null;
  for (const row of rows) {
    if (row.activeSec !== null) total = (total ?? 0) + row.activeSec;
  }
  return total;
}
