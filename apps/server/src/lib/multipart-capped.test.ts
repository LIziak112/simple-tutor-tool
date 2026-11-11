import type { ApiErr } from "@tutor/contract";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  multipartFileStream,
  streamingInit,
} from "../test/multipart-stream.ts";
import { HttpError } from "./http-error.ts";
import { parseMultipartCapped } from "./multipart-capped.ts";

/**
 * 流式计数上限的 multipart 解析（#103-01）：
 * - 不带 content-length 的流式请求体累计超过 limitBytes → 413 {code}，且源流在超限处
 *   停止被读取（不是读完再量）；
 * - 正常 multipart → FormData（File + 文本字段）；
 * - 非 multipart / 无 body / 坏 multipart → 400 VALIDATION_ERROR。
 */

const CAP = {
  limitBytes: 1024 * 1024,
  code: "TEST_TOO_LARGE",
  message: "测试：请求体过大",
} as const;

function makeApp() {
  return new Hono()
    .onError((err, c) => {
      if (err instanceof HttpError) {
        const body: ApiErr = {
          ok: false,
          error: err.code,
          message: err.message,
        };
        return c.json(body, err.status);
      }
      throw err;
    })
    .post("/u", async (c) => {
      const form = await parseMultipartCapped(c, CAP);
      const file = form.get("file");
      return c.json({
        ok: true,
        data: {
          isFile: file instanceof File,
          size: file instanceof File ? file.size : null,
          name: file instanceof File ? file.name : null,
          note: form.get("note"),
        },
      });
    });
}

describe("parseMultipartCapped", () => {
  it("流式超限 → 413 指定错误码，源流在上限附近即停止读取", async () => {
    const app = makeApp();
    const stream = multipartFileStream({
      fileName: "big.bin",
      file: { bytes: 16 * 1024 * 1024 },
      chunkSize: 64 * 1024,
    });
    const res = await app.request("/u", streamingInit(stream, {}));
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("TEST_TOO_LARGE");
    // 1 MiB 上限 + 若干块余量：远小于 16 MiB 的源
    expect(stream.counter.pulled).toBeLessThan(CAP.limitBytes + 8 * 64 * 1024);
  });

  it("正常 multipart（流式、无 content-length）→ File 与文本字段都在", async () => {
    const app = makeApp();
    const stream = multipartFileStream({
      fileName: "a.pdf",
      file: new Uint8Array([1, 2, 3, 4, 5]),
      fields: { note: "备注" },
    });
    const res = await app.request("/u", streamingInit(stream, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { isFile: true, size: 5, name: "a.pdf", note: "备注" },
    });
    // FormData 体（undici 自带 content-length）同样可解析
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(3)]), "b.pdf");
    const viaForm = await app.request("/u", { method: "POST", body: form });
    expect(viaForm.status).toBe(200);
  });

  it("非 multipart / 无 body / 坏 multipart → 400 VALIDATION_ERROR", async () => {
    const app = makeApp();
    const json = await app.request("/u", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "x" }),
    });
    expect(json.status).toBe(400);
    expect(((await json.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    const empty = await app.request("/u", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
    });
    expect(empty.status).toBe(400);
    const garbage = await app.request("/u", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
      body: "garbage without boundary",
    });
    expect(garbage.status).toBe(400);
    expect(((await garbage.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });
});
