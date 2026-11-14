import { afterEach, expect, it, vi } from "vitest";
import { loginStudentByLinkApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
it("专属链接RPC保留可选AbortSignal与设备头，旧一参调用仍有效", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ ok: true, data: { id: "student" } })),
  );
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  await loginStudentByLinkApi("link", signal);
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(signal);
  expect(
    new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-tutor-device-id"),
  ).toBeTruthy();
  await loginStudentByLinkApi("old-link");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("入口已取消时不发兑换HTTP，保留AbortError", async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  controller.abort();
  await expect(
    loginStudentByLinkApi("link", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});
