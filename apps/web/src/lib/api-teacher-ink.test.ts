import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchTeacherInkStrokesApi } from "@/lib/api";

/**
 * fetchTeacherInkStrokesApi（T3.3 教师端笔迹矢量数据 helper）测试：
 * stub 全局 fetch 返回 Node Response，真实走 DecompressionStream 解压链路
 * （gzip 字节由 node:zlib 构造）。helper 刻意避开 Blob（jsdom 的 Blob 流与
 * Node 全局流互操作不可靠，见 api.ts 内注释与 use-ink-upload.test 的先例），
 * 因此本测试在 jsdom 环境可以跑全真解压，不需要注入适配。
 */

const INK_ID = "dddddddd-dddd-4ddd-8ddd-dddddddd0001";

/** 一份最小 atrament 矢量文档（与服务端夹具同形态） */
const DOC = {
  engine: "atrament",
  version: 1,
  data: {
    width: 800,
    strokes: [
      {
        tool: "pen",
        color: "#1f2328",
        weight: 4,
        points: [
          { x: 12, y: 34, p: 0.5, t: 0 },
          { x: 56, y: 78, p: 0.8, t: 25 },
        ],
      },
    ],
  },
  updatedAt: 1748918400000,
};

/** gzip 字节（node:zlib 的 Buffer 是 Uint8Array<ArrayBufferLike>，拷贝成
 * 独立 Uint8Array<ArrayBuffer> 才满足 Response BodyInit 类型——同 gzip.ts 口径） */
function gzBytes(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(gzipSync(Buffer.from(text, "utf8")));
}

function gzResponse(bytes: Uint8Array<ArrayBuffer>, status = 200): Response {
  return new Response(bytes, {
    status,
    headers: { "content-type": "application/gzip" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTeacherInkStrokesApi（T3.3）", () => {
  it("200：请求 .json.gz 地址，DecompressionStream 解压后 JSON.parse 回原文档", async () => {
    const fetchMock = vi.fn(async () =>
      gzResponse(gzBytes(JSON.stringify(DOC))),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTeacherInkStrokesApi(INK_ID)).resolves.toEqual(DOC);
    // 地址与口径：教师端矢量接口、同源相对路径（自动带会话 Cookie）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/teacher/ink/${INK_ID}.json.gz`,
    );
  });

  it("404 INK_NOT_FOUND：解 { ok:false } 壳抛 ApiError（调用方按 code 降级 PNG）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: "INK_NOT_FOUND",
              message: "笔迹矢量数据不存在",
            }),
            { status: 404 },
          ),
      ),
    );

    const err: unknown = await fetchTeacherInkStrokesApi(INK_ID).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("INK_NOT_FOUND");
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe("笔迹矢量数据不存在");
  });

  it("其他非 2xx（500 错误壳）：同样抛 ApiError，携带服务端 code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: "INTERNAL_ERROR",
              message: "服务端内部错误",
            }),
            { status: 500 },
          ),
      ),
    );
    await expect(fetchTeacherInkStrokesApi(INK_ID)).rejects.toThrow(
      "服务端内部错误",
    );
  });

  it("网络失败：抛「连不上服务器」中文 Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(fetchTeacherInkStrokesApi(INK_ID)).rejects.toThrow(
      "连不上服务器",
    );
  });

  it("坏 gzip 字节：抛解压失败中文 Error（不把压缩残渣当 JSON 吞掉）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gzResponse(new Uint8Array([0x00, 0x01, 0x02, 0x03]))),
    );
    await expect(fetchTeacherInkStrokesApi(INK_ID)).rejects.toThrow(
      "笔迹矢量数据解压失败",
    );
  });

  it("解压成功但内容不是 JSON：抛损坏提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gzResponse(gzBytes("<html>not json</html>"))),
    );
    await expect(fetchTeacherInkStrokesApi(INK_ID)).rejects.toThrow(
      "不是合法的 JSON",
    );
  });
});
