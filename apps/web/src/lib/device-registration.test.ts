import { DEVICE_ID_HEADER, DEVICE_INFO_HEADER } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceFetch, currentDevice } from "./device-registration";

describe("浏览器设备登记基础设施", () => {
  beforeEach(() => localStorage.clear());
  it("设备id在浏览器内持久，iPad桌面UA和主屏幕应用可辨认，不采集指纹", () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 5,
      configurable: true,
    });
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla Macintosh Version/18 Safari/605",
      configurable: true,
    });
    expect(currentDevice()).toMatchObject({
      type: "tablet",
      os: "iPad",
      browser: "Safari",
    });
    expect(currentDevice().deviceId).toBe(currentDevice().deviceId);
  });

  it("只给实际业务请求附加设备头，不阻断等待重复登记", async () => {
    const raw = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const fetcher = createDeviceFetch(raw);
    await Promise.all([
      fetcher("/api/student/me"),
      fetcher("/api/student/courses"),
    ]);
    expect(raw.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/student/me",
      "/api/student/courses",
    ]);
    for (const [, init] of raw.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get(DEVICE_ID_HEADER)).toBe(currentDevice().deviceId);
      expect(
        JSON.parse(headers.get(DEVICE_INFO_HEADER) ?? "null"),
      ).toMatchObject(currentDevice());
    }
  });
  it("登录切换后每次仍附带本人登记信息，跨源不附加设备头", async () => {
    const raw = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("{}"));
    const fetcher = createDeviceFetch(raw);
    await fetcher("/api/student/me");
    await fetcher("/api/public/student/login", { method: "POST" });
    await fetcher("/api/student/me");
    expect(raw).toHaveBeenCalledTimes(3);
    expect(
      new Headers(raw.mock.calls[2]?.[1]?.headers).get(DEVICE_INFO_HEADER),
    ).not.toBeNull();
    await fetcher("https://other.example/api/student/me");
    expect(
      new Headers(raw.mock.calls.at(-1)?.[1]?.headers).has(DEVICE_ID_HEADER),
    ).toBe(false);
  });
  it("登记网络永久悬挂时，主动取消和业务超时仍及时结束", async () => {
    for (const timeout of [false, true]) {
      const controller = new AbortController();
      const signal = timeout ? AbortSignal.timeout(10) : controller.signal;
      const raw = abortableFetch();
      const pending = createDeviceFetch(raw)("/api/student/me", { signal });
      if (!timeout) controller.abort();
      const result = await settleSoon(pending);
      expect(result).toBe(timeout ? "TimeoutError" : "AbortError");
      expect(raw.mock.calls.map(([url]) => String(url))).toEqual([
        "/api/student/me",
      ]);
      expect(raw.mock.calls[0]?.[1]?.signal).toBe(signal);
    }
  });
  it("并发业务请求各自取消，取消一个不阻止另一个", async () => {
    const raw = abortableFetch();
    const fetcher = createDeviceFetch(raw);
    const controller = new AbortController();
    const canceled = fetcher("/api/student/me", { signal: controller.signal });
    const other = fetcher("/api/student/courses");
    controller.abort();
    expect(await settleSoon(canceled)).toBe("AbortError");
    expect(await settleSoon(other)).toBe("resolved");
  });
  it("已取消请求不发网络请求，业务失败后仍可重试", async () => {
    const raw = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("{}", { status: 500 }));
    const fetcher = createDeviceFetch(raw);
    const controller = new AbortController();
    controller.abort();
    expect(
      await settleSoon(
        fetcher("/api/student/me", { signal: controller.signal }),
      ),
    ).toBe("AbortError");
    expect(raw).not.toHaveBeenCalled();
    expect((await fetcher("/api/student/me")).status).toBe(500);
    raw.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect((await fetcher("/api/student/me")).status).toBe(200);
  });
});

function settleSoon(promise: Promise<unknown>): Promise<string> {
  return Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.name : String(error)),
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 40)),
  ]);
}

function abortableFetch() {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    if (String(input).endsWith("/devices/register"))
      return new Promise<Response>(() => {});
    const signal = init?.signal;
    if (signal == null) return new Response("{}");
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
    });
  });
}
