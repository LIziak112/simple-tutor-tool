import { describe, expect, it } from "vitest";
import { testPortalRoutes } from "@/test/portal-fixture";
import { memoAbsoluteTime, memoSourceHref } from "./memo-display";

describe("随笔本地分钟", () => {
  it("按记录日期使用DST偏移，无效日期降级", () => {
    const early = memoAbsoluteTime(
      "2026-11-01T05:30:00Z",
      "en-US",
      "America/New_York",
    );
    const late = memoAbsoluteTime(
      "2026-11-01T06:30:00Z",
      "en-US",
      "America/New_York",
    );
    expect(early).toContain("01:30");
    expect(late).toContain("01:30");
    expect(early).toContain("GMT-04:00");
    expect(late).toContain("GMT-05:00");
    expect(memoAbsoluteTime("bad")).toBe("时间不详");
    expect(
      memoAbsoluteTime("2026-01-01T00:00:59Z", "bad_locale", "bad_zone"),
    ).toContain("00:00");
  });
  it("集中生成内部来源链接与节定位", () => {
    expect(
      memoSourceHref(testPortalRoutes, { kind: "unavailable" }),
    ).toBeNull();
    expect(
      memoSourceHref(testPortalRoutes, {
        kind: "lecture",
        lectureId: "l",
        sectionId: "s 1",
      }),
    ).toBe("/s/lectures/l#s%201");
  });
});
