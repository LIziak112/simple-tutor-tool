import type { LessonRestartRequest, LessonStartData } from "@tutor/contract";
import { api, callApi } from "./api";

export function restartLessonAttemptApi(
  lectureId: string,
  request?: LessonRestartRequest,
): Promise<LessonStartData> {
  const args = { param: { id: lectureId }, ...(request && { json: request }) };
  return callApi(() =>
    api.api.student.lectures[":id"].lesson.restart.$post(args),
  );
}
