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
import {
  MemoNetworkError,
  type UploadMemoMediaOptions,
} from "@/features/runtime/ports/memos-types";
import { callApi, parseUploadResponse } from "@/lib/api-response";
import { currentDevice } from "@/lib/device-registration";
import type { HttpRuntime } from "./http-runtime";
export function createMemosClient(http: HttpRuntime) {
  const { api } = http;
  function listMemosApi(query: MemoListQuery = {}): Promise<MemoListData> {
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
  function createTextMemoApi(
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
  function deleteMemoApi(id: string): Promise<{ id: string }> {
    const args = { param: { id } };
    return callApi(() => api.api.student.memos[":id"].$delete(args));
  }
  async function uploadMemoMediaApi(
    blob: Blob,
    fields: MemoCreateMedia,
    account: string,
    options: UploadMemoMediaOptions = {},
  ): Promise<Memo> {
    options.signal?.throwIfAborted();
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
      if (fields.deviceId !== undefined)
        form.append("deviceId", fields.deviceId);
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
      const xhr = http.xhr();
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
      const abortReason = () =>
        options.signal?.reason ?? new DOMException("已取消上传", "AbortError");
      const cancel = () => {
        xhr.abort();
        fail(abortReason());
      };
      const cleanup = () =>
        options.signal?.removeEventListener("abort", cancel);
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      xhr.onload = () => {
        cleanup();
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
          fail(err);
        }
      };
      xhr.onerror = () => fail(new MemoNetworkError());
      xhr.ontimeout = () => fail(new MemoNetworkError());
      xhr.onabort = () => fail(abortReason());
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          cancel();
          return;
        }
        options.signal.addEventListener("abort", cancel, { once: true });
      }
      xhr.send(form);
    });
  }
  return { listMemosApi, createTextMemoApi, deleteMemoApi, uploadMemoMediaApi };
}
