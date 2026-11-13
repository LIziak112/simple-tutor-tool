import {
  DEVICE_ID_HEADER,
  DEVICE_INFO_HEADER,
  type DeviceRegister,
} from "@tutor/contract";
import { hc } from "hono/client";
import type { AppType } from "server";
import { randomUuid } from "./uuid";

const DEVICE_STORAGE_KEY = "tutor:device-id:v1";
let volatileId: string | undefined;

/** 仅持久化随机 UUID；清空网站数据、换浏览器自然变成新设备。 */
export function currentDevice(): DeviceRegister {
  let deviceId: string | null = null;
  try {
    deviceId = localStorage.getItem(DEVICE_STORAGE_KEY);
  } catch {
    /* 禁用存储时在本页保持稳定。 */
  }
  if (deviceId === null || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(deviceId)) {
    deviceId = volatileId ??= randomUuid();
    try {
      localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
    } catch {
      /* 同上。 */
    }
  }
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const ipad =
    /iPad/i.test(ua) ||
    (typeof navigator !== "undefined" &&
      navigator.platform === "MacIntel" &&
      navigator.maxTouchPoints > 1);
  const phone = /iPhone|Android.*Mobile/i.test(ua);
  const tablet = ipad || /Android/i.test(ua);
  const os = ipad
    ? "iPad"
    : /iPhone/i.test(ua)
      ? "iPhone"
      : /Android/i.test(ua)
        ? "Android"
        : /Windows/i.test(ua)
          ? "Windows"
          : /Mac/i.test(ua)
            ? "macOS"
            : /Linux/i.test(ua)
              ? "Linux"
              : null;
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /Firefox|FxiOS/i.test(ua)
      ? "Firefox"
      : /Chrome|CriOS/i.test(ua)
        ? "Chrome"
        : /Safari/i.test(ua)
          ? "Safari"
          : null;
  const standalone =
    (typeof matchMedia !== "undefined" &&
      matchMedia("(display-mode: standalone)").matches) ||
    (typeof navigator !== "undefined" &&
      "standalone" in navigator &&
      navigator.standalone === true);
  return {
    deviceId,
    type: phone ? "phone" : tablet ? "tablet" : ua === "" ? "other" : "desktop",
    os,
    browser,
    standalone,
  };
}

type Role = "student" | "teacher";
const nativeFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

/** 公共 RPC fetch：登记先于业务请求，登录/退出后按新账号重登，失败不阻断旧部署。 */
export function createDeviceFetch(
  rawFetch: typeof fetch = nativeFetch,
): typeof fetch {
  const registered = new Set<Role>();
  const pending = new Map<Role, Promise<void>>();
  const client = hc<AppType>("/", { fetch: rawFetch });
  let epoch = 0;
  const reset = () => {
    epoch += 1;
    registered.clear();
    pending.clear();
  };
  const register = (role: Role): Promise<void> => {
    if (registered.has(role)) return Promise.resolve();
    const running = pending.get(role);
    if (running !== undefined) return running;
    const generation = epoch;
    const args = { json: currentDevice() };
    const promise = client.api[role].devices.register
      .$post(args)
      .then((response) => {
        if (response.ok && generation === epoch) registered.add(role);
      })
      .catch(() => {
        /* 网络错误交给原业务请求处理，下次重新登记。 */
      })
      .finally(() => {
        if (generation === epoch) pending.delete(role);
      });
    pending.set(role, promise);
    return promise;
  };
  return async (input, init) => {
    const origin =
      typeof location === "undefined" ? "http://localhost" : location.origin;
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      origin,
    );
    if (url.origin !== origin || !url.pathname.startsWith("/api/"))
      return rawFetch(input, init);
    const role: Role | undefined = url.pathname.startsWith("/api/student/")
      ? "student"
      : url.pathname.startsWith("/api/teacher/") ||
          url.pathname.startsWith("/api/admin/")
        ? "teacher"
        : undefined;
    if (role !== undefined && !url.pathname.includes("/devices/"))
      await register(role);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const device = currentDevice();
    headers.set(DEVICE_ID_HEADER, device.deviceId);
    headers.set(DEVICE_INFO_HEADER, JSON.stringify(device));
    const response = await rawFetch(input, { ...init, headers });
    if (
      (response.ok &&
        (/\/(login|register|setup|logout)$/.test(url.pathname) ||
          /\/api\/public\/s\//.test(url.pathname))) ||
      response.status === 401
    )
      reset();
    return response;
  };
}

export const deviceFetch = createDeviceFetch();
