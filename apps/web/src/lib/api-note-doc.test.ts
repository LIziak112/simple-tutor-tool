import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchStudentNoteDocumentApi,
  fetchTeacherNoteDocumentApi,
} from "@/lib/api";

/**
 * 笔记版本文档客户端（T6R.5 ③⑦）与 fetchGzipJson 错误归因测试（复审轮⑤）：
 * - 学生/教师薄导出请求各自路径，gzip 解压后回原文档；
 * - 源流网络中断（读流错）→ 网络错误文案；非 gzip 字节 → 解压失败文案；
 * - 404 壳 → ApiError（NOTE_NOT_FOUND）。
 * stub 全局 fetch 返回 Node Response，真实走 DecompressionStream 链路
 * （与 api-teacher-ink.test 同口径）。
 */

const VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001";

/** gzip 字节拷贝为独立 Uint8Array<ArrayBuffer>（Response BodyInit 类型口径，
 * 同 api-teacher-ink.test 的 gzBytes） */
function gzBytes(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(gzipSync(Buffer.from(text, "utf8")));
}

function gzResponse(bytes: Uint8Array<ArrayBuffer>, status = 200): Response {
  return new Response(bytes, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchStudent/TeacherNoteDocumentApi（T6R.5）", () => {
  it("学生/教师各自路径请求；gzip 解压后 JSON.parse 回原文档", async () => {
    const doc = { version: 1, ink: { width: 1000, strokes: [] } };
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string | URL | Request) => {
        calls.push(String(path));
        return gzResponse(gzBytes(JSON.stringify(doc)));
      }),
    );
    await expect(fetchStudentNoteDocumentApi(VERSION_ID)).resolves.toEqual(doc);
    await expect(fetchTeacherNoteDocumentApi(VERSION_ID)).resolves.toEqual(doc);
    expect(calls[0]).toBe(`/api/student/note-versions/${VERSION_ID}/document`);
    expect(calls[1]).toBe(`/api/teacher/note-versions/${VERSION_ID}/document`);
  });

  it("读流中断（网络错）→ 网络错误文案；非 gzip 字节 → 解压失败文案（归因启发式）", async () => {
    // 源流在读阶段报错（undici 网络中断形态："terminated"）
    const erroredStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(erroredStream)),
    );
    await expect(fetchStudentNoteDocumentApi(VERSION_ID)).rejects.toThrow(
      "连不上服务器",
    );

    // 非 gzip 字节走完整管道 → 解压阶段失败 → 解压文案
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gzResponse(new TextEncoder().encode("definitely not gzip")),
      ),
    );
    await expect(fetchStudentNoteDocumentApi(VERSION_ID)).rejects.toThrow(
      "解压失败",
    );
  });

  it("404 统一壳 → ApiError（NOTE_NOT_FOUND）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gzResponse(
          new TextEncoder().encode(
            JSON.stringify({
              ok: false,
              error: "NOTE_NOT_FOUND",
              message: "笔记版本不存在",
            }),
          ),
          404,
        ),
      ),
    );
    await expect(
      fetchStudentNoteDocumentApi(VERSION_ID),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
