/** 作答服务兼容入口。实现按生命周期和读侧职责组织，既有调用方沿用此导出路径。 */

export {
  assertRowNotSubmitted,
  assignmentReleaseByIds,
  buildAttemptQuestionWhere,
  lessonQuestionSubmitted,
  questionNotFound,
  requireAttemptQuestion,
  requireAttemptQuestionRow,
  requireAttemptQuestions,
  requireOwnAttempt,
  requireUsableAttempt,
} from "./attempt-access.ts";
export { saveDraftAnswer, setStudentFlag } from "./attempt-answer.ts";
export {
  detailOfAuthorizedAttempt,
  getAttemptDetail,
  getAttemptMaterialRevisions,
  getStudentAttemptPaper,
} from "./attempt-detail.ts";
export {
  attemptFinalOutcomeOf,
  finalScoreOf,
} from "./attempt-final-outcome.ts";
export {
  attemptResponseRows,
  ensureAttemptFrozen,
  type FrozenResponseInsert,
  freezeInputsOfNewAttempt,
  insertFrozenResponse,
  insertFrozenResponses,
  questionOfRow,
} from "./attempt-freeze.ts";
export {
  getPracticeQuestionFeedback,
  practiceQuestionFeedbackOf,
  practiceQuestionFeedbackStateOf,
} from "./attempt-question-feedback.ts";
export {
  assertFrozenAnswerShape,
  materialSlotOrderOf,
  publicOfSnapshot,
  resultQuestionOf,
  structuresOfSnapshot,
  studentFacingResultOf,
} from "./attempt-question-projection.ts";
export {
  attemptQuestionRows,
  attemptTeacherId,
  attemptUnitIds,
} from "./attempt-question-set.ts";
export {
  submitLessonQuestion,
  submitPracticeQuestion,
} from "./attempt-question-submit.ts";
export {
  attemptEnabledCapabilities,
  attemptSourceMeta,
  type FrozenRowEntry,
  frozenRowsInDisplayOrder,
  type GroupedSnapshotRows,
  groupedSnapshotRows,
  lessonSourceContextOf,
  UNGROUPED_TITLE,
  type UnitGroupedRows,
  unitGroupedRows,
  WRONG_PRACTICE_TITLE,
} from "./attempt-rows.ts";
export {
  attemptScoreSummaryOf,
  lessonLiveSummaryOf,
  type ScoreSummaryRow,
  scoreSummaryCoreOf,
} from "./attempt-score-summary.ts";
export {
  type AttemptWorkflowStartOptions,
  startAttempt,
  startCourseAttempt,
  workflowStartColumns,
} from "./attempt-start.ts";
export { attemptSummaryOf } from "./attempt-summary.ts";
export { submitAttempt } from "./attempt-whole-submit.ts";
export { newDraftAttempt } from "./new-draft-attempt.ts";
export { answersReleased } from "./practice-workflow-service";
export {
  effectiveVerdictOfRow,
  selfReviewRecordOf,
  teacherMarkOf,
} from "./response-verdict.ts";
export { answerOf } from "./snapshot";
