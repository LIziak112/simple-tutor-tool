import { afterEach, expect, it, vi } from "vitest";
import {
  postAttemptEventsApi,
  putAttemptInkApi,
  saveAttemptAnswerApi,
  submitAttemptApi,
} from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  [
    "答案",
    () => saveAttemptAnswerApi("a", "q", { kind: "judge", value: true }),
  ],
  ["手写", () => putAttemptInkApi("a", "q", new Blob(), new Blob())],
  ["学情", () => postAttemptEventsApi("a", [{ type: "submit", clientTs: 1 }])],
  ["交卷", () => submitAttemptApi("a", { revisions: [] })],
] as const)("%s请求的响应体一直未完成时有界退出", async (_label, send) => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal("fetch", (_input: string, init?: RequestInit) => {
    signal = init?.signal;
    return Promise.resolve(
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  const settled = vi.fn();
  void send().then(() => settled("完成"), settled);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("超时") }),
  );
  expect(signal?.aborted).toBe(true);
});
