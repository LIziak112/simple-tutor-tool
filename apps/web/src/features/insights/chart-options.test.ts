import type {
  AnalyticsKnowledgeRow,
  AnalyticsTrendPoint,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  buildKnowledgeBarOption,
  buildTrendOption,
  knowledgeRowsForChart,
  rateColorOf,
  rateToPercent,
  weekLabelOf,
} from "./chart-options";

/**
 * 图表 option 构造（纯函数）测试（T4.2）：jsdom 无法渲染 canvas，图表页测试
 * 断言数据装配（类目/数值/排序/空档）而非像素——本文件锁定装配口径。
 */

function trendPoint(
  overrides: Partial<AnalyticsTrendPoint> = {},
): AnalyticsTrendPoint {
  return {
    weekStart: "2026-09-07",
    attemptCount: 1,
    judgedCount: 5,
    correctCount: 4,
    correctRate: 0.8,
    ...overrides,
  };
}

function knowledgeRow(
  overrides: Partial<AnalyticsKnowledgeRow> = {},
): AnalyticsKnowledgeRow {
  return {
    knowledge: "有理数加法",
    correctCount: 3,
    wrongCount: 1,
    pendingCount: 0,
    judgedCount: 4,
    correctRate: 0.75,
    ...overrides,
  };
}

describe("buildTrendOption（周趋势折线）", () => {
  it("类目为自然周短标签、数值换百分制一位小数", () => {
    const option = buildTrendOption([
      trendPoint({ weekStart: "2026-08-31", correctRate: 0.833 }),
      trendPoint({ weekStart: "2026-09-07", correctRate: 1 }),
    ]);
    expect(option.xAxis.data).toEqual(["8/31", "9/7"]);
    expect(option.series[0]?.data).toEqual([83.3, 100]);
    expect(option.series[0]?.connectNulls).toBe(false);
  });

  it("correctRate=null 的周为空档（断线）；y 轴 0–100 百分比", () => {
    const option = buildTrendOption([
      trendPoint({
        weekStart: "2026-08-31",
        correctRate: null,
        judgedCount: 0,
        correctCount: 0,
      }),
      trendPoint({ weekStart: "2026-09-07" }),
    ]);
    expect(option.series[0]?.data).toEqual([null, 80]);
    expect(option.yAxis.min).toBe(0);
    expect(option.yAxis.max).toBe(100);
    expect(option.yAxis.axisLabel.formatter).toBe("{value}%");
  });

  it("tooltip 拼装自然周/正确率/提交份数（空档周显示无已判定题）", () => {
    const points = [
      trendPoint({ weekStart: "2026-08-31", attemptCount: 2 }),
      trendPoint({
        weekStart: "2026-09-07",
        correctRate: null,
        judgedCount: 0,
        attemptCount: 0,
      }),
    ];
    const option = buildTrendOption(points);
    const formatter = option.tooltip.formatter as (
      params: { dataIndex: number }[],
    ) => string;
    expect(formatter([{ dataIndex: 0 }])).toBe(
      "自然周：2026-08-31<br/>正确率：80%<br/>提交 2 份",
    );
    expect(formatter([{ dataIndex: 1 }])).toContain("无已判定题");
  });
});

describe("buildKnowledgeBarOption（考点条形图，D25）", () => {
  it("按正确率升序、薄弱在上（inverse 轴 + 升序数组），取 top N", () => {
    const rows = [
      knowledgeRow({ knowledge: "数轴", correctRate: 0.9, wrongCount: 1 }),
      knowledgeRow({
        knowledge: "有理数的概念",
        correctRate: 0.5,
        wrongCount: 2,
      }),
      knowledgeRow({ knowledge: "相反数", correctRate: 0.7, wrongCount: 1 }),
    ];
    const option = buildKnowledgeBarOption(rows);
    // 升序：最薄弱（0.5）在数组首位，inverse 轴把它渲染在最上方
    expect(option.yAxis.data).toEqual(["有理数的概念", "相反数", "数轴"]);
    expect(option.yAxis.inverse).toBe(true);
    expect(option.series[0]?.data.map((item) => item.value)).toEqual([
      50, 70, 90,
    ]);
  });

  it("无已判定题（null）视为最薄弱排最前，灰色分档", () => {
    const rows = [
      knowledgeRow({ knowledge: "已判定考点", correctRate: 0.6 }),
      knowledgeRow({
        knowledge: "全是待批",
        correctRate: null,
        judgedCount: 0,
        correctCount: 0,
        wrongCount: 0,
        pendingCount: 3,
      }),
    ];
    const sorted = knowledgeRowsForChart(rows);
    expect(sorted[0]?.knowledge).toBe("全是待批");
    expect(rateColorOf(null)).toBe("#a1a1aa");
  });

  it("超过 top N 截断（默认 8）", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      knowledgeRow({ knowledge: `考点${i}`, correctRate: i / 12 }),
    );
    expect(knowledgeRowsForChart(rows)).toHaveLength(8);
    expect(buildKnowledgeBarOption(rows).yAxis.data).toHaveLength(8);
  });

  it("分档配色：<60% 红、60–80% 琥珀、≥80% 绿", () => {
    expect(rateColorOf(0.5)).toBe("#ef4444");
    expect(rateColorOf(0.7)).toBe("#f59e0b");
    expect(rateColorOf(0.8)).toBe("#10b981");
  });

  it("tooltip 拼装对/已判定/待批计数", () => {
    const option = buildKnowledgeBarOption([
      knowledgeRow({ knowledge: "有理数加法", pendingCount: 2 }),
    ]);
    const formatter = option.tooltip.formatter as (param: {
      dataIndex: number;
    }) => string;
    expect(formatter({ dataIndex: 0 })).toBe(
      "有理数加法<br/>正确率：75%（对 3 / 已判定 4）<br/>待批 2 题",
    );
  });
});

describe("换算辅助", () => {
  it("rateToPercent 四舍五入到一位小数；null 透传", () => {
    expect(rateToPercent(0.6666)).toBe(66.7);
    expect(rateToPercent(null)).toBeNull();
  });

  it("weekLabelOf：YYYY-MM-DD → M/D（去前导零）", () => {
    expect(weekLabelOf("2026-08-31")).toBe("8/31");
    expect(weekLabelOf("bad-value")).toBe("bad-value");
  });
});
