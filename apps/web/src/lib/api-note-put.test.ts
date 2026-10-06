import type { NoteVersionReceipt } from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, putNoteDocumentApi } from "@/lib/api";

/**
 * 草稿正文上传客户端（T6R.8）测试：
 * - PUT multipart：body 文件字段 + baseRevision/mutationId 十进制串字段
 *   （与服务端 routes/student.ts PUT /attempts/:id/notes/:qid 的
 *   parseBody + strictFormInt 口径一一对应）；
 * - 成功壳 → noteVersionReceipt；409 冲突壳 → ApiError 且 extra._current
 *   携带当前版本摘要（note-sync 据此进入 conflict 态）；
 * - AbortSignal 透传（note-sync 账号切换中止旧会话在途请求）。
 * stub 全局 fetch（multipart 路由 hc RPC 推断不出 form 入参——原生 fetch，
 * 与 postNoteImageApi 同口径，见 api-note-image.test）。
 */

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const QUESTION_ID = "p1-q1";

const RECEIPT: NoteVersionReceipt = {
  noteId: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  versionId: "33333333-3333-4333-8333-333333333333",
  hash: "a".repeat(64),
  savedAt: "2026-10-06T00:00:00.000Z",
};

function shellResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** 捕获型 fetch stub：成功壳回执 */
function stubCapture(
  respond: (call: CapturedCall) => Response,
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return respond(call);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("putNoteDocumentApi（T6R.8）", () => {
  it("PUT multipart：body 文件 + baseRevision/mutationId 字段；成功壳回回执", async () => {
    const calls = stubCapture(() => shellResponse({ ok: true, data: RECEIPT }));
    const bytes = new TextEncoder().encode('{"version":1}');
    const receipt = await putNoteDocumentApi(
      ATTEMPT_ID,
      QUESTION_ID,
      new Blob([bytes], { type: "application/gzip" }),
      { baseRevision: 0, mutationId: "44444444-4444-4444-8444-444444444444" },
    );
    expect(receipt).toEqual(RECEIPT);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(
      `/api/student/attempts/${ATTEMPT_ID}/notes/${QUESTION_ID}`,
    );
    expect(calls[0]?.init.method).toBe("PUT");
    const form = calls[0]?.init.body;
    expect(form).toBeInstanceOf(FormData);
    const fd = form as FormData;
    const body = fd.get("body");
    expect(body).toBeInstanceOf(Blob);
    expect((body as Blob).size).toBe(bytes.length);
    // 字段一律十进制字符串（strictFormInt 不认其他形态）
    expect(fd.get("baseRevision")).toBe("0");
    expect(fd.get("mutationId")).toBe("44444444-4444-4444-8444-444444444444");
  });

  it("409 冲突壳 → ApiError 且 extra._current 携带服务端摘要", async () => {
    const current = {
      noteId: "22222222-2222-4222-8222-222222222222",
      revision: 2,
      versionId: "33333333-3333-4333-8333-333333333333",
      hash: "b".repeat(64),
      serverSavedAt: "2026-10-06T01:00:00.000Z",
    };
    stubCapture(() =>
      shellResponse(
        {
          ok: false,
          error: "NOTE_REVISION_CONFLICT",
          message: "草稿已在别处保存了更新的版本",
          _current: current,
        },
        409,
      ),
    );
    const err = await putNoteDocumentApi(
      ATTEMPT_ID,
      QUESTION_ID,
      new Blob(["{}"]),
      { baseRevision: 1, mutationId: "44444444-4444-4444-8444-444444444444" },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(409);
    expect(apiErr.code).toBe("NOTE_REVISION_CONFLICT");
    expect(apiErr.extra?._current).toEqual(current);
  });

  it("AbortSignal 透传给 fetch（账号切换中止旧会话在途）", async () => {
    const calls = stubCapture(() => shellResponse({ ok: true, data: RECEIPT }));
    const controller = new AbortController();
    await putNoteDocumentApi(
      ATTEMPT_ID,
      QUESTION_ID,
      new Blob(["{}"]),
      { baseRevision: 0, mutationId: "44444444-4444-4444-8444-444444444444" },
      controller.signal,
    );
    expect(calls[0]?.init.signal).toBe(controller.signal);
  });
});
