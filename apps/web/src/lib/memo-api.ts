import type {
  Memo,
  MemoCreateMedia,
  MemoCreateText,
  MemoListData,
  MemoListQuery,
} from "@tutor/contract";
import {
  DEVICE_ID_HEADER,
  DEVICE_INFO_HEADER,
  MEMO_OUTBOX_ACCOUNT_HEADER,
  memoSchema,
} from "@tutor/contract";
import { api, callApi } from "@/lib/api";
import { parseUploadResponse } from "@/lib/api-response";
import { currentDevice, deviceFetch } from "./device-registration";

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

export function createTextMemoApi(
  input: MemoCreateText,
  account: string,
): Promise<Memo> {
  return callApi(() =>
    api.api.student.memos.$post(
      { json: input },
      { headers: { [MEMO_OUTBOX_ACCOUNT_HEADER]: account } },
    ),
  );
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

/** 媒体随笔上传：file + 文本字段（anchor / tags 以 JSON 串入 multipart） */
export async function uploadMemoMediaApi(
  blob: Blob,
  fields: MemoCreateMedia,
  account: string,
  options: UploadMemoMediaOptions = {},
): Promise<Memo> {
  await deviceFetch("/api/student/me");
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
    if (fields.context !== undefined)
      form.append("context", JSON.stringify(fields.context));
    if (fields.deviceId !== undefined) form.append("deviceId", fields.deviceId);
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
    xhr.setRequestHeader(MEMO_OUTBOX_ACCOUNT_HEADER, account);
    xhr.setRequestHeader(DEVICE_ID_HEADER, currentDevice().deviceId);
    xhr.setRequestHeader(DEVICE_INFO_HEADER, JSON.stringify(currentDevice()));
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
            memoSchema,
            "服务器返回的随笔信息不完整，请刷新后查看",
          ),
        );
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
