import type {
  ReviewGroupDimension,
  ReviewQuestionFact,
} from "./review-facts.ts";
import { rubricEffectiveOf } from "./rubric.ts";
export interface ReviewGroupStats {
  id: string;
  title: string;
  questionIds: string[];
  total: number;
  answered: number;
  correct: number;
  wrong: number;
  pending: number;
  unsureCorrect: number;
  objectiveCount: number;
  objectiveCorrect: number;
  correctRate: number | null;
  activeSec: number | null;
  wrongQuestionIds: string[];
  rubricAverages: {
    key: string;
    id: string;
    title: string;
    average: number;
    count: number;
  }[];
}
export function defaultReviewDimension(
  facts: readonly ReviewQuestionFact[],
): ReviewGroupDimension | null {
  if (new Set(facts.map((f) => f.unit.id)).size > 1) return "unit";
  return facts.some((f) => (f.settlementSeq ?? 0) > 1) ? "settlement" : null;
}
function keys(
  f: ReviewQuestionFact,
  dimension: ReviewGroupDimension,
): [string, string][] {
  switch (dimension) {
    case "unit":
      return [[f.unit.id, f.unit.title]];
    case "settlement":
      return [
        [
          String(f.settlementSeq ?? "none"),
          f.settlementSeq === null ? "未归批" : `第 ${f.settlementSeq} 批`,
        ],
      ];
    case "type":
      return [[f.type, f.type]];
    case "material":
      return f.materialIds.length
        ? [...new Set(f.materialIds)].map((id) => [`material:${id}`, id])
        : [["missing-material", "未标材料"]];
    case "knowledge":
      return f.knowledge.length
        ? [...new Set(f.knowledge)].map((id) => [`knowledge:${id}`, id])
        : [["missing-knowledge", "未标考点"]];
  }
}
/** 材料/考点为多归属分组，跨组计数可重叠，不能相加当总题数。 */
export function groupReviewFacts(
  facts: readonly ReviewQuestionFact[],
  dimension: ReviewGroupDimension,
): ReviewGroupStats[] {
  const groups = new Map<
    string,
    { title: string; facts: ReviewQuestionFact[] }
  >();
  for (const fact of facts)
    for (const [id, title] of keys(fact, dimension)) {
      const group = groups.get(id) ?? { title, facts: [] };
      if (!group.facts.some((f) => f.questionId === fact.questionId))
        group.facts.push(fact);
      groups.set(id, group);
    }
  return [...groups].map(([id, { title, facts: rows }]) => {
    const objective = rows.filter(
      (f) => f.gradingPolicy === "auto" && f.verdict !== null,
    );
    const times = rows.flatMap((f) =>
      f.activeSec === null ? [] : [f.activeSec],
    );
    const rubric = new Map<
      string,
      { key: string; id: string; title: string; sum: number; count: number }
    >();
    for (const row of rows) {
      if (!row.rubricReview) continue;
      const ratings = rubricEffectiveOf(row.rubricReview) ?? [];
      for (const item of row.rubricReview.rubric.items) {
        const rating = ratings.find((r) => r.id === item.id);
        if (!rating) continue;
        // 同名同描述才可比较，防不同量表的r1被合并。
        const key = JSON.stringify([
          item.title,
          item.desc ?? "",
          row.rubricReview.rubric.levels,
        ]);
        const entry = rubric.get(key) ?? {
          key,
          id: item.id,
          title: item.title,
          sum: 0,
          count: 0,
        };
        entry.sum += rating.level;
        entry.count++;
        rubric.set(key, entry);
      }
    }
    return {
      id,
      title,
      questionIds: rows.map((f) => f.questionId),
      total: rows.length,
      answered: rows.filter((f) => f.answered).length,
      correct: rows.filter((f) => f.verdict === true).length,
      wrong: rows.filter((f) => f.verdict === false && f.answered).length,
      pending: rows.filter((f) => f.verdict === null).length,
      unsureCorrect: rows.filter(
        (f) => f.studentFlag === "unsure" && f.verdict === true,
      ).length,
      objectiveCount: objective.length,
      objectiveCorrect: objective.filter((f) => f.verdict).length,
      correctRate: objective.length
        ? objective.filter((f) => f.verdict).length / objective.length
        : null,
      activeSec: times.length ? times.reduce((a, b) => a + b, 0) : null,
      wrongQuestionIds: rows
        .filter((f) => f.retrainable)
        .map((f) => f.questionId),
      rubricAverages: [...rubric.values()].map((r) => ({
        key: r.key,
        id: r.id,
        title: r.title,
        average: r.sum / r.count,
        count: r.count,
      })),
    };
  });
}
