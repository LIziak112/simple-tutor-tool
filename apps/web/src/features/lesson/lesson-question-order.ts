import {
  type AttemptQuestionPublic,
  type LessonStartData,
  lessonQuestionIdsInDisplayOrder,
} from "@tutor/contract";
export interface LessonQuestionSlot {
  question: AttemptQuestionPublic;
  index: number;
  orphan: boolean;
}

/**
 * 题目在 blocks 中按出现顺序排列（孤儿冻结题排在其后）+ 伴生 byId 索引：
 * 父组件算一次传入 LessonBody，题槽渲染统一 map.get（免循环内 find 的
 * O(n²) 与 as 断言）。
 */
export function lessonQuestionOrder(data: LessonStartData): {
  ordered: LessonQuestionSlot[];
  byId: Map<string, LessonQuestionSlot>;
} {
  const questions = new Map(data.questions.map((q) => [q.id, q] as const));
  const inBlocks = new Set(
    data.blocks.flatMap((b) => (b.type === "question" ? [b.questionId] : [])),
  );
  const ordered: LessonQuestionSlot[] = [];
  for (const id of lessonQuestionIdsInDisplayOrder(
    data.blocks,
    data.questions.map((q) => q.id),
  )) {
    const question = questions.get(id);
    if (question)
      ordered.push({
        question,
        index: ordered.length,
        orphan: !inBlocks.has(id),
      });
  }
  const slotById = new Map(
    ordered.map((slot) => [slot.question.id, slot] as const),
  );
  return { ordered, byId: slotById };
}
