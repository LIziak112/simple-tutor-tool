import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { createSubjectScope } from "../subject-scope";
import { createHttpRuntime } from "./http-runtime";
import { createInkClient } from "./ink-client";
import { createNoteReadClient } from "./note-read-client";
import type { ClientServices } from "./service-types";

afterEach(() => vi.unstubAllGlobals());
for (const consumer of ["ink", "note", "teacher-note"] as const) {
  for (const cancel of ["owner", "caller"] as const) {
    if (consumer === "teacher-note" && cancel === "caller") continue;
    it(`${consumer}输入EOF后${cancel}取消：续体不能成功写入角色缓存，保留reason`, async () => {
      let release = () => {};
      let reachedEof = () => {};
      const eof = new Promise<void>((resolve) => {
        reachedEof = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // 确定性模拟真实解压器输入结束、输出flush尚未完成的时间窗。
      vi.stubGlobal(
        "DecompressionStream",
        class extends TransformStream<Uint8Array, Uint8Array> {
          constructor() {
            super({
              transform(chunk, controller) {
                controller.enqueue(chunk);
              },
              async flush() {
                reachedEof();
                await gate;
              },
            });
          }
        },
      );
      const role = consumer === "note" ? "student" : "teacher";
      const scope = createSubjectScope(
        { type: role, id: "a" },
        async () => new Response(JSON.stringify({ secret: "旧主体正文" })),
      );
      const caller = new AbortController();
      const http = createHttpRuntime(scope);
      const ink = createInkClient(http, () => services);
      const services = {
        ...ink,
        readMaterialWithDeadline: <T>(
          read: (signal: AbortSignal) => Promise<T>,
        ) => read(caller.signal),
      } as ClientServices;
      const notes = createNoteReadClient(http, () => services);
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const key = [role, consumer, "old"];
      const pending = cache.fetchQuery({
        queryKey: key,
        queryFn: () =>
          consumer === "teacher-note"
            ? notes.fetchTeacherNoteDocumentApi("old")
            : consumer === "note"
              ? notes.fetchStudentNoteDocumentApi("old")
              : ink.fetchGzipJson(
                  "/ink",
                  {
                    network: "网络",
                    unsupported: "支持",
                    decompress: "解压",
                    corrupt: "损坏",
                  },
                  caller.signal,
                ),
      });
      const outcome = pending.catch((error: unknown) => error);
      await eof;
      const reason = new DOMException("原始取消原因", "AbortError");
      if (cancel === "owner") scope.close();
      else caller.abort(reason);
      cache.setQueryData([role, "me"], { id: "b" });
      release();
      expect(await outcome).toBe(
        cancel === "owner" ? scope.signal.reason : reason,
      );
      expect(cache.getQueryData(key)).toBeUndefined();
      cache.clear();
    });
  }
}
