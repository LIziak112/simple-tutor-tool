import type {
  Attachment,
  AttachmentListData,
  AttachmentUpdate,
  AttachmentUploadFields,
  StudentAttachmentListData,
} from "@tutor/contract";
import { attachmentSchema } from "@tutor/contract";
import { api, callApi } from "@/lib/api";
import { parseUploadResponse } from "@/lib/api-response";

/**
 * 资料附件（模块 6 第一步）前端 API：
 * - 上传走 XMLHttpRequest（fetch 没有上传进度事件）：onProgress 给 0–1 的比例，
 *   失败按统一壳解析成 ApiError（code + 中文 message），网络层失败给中文提示，
 *   可用 AbortSignal 取消；成功解析为契约 attachmentSchema；
 * - 列表 / 改可见性 / 软删 / 学生列表走 hc + callApi；
 * - 下载不经 JS：直接 <a href=attachmentFileUrl()> 让浏览器处理（Content-Disposition）。
 */
export function listAttachmentsApi(
  courseId?: string,
): Promise<AttachmentListData> {
  const args = { query: courseId === undefined ? {} : { courseId } };
  return callApi(() => api.api.teacher.attachments.$get(args));
}

export function updateAttachmentApi(
  id: string,
  patch: AttachmentUpdate,
): Promise<Attachment> {
  const args = { param: { id }, json: patch };
  return callApi(() => api.api.teacher.attachments[":id"].$patch(args));
}

export function deleteAttachmentApi(id: string): Promise<{ id: string }> {
  const args = { param: { id } };
  return callApi(() => api.api.teacher.attachments[":id"].$delete(args));
}

export function listStudentCourseAttachmentsApi(
  courseId: string,
): Promise<StudentAttachmentListData> {
  const args = { param: { id: courseId } };
  return callApi(() => api.api.student.courses[":id"].attachments.$get(args));
}

export interface UploadAttachmentOptions extends AttachmentUploadFields {
  /** 上传进度（已发送字节 / 总字节，0–1）；不可用时不回调 */
  onProgress?: ((ratio: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}

const NETWORK_ERROR_MESSAGE =
  "连不上服务器，请检查网络后重试（已选的文件不会丢，可直接重试）";

export function uploadAttachmentApi(
  file: File,
  options: UploadAttachmentOptions = {},
): Promise<Attachment> {
  return new Promise<Attachment>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file, file.name);
    if (options.courseId !== undefined)
      form.append("courseId", options.courseId);
    if (options.visibility !== undefined) {
      form.append("visibility", options.visibility);
    }
    // 幂等键（#103-04）：重试带同一个，服务端同键重放返回既有资料（200）而不是再建一份
    if (options.uploadId !== undefined)
      form.append("uploadId", options.uploadId);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/teacher/attachments");
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onload = () => {
      try {
        resolve(
          parseUploadResponse(
            xhr.status,
            xhr.responseText,
            attachmentSchema,
            "服务器返回的资料信息不完整，请刷新后查看",
          ),
        );
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error(NETWORK_ERROR_MESSAGE));
    xhr.ontimeout = () => reject(new Error(NETWORK_ERROR_MESSAGE));
    xhr.onabort = () => {
      const err = new Error("已取消上传");
      err.name = "AbortError";
      reject(err);
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        xhr.abort();
        return;
      }
      options.signal.addEventListener("abort", () => xhr.abort(), {
        once: true,
      });
    }
    xhr.send(form);
  });
}
