import type { Attachment, AttachmentVisibility } from "@tutor/contract";
import {
  ANSWER_LIKE_FILE_NAME,
  ATTACHMENT_MAX_UPLOAD_BYTES,
} from "@tutor/contract";

/**
 * 上传队列的纯模型（模块 6 第一步）：选文件 → 逐个上传（进度 / 失败原因 / 重试 /
 * 移除），与 React 组件分离便于单测。
 * - 选文件时就做两道本地预检（不等服务端）：超 20 MB、扩展名不是 .pdf/.docx
 *   直接记为失败并给原因（服务端仍按内容识别，本地只是少跑一趟）；
 * - 含答案提示：文件名像含答案（契约 ANSWER_LIKE_FILE_NAME）且默认可见性是
 *   「学生可见」时，这一条按「仅教师可见」上传并在行内说明，上传后可在列表里改回。
 */
export type UploadItemStatus = "queued" | "uploading" | "done" | "failed";

export interface UploadItem {
  readonly key: string;
  readonly file: File;
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
): UploadItem {
  const answerLike =
    defaultVisibility === "students" && ANSWER_LIKE_FILE_NAME.test(file.name);
  const error = localPrecheck(file);
  return {
    key,
    file,
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
  patch: Partial<Omit<UploadItem, "key" | "file">>,
): UploadItem[] {
  return items.map((item) => (item.key === key ? { ...item, ...patch } : item));
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
