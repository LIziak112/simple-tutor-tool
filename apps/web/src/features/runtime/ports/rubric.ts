import type {
  RubricFinalRequest,
  RubricReview,
  RubricSelfRequest,
} from "@tutor/contract";
export interface RubricPorts {
  saveRubricSelfApi(
    attemptId: string,
    questionId: string,
    request: RubricSelfRequest,
  ): Promise<RubricReview>;
  saveRubricFinalApi(
    attemptId: string,
    questionId: string,
    request: RubricFinalRequest,
  ): Promise<RubricReview>;
}
