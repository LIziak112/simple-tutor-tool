import type { StudentMeData } from "@tutor/contract";
import { api } from "./api-client";
import { callApi } from "./api-response";

/** 仅此入口传取消信号；成功响应仍由浏览器处理原有会话Cookie。 */
export function loginStudentByLinkApi(
  token: string,
  signal?: AbortSignal,
): Promise<StudentMeData> {
  return callApi(() =>
    api.api.public.s[":token"].$get(
      { param: { token } },
      signal === undefined ? {} : { init: { signal } },
    ),
  );
}
