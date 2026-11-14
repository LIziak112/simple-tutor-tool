/** 讲练页面与来源投影共用：正文首现顺序，重复引用去重，孤儿冻结题追加。 */
export function lessonQuestionIdsInDisplayOrder(
  blocks: readonly { type: string; questionId?: string }[],
  questionIds: readonly string[],
): string[] {
  const available = new Set(questionIds);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of [
    ...blocks.flatMap((b) =>
      b.type === "question" && b.questionId !== undefined ? [b.questionId] : [],
    ),
    ...questionIds,
  ]) {
    if (available.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
