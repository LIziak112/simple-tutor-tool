import {
  memoShareStateSchema,
  memoSourceTargetSchema,
  sharedMemoSchema,
} from "@tutor/contract";
import { z } from "zod";
import { parseUploadResponse } from "./api-response";
import { deviceFetch } from "./device-registration";

/** 运行时校验与教师最小投影共用契约；身份由同源会话鉴权。 */
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
const memoPath = (id: string) => `/api/student/memos/${encodeURIComponent(id)}`;
export const memoTagSuggestionsApi = () =>
  request("/api/student/memos/tags", z.object({ tags: z.array(z.string()) }));
export const memoSourceTargetApi = (id: string) =>
  request(`${memoPath(id)}/source-target`, memoSourceTargetSchema);
export const memoShareStateApi = (id: string) =>
  request(`${memoPath(id)}/share`, memoShareStateSchema);
export const shareMemoApi = (id: string, teacherId: string) =>
  request(`${memoPath(id)}/share`, memoShareStateSchema, "PUT", { teacherId });
export const revokeMemoShareApi = (id: string) =>
  request(`${memoPath(id)}/share`, z.object({ id: z.string() }), "DELETE");
export const sharedMemosApi = (studentId: string, cursor?: string) =>
  request(
    `/api/teacher/students/${encodeURIComponent(studentId)}/memos${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
    z.object({
      memos: z.array(sharedMemoSchema),
      nextCursor: z.string().nullable(),
    }),
  );
