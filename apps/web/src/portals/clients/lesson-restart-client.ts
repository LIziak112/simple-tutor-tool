import type { LessonRestartRequest, LessonStartData } from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import { SNAPSHOT_PROOF_CLIENT } from "./attempt-write-activation";
import type { HttpRuntime } from "./http-runtime";
export function createLessonRestartClient(http: HttpRuntime) {
  const { api } = http;
  function restartLessonAttemptApi(
    lectureId: string,
    request?: LessonRestartRequest,
  ): Promise<LessonStartData> {
    const args = {
      param: { id: lectureId },
      ...(request && { json: request }),
    };
    return callApi(() =>
      api.api.student.lectures[":id"].lesson.restart.$post(
        args,
        SNAPSHOT_PROOF_CLIENT,
      ),
    );
  }
  return { restartLessonAttemptApi };
}
