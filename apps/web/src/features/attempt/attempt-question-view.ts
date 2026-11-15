import type { AttemptDraftData, AttemptQuestionPublic } from "@tutor/contract";

/** 渲染与保存使用同一批题目版本，不能从可能已被其他标签页更新的目录猜版本。 */
export function questionRevisionMap(
  questions: readonly AttemptQuestionPublic[],
): Record<string, string> {
  return Object.fromEntries(
    questions.map((question) => [question.id, question.questionRevisionId]),
  );
}
export function attemptQuestionViewOf(units: AttemptDraftData["units"]) {
  const flatQuestions = units.flatMap((unit) => unit.questions);
  return {
    flatQuestions,
    questionIds: flatQuestions.map((question) => question.id),
    showUnitHeaders: units.length > 1,
    questionRevisions: questionRevisionMap(flatQuestions),
  };
}
