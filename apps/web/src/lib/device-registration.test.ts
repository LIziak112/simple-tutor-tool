import { DEVICE_ID_HEADER } from "@tutor/contract";
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
  it("首次受保护请求先登记，并发只登记一次，业务请求携带设备id", async () => {
    const raw = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }),
      );
    const fetcher = createDeviceFetch(raw);
    await Promise.all([
      fetcher("/api/student/me"),
      fetcher("/api/student/courses"),
    ]);
    expect(
      raw.mock.calls.filter(([url]) =>
        String(url).endsWith("/devices/register"),
      ),
    ).toHaveLength(1);
    for (const [url, init] of raw.mock.calls.filter(
      ([url]) => !String(url).endsWith("/devices/register"),
    )) {
      expect(String(url)).toMatch(/\/api\/student\//);
      expect(new Headers(init?.headers).get(DEVICE_ID_HEADER)).toBe(
        currentDevice().deviceId,
      );
    }
  });
  it("登录切换后重新按新账号登记，跨源请求不附加设备id", async () => {
    const raw = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("{}", { status: 200 }));
    const fetcher = createDeviceFetch(raw);
    await fetcher("/api/student/me");
    await fetcher("/api/public/student/login", { method: "POST" });
    await fetcher("/api/student/me");
    expect(
      raw.mock.calls.filter(([url]) =>
        String(url).endsWith("/devices/register"),
      ),
    ).toHaveLength(2);
    await fetcher("https://other.example/api/student/me");
    expect(
      new Headers(raw.mock.calls.at(-1)?.[1]?.headers).has(DEVICE_ID_HEADER),
    ).toBe(false);
  });
});
