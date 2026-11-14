import type {
  AttemptActivateData,
  AttemptActivateRequest,
  AttemptAnswerSaveData,
  AttemptAnswerSaveRequest,
  AttemptDetailData,
  AttemptFlagData,
  AttemptOpenedQuery,
  AttemptStartData,
  AttemptSummary,
  AttemptWorkflowUpdateData,
  CourseAttemptStartOptions,
  PracticeWorkflowStartOptions,
  PracticeWorkflowUpdateRequest,
  StudentFlag,
  StudentUnitLandingData,
  WrongPracticeScope,
} from "@tutor/contract";
export interface PracticePorts {
  fetchOpenedAttemptApi(
    query: AttemptOpenedQuery,
  ): Promise<{ attempt: AttemptSummary | null }>;
  activateAttemptApi(
    attemptId: string,
    request: AttemptActivateRequest,
  ): Promise<AttemptActivateData>;
  startAttemptApi(
    assignmentId: string,
    options?: PracticeWorkflowStartOptions,
  ): Promise<AttemptStartData>;
  fetchStudentUnitLandingApi(
    courseId: string,
    unitId: string,
  ): Promise<StudentUnitLandingData>;
  startCourseAttemptApi(
    courseId: string,
    unitId: string,
    options?: CourseAttemptStartOptions,
  ): Promise<AttemptStartData>;
  startWrongPracticeApi(
    questionIds: string[],
    options?: PracticeWorkflowStartOptions,
    /** 建卷范围快照（#6980-2）：随卷落库，记录/轮次史标题「练的是什么」 */
    scope?: WrongPracticeScope,
    operationId?: string,
  ): Promise<AttemptStartData>;
  saveAttemptAnswerApi(
    attemptId: string,
    questionId: string,
    answer: AttemptAnswerSaveRequest["answer"],
    sync?: Pick<
      AttemptAnswerSaveRequest,
      "baseRevision" | "mutationId" | "questionRevisionId" | "expectedFrozenAt"
    >,
  ): Promise<AttemptAnswerSaveData>;
  setStudentFlagApi(
    attemptId: string,
    questionId: string,
    flag: StudentFlag | null,
  ): Promise<AttemptFlagData>;
  fetchAttemptApi(
    attemptId: string,
    signal?: AbortSignal,
    cached?: AttemptDetailData,
  ): Promise<AttemptDetailData>;
  updateAttemptWorkflowApi(
    attemptId: string,
    input: PracticeWorkflowUpdateRequest,
  ): Promise<AttemptWorkflowUpdateData>;
}
