import {
  type AttemptPartialRequest,
  attemptSettlementResultSchema,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
export async function settleAttempt(
  attemptId: string,
  request: AttemptPartialRequest,
) {
  return attemptSettlementResultSchema.parse(
    await callApi(() =>
      fetch(
        `/api/student/attempts/${encodeURIComponent(attemptId)}/settlements`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
      ),
    ),
  );
}
export async function readSettlement(attemptId: string, seq: number) {
  return attemptSettlementResultSchema.parse(
    await callApi(() =>
      fetch(
        `/api/student/attempts/${encodeURIComponent(attemptId)}/settlements/${seq}`,
        { credentials: "include" },
      ),
    ),
  );
}
