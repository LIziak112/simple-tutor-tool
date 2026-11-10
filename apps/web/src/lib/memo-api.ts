import type {
  Memo,
  MemoCreateMedia,
  MemoCreateText,
  MemoListData,
  MemoListQuery,
} from "@tutor/contract";
import { apiResponseSchema, memoSchema } from "@tutor/contract";
import { ApiError, api, callApi } from "@/lib/api";

/**
 * 随笔（模块 5 第一步）前端 API：
 * - 文字创建 / 列表 / 软删走 hc + callApi；
 * - 媒体上传（语音 / 图片 / 手写 PNG）走 XMLHttpRequest（要上传进度；与
 *   attachment-api 同款解析：统一壳 → ApiError，网络层失败给中文提示）；
 * - 媒体播放 / 显示不经 JS：<audio src> / <img src> 直接引用 memoMediaUrl()。
 * 幂等：服务端按 (学生, clientId) 去重——离线补传重放拿回同一条，不会产生重复。
 */
export function listMemosApi(query: MemoListQuery = {}): Promise<MemoListData> {
  const entries = Object.entries(query).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined,
  );
  const args = {
    query: Object.fromEntries(
      entries.map(([key, value]) => [key, String(value)]),
    ),
  };
  return callApi(() => api.api.student.memos.$get(args));
}

export function createTextMemoApi(input: MemoCreateText): Promise<Memo> {
  return callApi(() => api.api.student.memos.$post({ json: input }));
}

export function deleteMemoApi(id: string): Promise<{ id: string }> {
  const args = { param: { id } };
  return callApi(() => api.api.student.memos[":id"].$delete(args));
}

export interface UploadMemoMediaOptions {
  onProgress?: ((ratio: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/** 网络层失败（离线 / 超时）：调用方据 name 判断是否留在待补传队列 */
export class MemoNetworkError extends Error {
  constructor() {
    super("连不上服务器，这条随笔已存在本机，联网后会自动补传");
    this.name = "MemoNetworkError";
  }
}

function parseMemoResponse(status: number, text: string): Memo {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`服务器响应异常（HTTP ${status}），请稍后重试`);
  }
  const parsed = apiResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`服务器响应异常（HTTP ${status}），请稍后重试`);
  }
  if (!parsed.data.ok) {
    throw new ApiError(parsed.data.error, parsed.data.message, status);
  }
  const data = memoSchema.safeParse(parsed.data.data);
  if (!data.success) {
    throw new Error("服务器返回的随笔信息不完整，请刷新后查看");
  }
  return data.data;
}

/** 媒体随笔上传：file + 文本字段（anchor / tags 以 JSON 串入 multipart） */
export function uploadMemoMediaApi(
  blob: Blob,
  fields: MemoCreateMedia,
  options: UploadMemoMediaOptions = {},
): Promise<Memo> {
  return new Promise<Memo>((resolve, reject) => {
    const form = new FormData();
    form.append("file", blob, `${fields.kind}.bin`);
    form.append("clientId", fields.clientId);
    form.append("kind", fields.kind);
    if (fields.text !== undefined && fields.text !== "") {
      form.append("text", fields.text);
    }
    if (fields.anchor !== undefined) {
      form.append("anchor", JSON.stringify(fields.anchor));
    }
    if (fields.tags !== undefined) {
      form.append("tags", JSON.stringify(fields.tags));
    }
    if (fields.device !== undefined) form.append("device", fields.device);
    if (fields.recordedAt !== undefined) {
      form.append("recordedAt", fields.recordedAt);
    }
    if (fields.durationSec !== undefined) {
      form.append("durationSec", String(fields.durationSec));
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/student/memos/media");
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onload = () => {
      try {
        resolve(parseMemoResponse(xhr.status, xhr.responseText));
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = () => reject(new MemoNetworkError());
    xhr.ontimeout = () => reject(new MemoNetworkError());
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
