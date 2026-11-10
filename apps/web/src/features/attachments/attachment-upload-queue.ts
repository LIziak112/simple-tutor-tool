import type { Attachment, AttachmentVisibility } from "@tutor/contract";
import {
  ANSWER_LIKE_FILE_NAME,
  ATTACHMENT_MAX_UPLOAD_BYTES,
} from "@tutor/contract";

/**
 * 上传队列的纯模型（模块 6 第一步）：选文件 → 按入队顺序、最多 2 个同时上传
 * （进度 / 失败原因 / 重试 / 移除），与 React 组件分离便于单测。
 * - 选文件时就做两道本地预检（不等服务端）：超 20 MB、扩展名不是 .pdf/.docx
 *   直接记为失败并给原因（服务端仍按内容识别，本地只是少跑一趟）；预检失败的
 *   条目不持有文件、也不能重试（重试只会再失败一次）；
 * - 含答案提示：文件名像含答案（契约 ANSWER_LIKE_FILE_NAME）且默认可见性是
 *   「学生可见」时，这一条按「仅教师可见」上传并在行内说明，上传后可在列表里改回；
 * - 幂等键 uploadId 随条目生成、重试复用（#103-04）；
 * - 并发上限 MAX_CONCURRENT_UPLOADS（#103-05）：组件在队列变化时用 pickUploadsToStart
 *   补位；成功的条目用 completeItem 释放 File（只留文件名 / 大小 / 结果）。
 */
export type UploadItemStatus = "queued" | "uploading" | "done" | "failed";

/** 同时在传的请求数上限 */
export const MAX_CONCURRENT_UPLOADS = 2;

export interface UploadItem {
  readonly key: string;
  /** 上传幂等键（随请求发给服务端，重试复用；同键重放不会多建资料，#103-04） */
  readonly uploadId: string;
  /** 展示用（成功后 file 已释放，行里仍要显示名字与大小） */
  readonly fileName: string;
  readonly fileSize: number;
  /** 待上传 / 上传中 / 可重试的失败项持有原文件；成功或预检失败后为 null */
  readonly file: File | null;
  readonly visibility: AttachmentVisibility;
  /** 文件名像含答案、被自动改成仅教师可见 */
  readonly answerLike: boolean;
  readonly status: UploadItemStatus;
  /** 0–1 */
  readonly progress: number;
  readonly error: string | null;
  readonly result: Attachment | null;
}

const ACCEPTED_EXT = /\.(pdf|docx)$/i;

/** 本地预检：返回失败原因或 null */
export function localPrecheck(file: File): string | null {
  if (!ACCEPTED_EXT.test(file.name)) {
    return "只接受 PDF 与 Word（.docx）文件";
  }
  if (file.size > ATTACHMENT_MAX_UPLOAD_BYTES) {
    return "文件超过 20 MB 上传上限，请压缩或拆分后重试";
  }
  if (file.size === 0) return "文件是空的";
  return null;
}

export function makeUploadItem(
  file: File,
  defaultVisibility: AttachmentVisibility,
  key: string = crypto.randomUUID(),
  uploadId: string = crypto.randomUUID(),
): UploadItem {
  const answerLike =
    defaultVisibility === "students" && ANSWER_LIKE_FILE_NAME.test(file.name);
  const error = localPrecheck(file);
  return {
    key,
    uploadId,
    fileName: file.name,
    fileSize: file.size,
    file: error === null ? file : null,
    visibility: answerLike ? "teacher_only" : defaultVisibility,
    answerLike,
    status: error === null ? "queued" : "failed",
    progress: 0,
    error,
    result: null,
  };
}

export function patchItem(
  items: readonly UploadItem[],
  key: string,
  patch: Partial<
    Omit<UploadItem, "key" | "uploadId" | "fileName" | "fileSize">
  >,
): UploadItem[] {
  return items.map((item) => (item.key === key ? { ...item, ...patch } : item));
}

/**
 * 调度：在传的不足上限时，按入队顺序挑出可以开始的待上传条目（queued 且持有文件）。
 * 纯函数——组件拿到结果后逐个发请求并把状态改为 uploading。
 */
export function pickUploadsToStart(
  items: readonly UploadItem[],
  limit: number = MAX_CONCURRENT_UPLOADS,
): UploadItem[] {
  const uploading = items.filter((item) => item.status === "uploading").length;
  const slots = Math.max(0, limit - uploading);
  return items
    .filter((item) => item.status === "queued" && item.file !== null)
    .slice(0, slots);
}

/** 成功：记录结果、进度置满，并释放 File（不再占内存） */
export function completeItem(
  items: readonly UploadItem[],
  key: string,
  result: Attachment,
): UploadItem[] {
  return patchItem(items, key, {
    status: "done",
    progress: 1,
    error: null,
    result,
    file: null,
  });
}

/** 重试：只对仍持有文件的失败项生效——回到待上传，由调度在有空位时再发 */
export function retryItem(
  items: readonly UploadItem[],
  key: string,
): UploadItem[] {
  return items.map((item) =>
    item.key === key && item.status === "failed" && item.file !== null
      ? { ...item, status: "queued", progress: 0, error: null }
      : item,
  );
}

/** 文案：行内状态 */
export function uploadStatusText(item: UploadItem): string {
  switch (item.status) {
    case "queued":
      return "等待上传";
    case "uploading":
      return `上传中 ${Math.round(item.progress * 100)}%`;
    case "done":
      return "已上传";
    case "failed":
      return `上传失败：${item.error ?? "未知原因"}`;
  }
}
