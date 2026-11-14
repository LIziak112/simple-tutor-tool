import type {
  ImportCommitData,
  SharedFileList,
  SharedImportRequest,
  SharedPreviewData,
  SharedPreviewRequest,
  SharedPublishData,
} from "@tutor/contract";
export interface SharedPorts {
  fetchSharedFiles(): Promise<SharedFileList>;
  publishUnitToSharedApi(id: string): Promise<SharedPublishData>;
  publishLectureToSharedApi(id: string): Promise<SharedPublishData>;
  previewSharedFile(request: SharedPreviewRequest): Promise<SharedPreviewData>;
  importSharedFile(request: SharedImportRequest): Promise<ImportCommitData>;
  deleteSharedFileApi(filename: string): Promise<null>;
  fetchAdminSharedFiles(): Promise<SharedFileList>;
  deleteAdminSharedFileApi(filename: string): Promise<null>;
}
