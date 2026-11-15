import {
  type AttemptActivateData,
  type AttemptActivateRequest,
  type AttemptAnswerSaveData,
  type AttemptAnswerSaveRequest,
  type AttemptDetailData,
  type AttemptFlagData,
  type AttemptOpenedQuery,
  type AttemptStartData,
  type AttemptSummary,
  type AttemptWorkflowUpdateData,
  type AttemptWriteProof,
  attemptFlagDataSchema,
  type CourseAttemptStartOptions,
  type PracticeWorkflowStartOptions,
  type PracticeWorkflowUpdateRequest,
  type StudentFlag,
  type StudentUnitLandingData,
  type WrongPracticeScope,
} from "@tutor/contract";
import {
  assertDraftEpoch,
  protectOpenedDraft,
} from "@/features/persistence/attempt-local-session";
import { getDraftSessionEpoch } from "@/features/persistence/draft-store";
import { callApi } from "@/lib/api-response";
import { readAttemptDetail } from "@/lib/attempt-detail-read";
import { withRequestDeadline } from "@/lib/request-deadline";
import { requestAttemptActivation } from "./attempt-write-activation";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createPracticeClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchOpenedAttemptApi(
    query: AttemptOpenedQuery,
  ): Promise<{ attempt: AttemptSummary | null }> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) search.set(key, value);
    return withRequestDeadline(
      (signal) =>
        callApi(() =>
          http.fetch(`/api/student/attempts/opened?${search}`, { signal }),
        ),
      "打开练习前核对本机稿",
    );
  }
  async function activateAttemptApi(
    attemptId: string,
    request: AttemptActivateRequest,
  ): Promise<AttemptActivateData> {
    return requestAttemptActivation(http, attemptId, request);
  }
  async function protectSource(query: AttemptOpenedQuery): Promise<void> {
    const epoch = getDraftSessionEpoch();
    const opened = await fetchOpenedAttemptApi(query);
    assertDraftEpoch(epoch);
    await protectOpenedDraft(
      opened.attempt,
      activateAttemptApi,
      fetchAttemptApi,
    );
    assertDraftEpoch(epoch);
  }
  async function startAttemptApi(
    assignmentId: string,
    options?: PracticeWorkflowStartOptions,
  ): Promise<AttemptStartData> {
    await protectSource({ sourceType: "assignment", assignmentId });
    return callApi(() =>
      api.api.student.assignments[":id"].attempt.$post({
        param: { id: assignmentId },
        ...(options !== undefined ? { json: { ...options } } : {}),
      }),
    );
  }
  function fetchStudentUnitLandingApi(
    courseId: string,
    unitId: string,
  ): Promise<StudentUnitLandingData> {
    return callApi(() =>
      api.api.student.courses[":id"].units[":unitId"].$get({
        param: { id: courseId, unitId },
      }),
    );
  }
  async function startCourseAttemptApi(
    courseId: string,
    unitId: string,
    options?: CourseAttemptStartOptions,
  ): Promise<AttemptStartData> {
    if (options?.restartAttemptId === undefined)
      await protectSource({ sourceType: "course", courseId, unitId });
    return callApi(() =>
      api.api.student.courses[":id"].units[":unitId"].attempts.$post({
        param: { id: courseId, unitId },
        ...(options !== undefined ? { json: { ...options } } : {}),
      }),
    );
  }
  function startWrongPracticeApi(
    questionIds: string[],
    options?: PracticeWorkflowStartOptions,
    /** 建卷范围快照（#6980-2）：随卷落库，记录/轮次史标题「练的是什么」 */
    scope?: WrongPracticeScope,
    operationId?: string,
  ): Promise<AttemptStartData> {
    const args = {
      json: {
        questionIds,
        ...(options !== undefined ? { ...options } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(operationId !== undefined ? { operationId } : {}),
      },
    };
    return callApi(() => api.api.student["wrong-practice"].$post(args));
  }
  function saveAttemptAnswerApi(
    attemptId: string,
    questionId: string,
    answer: AttemptAnswerSaveRequest["answer"],
    sync?: Pick<
      AttemptAnswerSaveRequest,
      "baseRevision" | "mutationId" | "questionRevisionId" | "expectedFrozenAt"
    >,
  ): Promise<AttemptAnswerSaveData> {
    const args = {
      param: { id: attemptId, questionId },
      json: { answer, ...sync },
    };
    return withRequestDeadline(
      (signal) =>
        callApi(() =>
          api.api.student.attempts[":id"].answers[":questionId"].$put(args, {
            init: { signal },
          }),
        ),
      "保存答案",
    );
  }
  function setStudentFlagApi(
    attemptId: string,
    questionId: string,
    flag: StudentFlag | null,
    proof?: AttemptWriteProof,
  ): Promise<AttemptFlagData> {
    const args = {
      param: { id: attemptId, questionId },
      json: { flag, ...proof },
    };
    return callApi(() =>
      api.api.student.attempts[":id"].flags[":questionId"].$put(args),
    ).then((data) => attemptFlagDataSchema.parse(data));
  }
  function fetchAttemptApi(
    attemptId: string,
    signal?: AbortSignal,
    cached?: AttemptDetailData,
  ): Promise<AttemptDetailData> {
    return readAttemptDetail(
      attemptId,
      signal,
      cached,
      (init) =>
        api.api.student.attempts[":id"].$get(
          { param: { id: attemptId } },
          { init },
        ),
      callApi,
    );
  }
  function updateAttemptWorkflowApi(
    attemptId: string,
    input: PracticeWorkflowUpdateRequest,
  ): Promise<AttemptWorkflowUpdateData> {
    // 沿用 updateCourseApi 等既有 $patch 模式：服务端路由为纯 handler（无
    // zValidator），hc 静态输入不含 json，内联字面量会触发多余属性检查——
    // 提为变量绕过（json 类型安全由入参 PracticeWorkflowUpdateRequest 契约
    // 类型保证），运行时 hc 正常序列化 json 请求体。
    const args = { param: { id: attemptId }, json: input };
    return callApi(() => api.api.student.attempts[":id"].workflow.$patch(args));
  }
  return {
    fetchOpenedAttemptApi,
    activateAttemptApi,
    startAttemptApi,
    fetchStudentUnitLandingApi,
    startCourseAttemptApi,
    startWrongPracticeApi,
    saveAttemptAnswerApi,
    setStudentFlagApi,
    fetchAttemptApi,
    updateAttemptWorkflowApi,
  };
}
