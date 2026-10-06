import type { NoteImageMeta, NoteImageUploadMeta } from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postNoteImageApi } from "@/lib/api";

/**
 * 补图上传客户端测试（T6R.6）：POST /api/{student|teacher}/note-versions/:id/images
 * 的 multipart 组装（image 文件 + 八个元信息字段，字段名与服务端
 * lib/form-fields.parseNoteImageUploadForm 一一对应）与响应壳解包。
 * hc RPC 对 multipart 路由推断不出 form 入参——与 postTeacherMediaApi 同口径
 * 用原生 fetch（stub 全局 fetch 断言请求体）。
 */

const VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002";

function uploadMeta(o: Partial<NoteImageUploadMeta> = {}): NoteImageUploadMeta {
  return {
    spec: "analysis",
    pageIndex: 0,
    crop: { x: 0, y: 440, width: 1000, height: 1400 },
    pixelWidth: 1000,
    pixelHeight: 1400,
    ...o,
  };
}

/** 服务端回执形状（noteImageMeta；客户端只透传不解构） */
function receiptMeta(o: Partial<NoteImageMeta> = {}): NoteImageMeta {
  return {
    imageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002",
    noteVersionId: VERSION_ID,
    spec: "analysis",
    pageIndex: 0,
    crop: { x: 0, y: 440, width: 1000, height: 1400 },
    pixelWidth: 1000,
    pixelHeight: 1400,
    state: "ready",
    hash: "c".repeat(64),
    ...o,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postNoteImageApi（T6R.6 multipart）", () => {
  it("学生/教师路径分路；multipart 字段集与文件字段完整", async () => {
    const calls: Array<{ url: string; body: FormData }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body as FormData });
        return new Response(JSON.stringify({ ok: true, data: receiptMeta() }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
      type: "image/png",
    });
    const meta = uploadMeta({ pageIndex: 2 });

    await postNoteImageApi("student", VERSION_ID, png, meta);
    await postNoteImageApi("teacher", VERSION_ID, png, meta);

    expect(calls.map((c) => c.url)).toEqual([
      `/api/student/note-versions/${VERSION_ID}/images`,
      `/api/teacher/note-versions/${VERSION_ID}/images`,
    ]);
    for (const { body } of calls) {
      expect(body).toBeInstanceOf(FormData);
      // image 必须是文件字段（服务端 image instanceof File 分流）
      const image = body.get("image");
      expect(image).toBeInstanceOf(File);
      // 八个元信息字段全部以字符串发送（multipart 传输层口径）
      expect(body.get("spec")).toBe("analysis");
      expect(body.get("pageIndex")).toBe("2");
      expect(body.get("cropX")).toBe("0");
      expect(body.get("cropY")).toBe("440");
      expect(body.get("cropW")).toBe("1000");
      expect(body.get("cropH")).toBe("1400");
      expect(body.get("pixelWidth")).toBe("1000");
      expect(body.get("pixelHeight")).toBe("1400");
    }
  });

  it("成功壳解包为 NoteImageMeta 回执", async () => {
    const receipt = receiptMeta({ pageIndex: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, data: receipt }), {
            status: 200,
          }),
      ),
    );
    await expect(
      postNoteImageApi(
        "student",
        VERSION_ID,
        new Blob([new Uint8Array([1])]),
        uploadMeta({ pageIndex: 1 }),
      ),
    ).resolves.toEqual(receipt);
  });

  it("限额错误壳 → ApiError（NOTE_LIMIT_EXCEEDED，413）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: "NOTE_LIMIT_EXCEEDED",
              message: "派生图超过 2MiB 上传限额（暂定值）",
            }),
            { status: 413 },
          ),
      ),
    );
    const err = await postNoteImageApi(
      "student",
      VERSION_ID,
      new Blob([new Uint8Array([1])]),
      uploadMeta(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("NOTE_LIMIT_EXCEEDED");
    expect((err as { status?: number }).status).toBe(413);
  });
});
