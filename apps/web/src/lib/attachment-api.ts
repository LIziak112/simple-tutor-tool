import { defaultClientServices } from "@/portals/clients/default-services";

export type * from "@/features/runtime/ports/attachments-types";
export const listAttachmentsApi = defaultClientServices.listAttachmentsApi;
export const updateAttachmentApi = defaultClientServices.updateAttachmentApi;
export const deleteAttachmentApi = defaultClientServices.deleteAttachmentApi;
export const listStudentCourseAttachmentsApi =
  defaultClientServices.listStudentCourseAttachmentsApi;
export const uploadAttachmentApi = defaultClientServices.uploadAttachmentApi;
