import { afterEach, expect, it, vi } from "vitest";
import {
  fetchAnnotationViewApi,
  fetchAttemptMaterialRevisionsApi,
  fetchStudentNoteDocumentApi,
  fetchStudentNoteHeadsApi,
} from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each([
  ["盘点", () => fetchAttemptMaterialRevisionsApi("a")],
  ["标画正文", () => fetchAnnotationViewApi("a", "q")],
  ["草稿头", () => fetchStudentNoteHeadsApi("a", ["q"])],
  ["草稿正文", () => fetchStudentNoteDocumentApi("v")],
] as const)("%s 请求悬挂时结束等待并取消请求", async (_name, read) => {
  vi.useFakeTimers();
  const fetchSpy = vi.fn(
    (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(() => {}),
  );
  vi.stubGlobal("fetch", fetchSpy);
  let outcome = "pending";
  void read().then(
    () => {
      outcome = "success";
    },
    (error: unknown) => {
      outcome = error instanceof Error ? error.message : String(error);
    },
  );
  await vi.advanceTimersByTimeAsync(30_000);
  expect(outcome).toContain("材料读取超时");
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(init?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["盘点响应体", () => fetchAttemptMaterialRevisionsApi("a")],
  ["标画响应体", () => fetchAnnotationViewApi("a", "q")],
  ["草稿头响应体", () => fetchStudentNoteHeadsApi("a", ["q"])],
] as const)("%s 悬挂也受同一期限约束", async (_name, read) => {
  vi.useFakeTimers();
  const response = new Response("{}");
  vi.spyOn(response, "json").mockImplementation(
    () => new Promise<never>(() => {}),
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  const result = expect(read()).rejects.toThrow("材料读取超时");
  await vi.advanceTimersByTimeAsync(30_000);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});
it("超时盘点的迟到响应不能替代新一轮结果", async () => {
  vi.useFakeTimers();
  const old = Promise.withResolvers<Response>();
  const data = { notes: {}, annotations: {}, ink: {} };
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data }))),
  );
  const first = fetchAttemptMaterialRevisionsApi("a");
  const rejected = expect(first).rejects.toThrow("材料读取超时");
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(await fetchAttemptMaterialRevisionsApi("a")).toEqual(data);
  old.resolve(
    new Response(
      JSON.stringify({ ok: true, data: { ...data, annotations: { q: 99 } } }),
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  await expect(first).rejects.toThrow("材料读取超时");
  expect(vi.getTimerCount()).toBe(0);
});
