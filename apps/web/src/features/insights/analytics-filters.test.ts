import {
  ANALYTICS_DAYS_DEFAULT,
  ANALYTICS_FOCUS_DAYS_DEFAULT,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  analyticsApiParams,
  analyticsUrlQuery,
  defaultAnalyticsUrlState,
  hasActiveAnalyticsFilters,
  parseAnalyticsUrl,
} from "./analytics-filters";

/**
 * 学情筛选 URL 状态解析/序列化测试（T4.2）：非法值回契约默认、
 * 默认值不写 URL、接口参数只携带非默认项。
 */

describe("parseAnalyticsUrl", () => {
  it("缺省全为契约默认（30 天 / 全部课程 / 重点周期 14 天）", () => {
    expect(parseAnalyticsUrl(new URLSearchParams())).toEqual(
      defaultAnalyticsUrlState(),
    );
    expect(ANALYTICS_DAYS_DEFAULT).toBe(30);
    expect(ANALYTICS_FOCUS_DAYS_DEFAULT).toBe(14);
  });

  it("days 支持 all 与整数；非法/越界回默认", () => {
    expect(parseAnalyticsUrl(new URLSearchParams("days=all")).days).toBe("all");
    expect(parseAnalyticsUrl(new URLSearchParams("days=7")).days).toBe(7);
    expect(parseAnalyticsUrl(new URLSearchParams("days=abc")).days).toBe(30);
    expect(parseAnalyticsUrl(new URLSearchParams("days=0")).days).toBe(30);
    expect(parseAnalyticsUrl(new URLSearchParams("days=9999")).days).toBe(30);
  });

  it("focusDays 整数；非法回默认", () => {
    expect(
      parseAnalyticsUrl(new URLSearchParams("focusDays=30")).focusDays,
    ).toBe(30);
    expect(
      parseAnalyticsUrl(new URLSearchParams("focusDays=xx")).focusDays,
    ).toBe(14);
  });

  it("courseId 原样透传（课程存在性由接口口径处理）", () => {
    expect(
      parseAnalyticsUrl(new URLSearchParams("courseId=abc")).courseId,
    ).toBe("abc");
  });
});

describe("analyticsUrlQuery / hasActiveAnalyticsFilters", () => {
  it("默认状态序列化为空 query；非默认项写回", () => {
    expect(analyticsUrlQuery(defaultAnalyticsUrlState()).toString()).toBe("");
    const query = analyticsUrlQuery({
      days: "all",
      courseId: "c1",
      focusDays: 30,
    });
    expect(query.toString()).toBe("days=all&courseId=c1&focusDays=30");
    expect(hasActiveAnalyticsFilters(defaultAnalyticsUrlState())).toBe(false);
    expect(
      hasActiveAnalyticsFilters({ days: 7, courseId: null, focusDays: 14 }),
    ).toBe(true);
  });

  it("往返一致（parse ∘ serialize）", () => {
    const state = { days: 90 as const, courseId: "c1", focusDays: 7 };
    expect(parseAnalyticsUrl(analyticsUrlQuery(state))).toEqual(state);
  });
});

describe("analyticsApiParams", () => {
  it("只携带非默认项；focusDays 仅在 includeFocusDays 时携带", () => {
    expect(analyticsApiParams(defaultAnalyticsUrlState(), true)).toEqual({});
    expect(
      analyticsApiParams({ days: 7, courseId: "c1", focusDays: 30 }, true),
    ).toEqual({ days: 7, courseId: "c1", focusDays: 30 });
    expect(
      analyticsApiParams({ days: 7, courseId: null, focusDays: 30 }, false),
    ).toEqual({ days: 7 });
  });
});
