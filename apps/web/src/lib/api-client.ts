import { hc } from "hono/client";
import type { AppType } from "server";
import { deviceFetch } from "./device-registration";

/** 同源 Hono RPC；统一设备登记和请求元数据，不参与权限裁决。 */
export const api = hc<AppType>("/", { fetch: deviceFetch });
