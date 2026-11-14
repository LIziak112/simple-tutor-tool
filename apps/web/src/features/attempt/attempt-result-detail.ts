import type { AttemptDetailData, AttemptResultData } from "@tutor/contract";
export function isResultDetail(
  data: AttemptDetailData,
): data is AttemptResultData {
  return data.attempt.status !== "draft";
}
