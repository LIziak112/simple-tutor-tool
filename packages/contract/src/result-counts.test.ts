import { describe, expect, it } from "vitest";
import { attemptResultCountsSchema } from "./result-counts";

describe("作答题数契约", () => {
  it("未做与待判题留在总题数，计数不能超过总题数", () => {
    expect(
      attemptResultCountsSchema.parse({
        correctCount: 2,
        totalCount: 5,
        pendingCount: 1,
        pendingSelfReviewCount: 1,
      }).totalCount,
    ).toBe(5);
    expect(
      attemptResultCountsSchema.safeParse({
        correctCount: 6,
        totalCount: 5,
        pendingCount: 0,
        pendingSelfReviewCount: 0,
      }).success,
    ).toBe(false);
  });
});
