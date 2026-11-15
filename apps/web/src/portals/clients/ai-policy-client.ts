import type {
  AiPolicyInheritableMode,
  AiPolicyOverrideData,
  AiPromptSettingsData,
  AiPromptSettingsPutRequest,
  AiTeacherAttemptRecordsData,
  AiTeacherSettingsData,
  AiTeacherSettingsPutRequest,
  AiTeacherTaskDetailData,
  CapabilityProfile,
  StudentQuickButtonsData,
  StudentQuickButtonsPutRequest,
  TeacherPracticeFeedbackSettings,
  TeacherPracticeFeedbackSettingsUpdateRequest,
} from "@tutor/contract";
import type { AiPolicySubjectRef } from "@/features/runtime/client-types";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createAiPolicyClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchCapabilityProfile(): Promise<CapabilityProfile> {
    return callApi(() => api.api.teacher.settings["capability-profile"].$get());
  }
  function saveCapabilityProfile(
    profile: CapabilityProfile,
  ): Promise<CapabilityProfile> {
    return callApi(() =>
      api.api.teacher.settings["capability-profile"].$put({ json: profile }),
    );
  }
  function fetchPracticeFeedbackSettings(): Promise<TeacherPracticeFeedbackSettings> {
    return callApi(() => api.api.teacher.settings["practice-feedback"].$get());
  }
  function savePracticeFeedbackSettings(
    request: TeacherPracticeFeedbackSettingsUpdateRequest,
  ): Promise<TeacherPracticeFeedbackSettings> {
    return callApi(() =>
      api.api.teacher.settings["practice-feedback"].$put({ json: request }),
    );
  }
  function fetchTeacherAiSettingsApi(): Promise<AiTeacherSettingsData> {
    return callApi(() => api.api.teacher.ai.settings.$get());
  }
  function saveTeacherAiSettingsApi(
    request: AiTeacherSettingsPutRequest,
  ): Promise<AiTeacherSettingsData> {
    return callApi(() => api.api.teacher.ai.settings.$put({ json: request }));
  }
  function fetchTeacherAiPromptsApi(): Promise<AiPromptSettingsData> {
    return callApi(() => api.api.teacher.ai.prompts.$get());
  }
  function saveTeacherAiPromptsApi(
    request: AiPromptSettingsPutRequest,
  ): Promise<AiPromptSettingsData> {
    return callApi(() => api.api.teacher.ai.prompts.$put({ json: request }));
  }
  function fetchStudentAiPromptsApi(): Promise<AiPromptSettingsData> {
    return callApi(() => api.api.student.ai.prompts.$get());
  }
  function saveStudentAiPromptsApi(
    request: AiPromptSettingsPutRequest,
  ): Promise<AiPromptSettingsData> {
    return callApi(() => api.api.student.ai.prompts.$put({ json: request }));
  }
  function fetchAiPolicyOverrideApi(
    subject: AiPolicySubjectRef,
  ): Promise<AiPolicyOverrideData> {
    return callApi(() =>
      subject.type === "student"
        ? api.api.teacher.students[":id"]["ai-policy"].$get({
            param: { id: subject.id },
          })
        : api.api.teacher.assignments[":id"]["ai-policy"].$get({
            param: { id: subject.id },
          }),
    );
  }
  function putAiPolicyOverrideApi(
    subject: AiPolicySubjectRef,
    mode: AiPolicyInheritableMode,
  ): Promise<AiPolicyOverrideData> {
    // json 以独立变量传入的原因同 updateQuestion（parseJsonBodyWithCode 服务端
    // 校验分流错误码，hc 类型无 json 槽，运行时仍会序列化 args.json）
    const args = { param: { id: subject.id }, json: { mode } };
    return callApi(() =>
      subject.type === "student"
        ? api.api.teacher.students[":id"]["ai-policy"].$put(args)
        : api.api.teacher.assignments[":id"]["ai-policy"].$put(args),
    );
  }
  function fetchTeacherAttemptAiRecordsApi(
    attemptId: string,
  ): Promise<AiTeacherAttemptRecordsData> {
    return callApi(() =>
      api.api.teacher.attempts[":id"]["ai-records"].$get({
        param: { id: attemptId },
      }),
    );
  }
  function fetchTeacherAiTaskDetailApi(
    taskId: string,
  ): Promise<AiTeacherTaskDetailData> {
    return callApi(() =>
      api.api.teacher.ai.tasks[":id"].$get({ param: { id: taskId } }),
    );
  }
  function teacherAiTaskMaterialPngUrl(
    taskId: string,
    materialId: string,
  ): string {
    return `/api/teacher/ai/tasks/${encodeURIComponent(taskId)}/materials/${encodeURIComponent(materialId)}/image.png`;
  }
  function fetchStudentQuickButtonsApi(): Promise<StudentQuickButtonsData> {
    return callApi(() => api.api.student.ai["quick-buttons"].$get());
  }
  function saveStudentQuickButtonsApi(
    request: StudentQuickButtonsPutRequest,
  ): Promise<StudentQuickButtonsData> {
    // json 独立变量：hc 覆盖 PUT 的 json 槽惯例（同 putAiPolicyOverride）
    const args = { json: request };
    return callApi(() => api.api.student.ai["quick-buttons"].$put(args));
  }
  return {
    fetchCapabilityProfile,
    saveCapabilityProfile,
    fetchPracticeFeedbackSettings,
    savePracticeFeedbackSettings,
    fetchTeacherAiSettingsApi,
    saveTeacherAiSettingsApi,
    fetchTeacherAiPromptsApi,
    saveTeacherAiPromptsApi,
    fetchStudentAiPromptsApi,
    saveStudentAiPromptsApi,
    fetchAiPolicyOverrideApi,
    putAiPolicyOverrideApi,
    fetchTeacherAttemptAiRecordsApi,
    fetchTeacherAiTaskDetailApi,
    teacherAiTaskMaterialPngUrl,
    fetchStudentQuickButtonsApi,
    saveStudentQuickButtonsApi,
  };
}
