import type {
  AttemptEvent,
  LearningEventBatchData,
  LectureEvent,
} from "@tutor/contract";
import { api, callApi } from "./api";
import { withRequestDeadline } from "./request-deadline";

/** 作答页会话标识用于区分多端重叠的活动。 */
export function postAttemptEventsApi(
  attemptId: string,
  events: readonly AttemptEvent[],
  viewId?: string,
): Promise<LearningEventBatchData> {
  const args = {
    param: { id: attemptId },
    json: { events: [...events], ...(viewId && { viewId }) },
  };
  return withRequestDeadline(
    (signal) =>
      callApi(() =>
        api.api.student.attempts[":id"].events.$post(args, {
          init: { signal },
        }),
      ),
    "上报作答过程",
  );
}

export function postLectureEventsApi(
  events: readonly LectureEvent[],
): Promise<LearningEventBatchData> {
  return withRequestDeadline(
    (signal) =>
      callApi(() =>
        api.api.student.events.$post(
          { json: { events: [...events] } },
          { init: { signal } },
        ),
      ),
    "上报阅读过程",
  );
}
