import type {
  Attachment,
  AttachmentListData,
  AttachmentUpdate,
  StudentAttachmentListData,
} from "@tutor/contract";
import type { UploadAttachmentOptions } from "./attachments-types";
export interface AttachmentsPorts {
  listAttachmentsApi(courseId?: string): Promise<AttachmentListData>;
  updateAttachmentApi(id: string, patch: AttachmentUpdate): Promise<Attachment>;
  deleteAttachmentApi(id: string): Promise<{
    id: string;
  }>;
  listStudentCourseAttachmentsApi(
    courseId: string,
  ): Promise<StudentAttachmentListData>;
  uploadAttachmentApi(
    file: File,
    options?: UploadAttachmentOptions,
  ): Promise<Attachment>;
}
