import {
  memoShareStateSchema,
  memoSourceTargetSchema,
  sharedMemoSchema,
} from "@tutor/contract";
import { z } from "zod";
import { parseUploadResponse } from "@/lib/api-response";

import type { HttpRuntime } from "./http-runtime";
export function createMemoSharingClient(http: HttpRuntime) {
  const deviceFetch = http.fetch;
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await deviceFetch(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    return parseUploadResponse(
      response.status,
      await response.text(),
      schema,
      "随笔响应不完整，请重试",
    );
  }
  const memoPath = (id: string) =>
    `/api/student/memos/${encodeURIComponent(id)}`;
  const memoTagSuggestionsApi = () =>
    request("/api/student/memos/tags", z.object({ tags: z.array(z.string()) }));
  const memoSourceTargetApi = (id: string) =>
    request(`${memoPath(id)}/source-target`, memoSourceTargetSchema);
  const memoShareStateApi = (id: string) =>
    request(`${memoPath(id)}/share`, memoShareStateSchema);
  const shareMemoApi = (id: string, teacherId: string) =>
    request(`${memoPath(id)}/share`, memoShareStateSchema, "PUT", {
      teacherId,
    });
  const revokeMemoShareApi = (id: string) =>
    request(`${memoPath(id)}/share`, z.object({ id: z.string() }), "DELETE");
  const sharedMemosApi = (studentId: string, cursor?: string) =>
    request(
      `/api/teacher/students/${encodeURIComponent(studentId)}/memos${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
      z.object({
        memos: z.array(sharedMemoSchema),
        nextCursor: z.string().nullable(),
      }),
    );
  return {
    memoTagSuggestionsApi,
    memoSourceTargetApi,
    memoShareStateApi,
    shareMemoApi,
    revokeMemoShareApi,
    sharedMemosApi,
  };
}
