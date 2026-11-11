import type { Attachment, Memo } from "@tutor/contract";
import {
  MEMO_OUTBOX_ACCOUNT_CHANGED,
  MEMO_OUTBOX_ACCOUNT_HEADER,
} from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { uploadAttachmentApi } from "./attachment-api";
import { MemoNetworkError, uploadMemoMediaApi } from "./memo-api";

const ID = "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";
const ACCOUNT_ID = "80d77358-3032-4dcc-a420-3f775e5ca435";
const TIME = "2026-11-11T12:00:00.000Z";
const attachment = {
  id: ID,
  courseId: null,
  courseTitle: null,
  fileName: "练习.pdf",
  format: "pdf",
  bytes: 8,
  pageCount: 1,
  visibility: "teacher_only",
  createdAt: TIME,
  updatedAt: TIME,
} satisfies Attachment;
const memo = {
  id: ID,
  kind: "image",
  text: null,
  media: { format: "png", bytes: 8, durationSec: null },
  anchor: { kind: "none" },
  tags: [],
  source: "self",
  device: "desktop",
  createdAt: TIME,
  recordedAt: TIME,
} satisfies Memo;

function startUpload(upload: () => Promise<unknown>) {
  let xhr: UploadRequest | undefined;
  class UploadRequest {
    open = vi.fn();
    send = vi.fn<(body: FormData) => void>();
    setRequestHeader = vi.fn();
    upload = { onprogress: (_event: ProgressEvent) => {} };
    status = 0;
    responseText = "";
    onload = () => {};
    onerror = () => {};
    onabort = () => {};

    constructor() {
      xhr = this;
    }

    abort() {
      this.onabort();
    }
  }
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  const result = upload();
  const request = xhr;
  if (request === undefined) throw new Error("没有发起上传请求");
  return {
    xhr: request,
    result,
    respond(status: number, body: string) {
      request.status = status;
      request.responseText = body;
      request.onload();
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe.each([
  {
    name: "附件",
    upload: (signal?: AbortSignal) =>
      uploadAttachmentApi(new File(["%PDF-1.7"], attachment.fileName), {
        signal,
      }),
    data: attachment,
    errorCode: "CONFLICT",
    invalidData: "服务器返回的资料信息不完整，请刷新后查看",
  },
  {
    name: "随笔",
    upload: (signal?: AbortSignal) =>
      uploadMemoMediaApi(
        new Blob(["图片"]),
        { clientId: ID, kind: "image" },
        ACCOUNT_ID,
        { signal },
      ),
    data: memo,
    errorCode: MEMO_OUTBOX_ACCOUNT_CHANGED,
    invalidData: "服务器返回的随笔信息不完整，请刷新后查看",
  },
])("$name 上传响应", ({ upload, data, errorCode, invalidData }) => {
  it.each([200, 201])("HTTP %i 成功时返回契约数据", async (status) => {
    const { respond, result } = startUpload(upload);
    respond(status, JSON.stringify({ ok: true, data }));
    await expect(result).resolves.toEqual(data);
  });

  it("业务错误保留 ApiError 身份、状态码与文案", async () => {
    const { respond, result } = startUpload(upload);
    respond(
      409,
      JSON.stringify({
        ok: false,
        error: errorCode,
        message: "请求冲突",
        _current: "附加信息",
      }),
    );
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      code: errorCode,
      message: "请求冲突",
      status: 409,
      extra: undefined,
    });
  });

  it.each(["<html>错误</html>", '{"message":"错误"}'])(
    "无法读取响应壳时使用 HTTP 文案",
    async (body) => {
      const { respond, result } = startUpload(upload);
      respond(502, body);
      await expect(result).rejects.toThrow(
        "服务器响应异常（HTTP 502），请稍后重试",
      );
    },
  );

  it("成功壳中的数据仍按领域契约校验", async () => {
    const { respond, result } = startUpload(upload);
    respond(200, '{"ok":true,"data":{}}');
    await expect(result).rejects.toThrow(invalidData);
  });

  it("取消正在进行的上传时拒绝为 AbortError", async () => {
    const controller = new AbortController();
    const { xhr, result } = startUpload(() => upload(controller.signal));
    expect(xhr.send).toHaveBeenCalledOnce();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});

it("附件上传发送原幂等键和可见性、报告进度，断网时提示可重试", async () => {
  const onProgress = vi.fn();
  const { xhr, result } = startUpload(() =>
    uploadAttachmentApi(new File(["%PDF-1.7"], attachment.fileName), {
      uploadId: ID,
      visibility: "teacher_only",
      onProgress,
    }),
  );
  const form = xhr.send.mock.calls[0]?.[0];
  expect(xhr.open).toHaveBeenCalledWith("POST", "/api/teacher/attachments");
  expect(form?.get("uploadId")).toBe(ID);
  expect(form?.get("visibility")).toBe("teacher_only");
  xhr.upload.onprogress(
    new ProgressEvent("progress", {
      lengthComputable: true,
      loaded: 4,
      total: 8,
    }),
  );
  expect(onProgress).toHaveBeenCalledWith(0.5);
  xhr.onerror();
  await expect(result).rejects.toThrow("已选的文件不会丢，可直接重试");
});

it("随笔上传绑定账号和 clientId，断网时保留补传队列识别的错误类型", async () => {
  const { xhr, result } = startUpload(() =>
    uploadMemoMediaApi(
      new Blob(["图片"]),
      { clientId: ID, kind: "image" },
      ACCOUNT_ID,
    ),
  );
  expect(xhr.open).toHaveBeenCalledWith("POST", "/api/student/memos/media");
  expect(xhr.setRequestHeader).toHaveBeenCalledWith(
    MEMO_OUTBOX_ACCOUNT_HEADER,
    ACCOUNT_ID,
  );
  expect(xhr.send.mock.calls[0]?.[0].get("clientId")).toBe(ID);
  xhr.onerror();
  await expect(result).rejects.toBeInstanceOf(MemoNetworkError);
});
