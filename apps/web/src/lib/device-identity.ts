import type { DeviceRegister } from "@tutor/contract";
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
