import type { MediaUploadResult } from "@tutor/contract";
export interface MediaPorts {
  postTeacherMediaApi(file: File): Promise<MediaUploadResult>;
}
