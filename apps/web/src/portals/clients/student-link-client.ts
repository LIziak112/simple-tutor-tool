import type { StudentMeData } from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
export function createStudentLinkClient(http: HttpRuntime) {
  const { api } = http;
  function loginStudentByLinkApi(
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
  return { loginStudentByLinkApi };
}
