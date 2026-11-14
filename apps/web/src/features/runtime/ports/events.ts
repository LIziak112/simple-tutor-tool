import type {
  AttemptEvent,
  LearningEventBatchData,
  LectureEvent,
} from "@tutor/contract";
export interface EventsPorts {
  postAttemptEventsApi(
    attemptId: string,
    events: readonly AttemptEvent[],
    viewId?: string,
  ): Promise<LearningEventBatchData>;
  postLectureEventsApi(
    events: readonly LectureEvent[],
  ): Promise<LearningEventBatchData>;
}
