import {
  ATTEMPT_SNAPSHOT_PROOF_HEADER,
  type AttemptActivateRequest,
  attemptActivateDataSchema,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import { withRequestDeadline } from "@/lib/request-deadline";
import type { HttpRuntime } from "./http-runtime";

/**
 * 开卷与讲练重开请求的客户端选项：声明本前端之后的每次写入都带本稿版本凭据
 * （expectedFrozenAt / questionRevisionId）。服务端只对带这个头的请求重冻未激活
 * 的卷；升级前的旧包不带头也不带凭据，拿回的仍是原来冻结的一版。
 */
export const SNAPSHOT_PROOF_CLIENT = {
  headers: { [ATTEMPT_SNAPSHOT_PROOF_HEADER]: "1" },
} as const;

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
