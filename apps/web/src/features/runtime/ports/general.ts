import type {
  ContentTree,
  ImportBatchData,
  ImportCommitData,
  ImportCommitRequest,
  ImportPreviewBatchData,
  ImportPreviewBatchRequest,
  ImportPreviewData,
  ImportPreviewRequest,
  PublicConfigData,
  SpecFileName,
  TeacherInfo,
  TeacherLoginRequest,
  TeacherRegisterRequest,
  TeacherSetupRequest,
  TeacherStatusData,
} from "@tutor/contract";
import type { HealthData } from "@/features/runtime/client-types";
export interface GeneralPorts {
  fetchHealth(): Promise<HealthData>;
  saveBlobAs(blob: Blob, filename: string): void;
  fetchTeacherStatus(): Promise<TeacherStatusData>;
  fetchPublicConfig(): Promise<PublicConfigData>;
  fetchSpecFile(file: SpecFileName): Promise<string>;
  setupTeacher(request: TeacherSetupRequest): Promise<TeacherInfo>;
  loginTeacher(
    request: TeacherLoginRequest,
  ): Promise<import("@tutor/contract").TeacherLoginData>;
  registerTeacher(request: TeacherRegisterRequest): Promise<TeacherInfo>;
  logoutTeacher(): Promise<null>;
  fetchTeacherMe(): Promise<TeacherInfo>;
  fetchContentTree(): Promise<ContentTree>;
  previewImport(request: ImportPreviewRequest): Promise<ImportPreviewData>;
  commitImport(request: ImportCommitRequest): Promise<ImportCommitData>;
  previewImportBatch(
    request: ImportPreviewBatchRequest,
  ): Promise<ImportPreviewBatchData>;
  fetchImportBatch(batchId: string): Promise<ImportBatchData>;
}
