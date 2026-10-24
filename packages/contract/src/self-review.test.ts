import { expect, it } from "vitest";
import { hasReferenceAnswer, selfReviewRequestSchema } from "./self-review.ts";

it("空答案、提示和解析不构成参考答案", () => {
  expect(hasReferenceAnswer({})).toBe(false);
  expect(
    hasReferenceAnswer({
      answers: { kind: "final", answer: "  " },
      solutionMd: " ",
    }),
  ).toBe(false);
  expect(
    hasReferenceAnswer({ answers: { kind: "fill", blanks: [[" "]] } }),
  ).toBe(false);
  expect(hasReferenceAnswer({ answers: { kind: "judge", value: false } })).toBe(
    true,
  );
  expect(hasReferenceAnswer({ solutionMd: "仅有解析" })).toBe(false);
});
it("自评只接受声明与版本，不接受答案或教师字段", () => {
  const request = {
    mark: false,
    baseRevision: 0,
    mutationId: crypto.randomUUID(),
  };
  expect(selfReviewRequestSchema.safeParse(request).success).toBe(true);
  expect(
    selfReviewRequestSchema.safeParse({ ...request, teacherMark: "correct" })
      .success,
  ).toBe(false);
  expect(
    selfReviewRequestSchema.safeParse({ ...request, baseRevision: -1 }).success,
  ).toBe(false);
});
