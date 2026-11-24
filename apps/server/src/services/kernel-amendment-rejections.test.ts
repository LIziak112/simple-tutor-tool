import { LearningError } from "learning-kernel";
import { expect, it } from "vitest";
import { HttpError } from "../lib/http-error.ts";
import { knownRejection } from "./kernel-amendment-rejections.ts";

it("内核修正拒绝都映射为宿主错误，暂存意图不会因未知拒绝反复重放", () => {
  const mapped = (code: string, status = 409) =>
    knownRejection(new LearningError(status, code));
  for (const code of ["QUESTION_REVISION_STALE", "OPERATION_CONFLICT"])
    expect(mapped(code)).toMatchObject({
      status: 409,
      code: "ANSWER_REVISION_CONFLICT",
    });
  expect(mapped("ACTIVITY_ABANDONED")).toMatchObject({
    code: "ATTEMPT_NOT_IN_PROGRESS",
  });
  expect(mapped("INVALID_KEY", 422)).toMatchObject({
    status: 400,
    code: "VALIDATION_ERROR",
  });
  expect(mapped("RESPONSE_EVIDENCE_EXISTS")).toBeInstanceOf(HttpError);
  expect(mapped("EVALUATOR_UNAVAILABLE", 503)).toBeUndefined();
});
