import type {
  AttemptEvent,
  LearningEventBatchData,
  LectureEvent,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import { withRequestDeadline } from "@/lib/request-deadline";
import type { HttpRuntime } from "./http-runtime";
export function createEventsClient(http: HttpRuntime) {
  const { api } = http;
  function postAttemptEventsApi(
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
  function postLectureEventsApi(
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
  return { postAttemptEventsApi, postLectureEventsApi };
}
