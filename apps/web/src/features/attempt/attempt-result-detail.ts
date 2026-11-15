import type { AttemptDetailData, AttemptResultData } from "@tutor/contract";
import { attemptPhaseOf } from "@tutor/contract";
export function isResultDetail(
  data: AttemptDetailData,
): data is AttemptResultData {
  return attemptPhaseOf(data.attempt) === "finished";
}
