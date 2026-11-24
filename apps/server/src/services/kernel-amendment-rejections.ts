import {
  ChoiceDraftConflict,
  ChoiceSnapshotRevisionConflict,
  LearningError,
  QuestionDeliveryConflict,
} from "learning-kernel";
import { HttpError } from "../lib/http-error.ts";
import { responseEvidenceExists } from "./teacher-response-snapshot.ts";

/** 教师草稿修正（单选整卷槽与题组交付槽共用）的拒绝映射。 */
export function notInProgress() {
  return new HttpError(
    409,
    "ATTEMPT_NOT_IN_PROGRESS",
    "只能修改未作废的进行中练习",
  );
}

export function revisionConflict() {
  return new HttpError(
    409,
    "ANSWER_REVISION_CONFLICT",
    "本题已更新，请重新查询",
  );
}

export function amendmentForbidden() {
  return new HttpError(403, "FORBIDDEN", "当前教师无权修改这份作答");
}

export function knownRejection(error: unknown) {
  if (
    error instanceof ChoiceDraftConflict ||
    error instanceof ChoiceSnapshotRevisionConflict ||
    error instanceof QuestionDeliveryConflict
  )
    return revisionConflict();
  if (error instanceof LearningError) {
    if (
      error.code === "ALREADY_SUBMITTED" ||
      error.code === "ACTIVITY_ABANDONED"
    )
      return notInProgress();
    if (error.code === "INVALID_QUESTION" || error.code === "INVALID_KEY")
      return new HttpError(
        400,
        "VALIDATION_ERROR",
        "题面勘误与冻结题型或评分不一致",
      );
    if (error.code === "RESPONSE_EVIDENCE_EXISTS")
      return responseEvidenceExists();
  }
  return undefined;
}
