import { DEVICE_ID_HEADER, DEVICE_INFO_HEADER } from "@tutor/contract";
import { currentDevice } from "./device-identity";

export { currentDevice } from "./device-identity";

const nativeFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

/** 同源业务请求携带设备元信息，由鉴权守卫登记；不增加阻断或改变取消期限。 */
export function createDeviceFetch(
  rawFetch: typeof fetch = nativeFetch,
): typeof fetch {
  return async (input, init) => {
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const origin =
      typeof location === "undefined" ? "http://localhost" : location.origin;
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      origin,
    );
    if (url.origin !== origin || !url.pathname.startsWith("/api/"))
      return rawFetch(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const device = currentDevice();
    headers.set(DEVICE_ID_HEADER, device.deviceId);
    headers.set(DEVICE_INFO_HEADER, JSON.stringify(device));
    const response = await rawFetch(input, { ...init, headers });
    signal?.throwIfAborted();
    return response;
  };
}

export const deviceFetch = createDeviceFetch();
