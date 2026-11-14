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
export interface AiPolicyPorts {
  fetchCapabilityProfile(): Promise<CapabilityProfile>;
  saveCapabilityProfile(profile: CapabilityProfile): Promise<CapabilityProfile>;
  fetchPracticeFeedbackSettings(): Promise<TeacherPracticeFeedbackSettings>;
  savePracticeFeedbackSettings(
    request: TeacherPracticeFeedbackSettingsUpdateRequest,
  ): Promise<TeacherPracticeFeedbackSettings>;
  fetchTeacherAiSettingsApi(): Promise<AiTeacherSettingsData>;
  saveTeacherAiSettingsApi(
    request: AiTeacherSettingsPutRequest,
  ): Promise<AiTeacherSettingsData>;
  fetchTeacherAiPromptsApi(): Promise<AiPromptSettingsData>;
  saveTeacherAiPromptsApi(
    request: AiPromptSettingsPutRequest,
  ): Promise<AiPromptSettingsData>;
  fetchStudentAiPromptsApi(): Promise<AiPromptSettingsData>;
  saveStudentAiPromptsApi(
    request: AiPromptSettingsPutRequest,
  ): Promise<AiPromptSettingsData>;
  fetchAiPolicyOverrideApi(
    subject: AiPolicySubjectRef,
  ): Promise<AiPolicyOverrideData>;
  putAiPolicyOverrideApi(
    subject: AiPolicySubjectRef,
    mode: AiPolicyInheritableMode,
  ): Promise<AiPolicyOverrideData>;
  fetchTeacherAttemptAiRecordsApi(
    attemptId: string,
  ): Promise<AiTeacherAttemptRecordsData>;
  fetchTeacherAiTaskDetailApi(taskId: string): Promise<AiTeacherTaskDetailData>;
  teacherAiTaskMaterialPngUrl(taskId: string, materialId: string): string;
  fetchStudentQuickButtonsApi(): Promise<StudentQuickButtonsData>;
  saveStudentQuickButtonsApi(
    request: StudentQuickButtonsPutRequest,
  ): Promise<StudentQuickButtonsData>;
}
