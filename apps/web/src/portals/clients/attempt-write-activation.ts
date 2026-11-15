import {
  type AttemptActivateRequest,
  attemptActivateDataSchema,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import { withRequestDeadline } from "@/lib/request-deadline";
import type { HttpRuntime } from "./http-runtime";

/** 显式激活仅有此请求实现；完整响应体也受期限与主体租约约束。 */
export async function requestAttemptActivation(
  http: HttpRuntime,
  attemptId: string,
  request: AttemptActivateRequest,
) {
  return attemptActivateDataSchema.parse(
    await withRequestDeadline(
      (signal) =>
        callApi(() =>
          http.fetch(
            `/api/student/attempts/${encodeURIComponent(attemptId)}/activate`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request),
              signal,
            },
          ),
        ),
      "保存练习记录",
    ),
  );
}
