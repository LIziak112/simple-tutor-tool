import {
  type AttemptAnswerSaveData,
  type AttemptAnswerSaveRequest,
  type AttemptDetailData,
  type AttemptFlagData,
  type AttemptStartData,
  type AttemptWorkflowUpdateData,
  attemptFlagDataSchema,
  type CourseAttemptStartOptions,
  type PracticeWorkflowStartOptions,
  type PracticeWorkflowUpdateRequest,
  type StudentFlag,
  type StudentUnitLandingData,
  type WrongPracticeScope,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import { readAttemptDetail } from "@/lib/attempt-detail-read";
import { withRequestDeadline } from "@/lib/request-deadline";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createPracticeClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function startAttemptApi(
    assignmentId: string,
    options?: PracticeWorkflowStartOptions,
  ): Promise<AttemptStartData> {
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
  function startCourseAttemptApi(
    courseId: string,
    unitId: string,
    options?: CourseAttemptStartOptions,
  ): Promise<AttemptStartData> {
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
    sync?: Pick<AttemptAnswerSaveRequest, "baseRevision" | "mutationId">,
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
  ): Promise<AttemptFlagData> {
    const args = {
      param: { id: attemptId, questionId },
      json: { flag },
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
