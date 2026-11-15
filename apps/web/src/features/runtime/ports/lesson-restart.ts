import type { LessonRestartRequest, LessonStartData } from "@tutor/contract";
export interface LessonRestartPorts {
  restartLessonAttemptApi(
    lectureId: string,
    request?: LessonRestartRequest,
  ): Promise<LessonStartData>;
}
