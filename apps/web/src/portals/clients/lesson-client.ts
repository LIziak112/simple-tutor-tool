import type {
  LessonLandingData,
  LessonQuestionSubmitData,
  LessonQuestionSubmitRequest,
  LessonStartData,
  PracticeQuestionFeedbackData,
  PracticeQuestionSubmitData,
  PracticeQuestionSubmitRequest,
  SelfReviewData,
  SelfReviewRequest,
} from "@tutor/contract";
import {
  assertDraftEpoch,
  protectOpenedDraft,
} from "@/features/persistence/attempt-local-session";
import { getDraftSessionEpoch } from "@/features/persistence/draft-store";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createLessonClient(
  http: HttpRuntime,
  deps: () => ClientServices,
) {
  const { api } = http;
  function fetchLessonLandingApi(
    lectureId: string,
    courseId?: string | undefined,
  ): Promise<LessonLandingData> {
    const args = {
      param: { id: lectureId },
      ...(courseId !== undefined ? { query: { courseId } } : {}),
    };
    return callApi(() =>
      api.api.student.lectures[":id"].lesson.landing.$get(args),
    );
  }
  async function startLessonAttemptApi(
    lectureId: string,
    courseId?: string | undefined,
  ): Promise<LessonStartData> {
    const epoch = getDraftSessionEpoch();
    const clients = deps();
    const opened = await clients.fetchOpenedAttemptApi({
      sourceType: "lesson",
      lectureId,
      ...(courseId ? { courseId } : {}),
    });
    assertDraftEpoch(epoch);
    await protectOpenedDraft(
      opened.attempt,
      clients.activateAttemptApi,
      clients.fetchAttemptApi,
    );
    assertDraftEpoch(epoch);
    const args = {
      param: { id: lectureId },
      ...(courseId !== undefined ? { query: { courseId } } : {}),
    };
    return callApi(() =>
      api.api.student.lectures[":id"].lesson.start.$post(args),
    );
  }
  function submitLessonQuestionApi(
    attemptId: string,
    questionId: string,
    request: LessonQuestionSubmitRequest,
  ): Promise<LessonQuestionSubmitData> {
    const args = { param: { id: attemptId, questionId }, json: request };
    return callApi(() =>
      api.api.student.attempts[":id"].questions[":questionId"].submit.$post(
        args,
      ),
    );
  }
  function submitPracticeQuestionApi(
    attemptId: string,
    questionId: string,
    request: PracticeQuestionSubmitRequest,
  ): Promise<PracticeQuestionSubmitData> {
    const args = { param: { id: attemptId, questionId }, json: request };
    return callApi(() =>
      api.api.student.attempts[":id"].questions[":questionId"].submit.$post(
        args,
      ),
    );
  }
  function fetchPracticeQuestionFeedbackApi(
    attemptId: string,
    questionId: string,
  ): Promise<PracticeQuestionFeedbackData> {
    return callApi(() =>
      api.api.student.attempts[":id"].questions[":questionId"].feedback.$get({
        param: { id: attemptId, questionId },
      }),
    );
  }
  function saveSelfReviewApi(
    attemptId: string,
    questionId: string,
    request: SelfReviewRequest,
  ): Promise<SelfReviewData> {
    const args = { param: { id: attemptId, questionId }, json: request };
    return callApi(() =>
      api.api.student.attempts[":id"].questions[":questionId"][
        "self-review"
      ].$post(args),
    );
  }
  return {
    fetchLessonLandingApi,
    startLessonAttemptApi,
    submitLessonQuestionApi,
    submitPracticeQuestionApi,
    fetchPracticeQuestionFeedbackApi,
    saveSelfReviewApi,
  };
}
