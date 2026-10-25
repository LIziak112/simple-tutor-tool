import { describe, expect, it } from "vitest";
import { formatResultCounts } from "./result-counts";

describe("题数结果展示", () => {
  it("未做题仍进分母，零个答对是有效结果", () => {
    expect(
      formatResultCounts({
        correctCount: 0,
        totalCount: 5,
        pendingCount: 0,
        pendingSelfReviewCount: 0,
      }),
    ).toBe("做对 0 / 5 题");
  });
  it("待批与待自评分开标识，已有徽章时只显示题数", () => {
    const counts = {
      correctCount: 2,
      totalCount: 5,
      pendingCount: 1,
      pendingSelfReviewCount: 1,
    };
    expect(formatResultCounts(counts)).toBe(
      "做对 2 / 5 题 · 待批 1 题 · 待自评 1 题",
    );
    expect(formatResultCounts(counts, false)).toBe("做对 2 / 5 题");
  });
  it("旧响应无计数时不猜测", () => {
    expect(formatResultCounts(undefined)).toBe("—");
    expect(formatResultCounts(null)).toBe("—");
  });
});
