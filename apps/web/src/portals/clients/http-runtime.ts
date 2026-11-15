import { hc } from "hono/client";
import type { AppType } from "server";
import { createDeviceFetch } from "@/lib/device-registration";
import type { SubjectScope } from "../subject-scope";
/** 每个宿主持有自己的HTTP实例，取消信号与主体租约在请求实际发送前合并。 */
export function createHttpRuntime(scope: SubjectScope) {
  const fetch = createDeviceFetch(scope.fetch);
  return Object.freeze({
    api: hc<AppType>("/", { fetch }),
    fetch,
    xhr: scope.xhr,
    signal: scope.signal,
  });
}
export type HttpRuntime = ReturnType<typeof createHttpRuntime>;
