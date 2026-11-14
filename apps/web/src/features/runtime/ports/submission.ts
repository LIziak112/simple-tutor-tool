import type { AttemptDetailData, AttemptSubmitRequest } from "@tutor/contract";
export interface SubmissionPorts {
  submitAttemptApi(
    attemptId: string,
    input: AttemptSubmitRequest,
  ): Promise<AttemptDetailData>;
}
