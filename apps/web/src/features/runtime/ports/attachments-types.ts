import type { AttachmentUploadFields } from "@tutor/contract";
export interface UploadAttachmentOptions extends AttachmentUploadFields {
  /** 上传进度（已发送字节 / 总字节，0–1）；不可用时不回调 */
  onProgress?: ((ratio: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}
