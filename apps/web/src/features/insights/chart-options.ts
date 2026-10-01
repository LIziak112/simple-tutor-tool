import type {
  AnalyticsKnowledgeRow,
  AnalyticsTrendPoint,
} from "@tutor/contract";

/**
 * 学情图表的 option 构造（T4.2，纯函数、无 echarts 导入）：
 * - 与渲染分离，jsdom 页面测试断言数据装配（类目/数值/排序）而非 canvas 像素；
 * - 数值统一换成百分制（0–100，一位小数），轴与 tooltip 均以 % 呈现；
 * - 颜色为 hex 常量（canvas 不能用 Tailwind class）：薄弱红 / 中等琥珀 / 达标绿 /
 *   无数据灰，与徽章配色同族。
 */

/** 考点条形图最多展示的考点数（D25：按正确率升序 top N，薄弱在上） */
export const KNOWLEDGE_CHART_TOP_N = 8;

/** 正确率分档配色（rate 为 0–1；null = 无已判定题，最薄弱档） */
const RATE_RED = "#ef4444"; // red-500：正确率 < 60%
const RATE_AMBER = "#f59e0b"; // amber-500：60%–80%
const RATE_GREEN = "#10b981"; // emerald-500：≥ 80%
const RATE_GRAY = "#a1a1aa"; // zinc-400：无已判定题

/** rate（0–1 或 null）→ 分档颜色 */
export function rateColorOf(rate: number | null): string {
  if (rate === null) return RATE_GRAY;
  if (rate < 0.6) return RATE_RED;
  if (rate < 0.8) return RATE_AMBER;
  return RATE_GREEN;
}

/** 正确率 → 百分数值（83.3；null → null，折线断开） */
export function rateToPercent(rate: number | null): number | null {
  if (rate === null) return null;
  return Math.round(rate * 1000) / 10;
}

/** weekStart（YYYY-MM-DD，北京日历日）→ 短标签（"8/31"） */
export function weekLabelOf(weekStart: string): string {
  const parts = weekStart.split("-");
  if (parts.length !== 3) return weekStart;
  return `${Number.parseInt(parts[1] as string, 10)}/${Number.parseInt(
    parts[2] as string,
    10,
  )}`;
}

/** echarts tooltip 回调的参数形状（只取我们用到的字段） */
export interface TooltipParam {
  dataIndex: number;
}

/**
 * 周趋势折线 option（D5：自然周连续分桶，无数据的周 attemptCount=0）。
 * correctRate=null 的周折线断开（connectNulls=false），该周 tooltip 显示「无已判定题」。
 */
export function buildTrendOption(points: AnalyticsTrendPoint[]) {
  return {
    grid: { left: 44, right: 16, top: 24, bottom: 32 },
    tooltip: {
      trigger: "axis" as const,
      formatter: (params: TooltipParam | TooltipParam[]): string => {
        const first = Array.isArray(params) ? params[0] : params;
        if (first === undefined) return "";
        const point = points[first.dataIndex];
        if (point === undefined) return "";
        const rate =
          point.correctRate === null
            ? "无已判定题"
            : `${formatRateText(point.correctRate)}`;
        return [
          `自然周：${point.weekStart}`,
          `正确率：${rate}`,
          `提交 ${point.attemptCount} 份`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "category" as const,
      data: points.map((point) => weekLabelOf(point.weekStart)),
      boundaryGap: false,
    },
    yAxis: {
      type: "value" as const,
      min: 0,
      max: 100,
      axisLabel: { formatter: "{value}%" },
    },
    series: [
      {
        type: "line" as const,
        name: "正确率",
        data: points.map((point) => rateToPercent(point.correctRate)),
        connectNulls: false,
        // 空桶（无作答）也画点，但正确率 null → 断线；点大小适配触控
        symbolSize: 8,
        lineStyle: { width: 2 },
        itemStyle: { color: "#2563eb" },
      },
    ],
  };
}

/** rate → 一位小数百分文本（0.833 → "83.3%"） */
function formatRateText(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

/**
 * 考点正确率横向条形 option（D25）：
 * - 按正确率升序取 top N（null 无已判定题视为最薄弱排最前）；薄弱在上；
 * - inverse=true + 升序数组 → 数组首位渲染在顶部（最薄弱在顶）；
 * - 行内配色按分档（rateColorOf），tooltip 展示对/错/待批计数。
 */
export function buildKnowledgeBarOption(
  rows: AnalyticsKnowledgeRow[],
  topN: number = KNOWLEDGE_CHART_TOP_N,
) {
  const sorted = knowledgeRowsForChart(rows, topN);
  return {
    grid: { left: 96, right: 40, top: 16, bottom: 32 },
    tooltip: {
      trigger: "item" as const,
      formatter: (param: TooltipParam): string => {
        const row = sorted[param.dataIndex];
        if (row === undefined) return "";
        const rate =
          row.correctRate === null
            ? "无已判定题"
            : formatRateText(row.correctRate);
        return [
          row.knowledge,
          `正确率：${rate}（对 ${row.correctCount} / 已判定 ${row.judgedCount}）`,
          `待批 ${row.pendingCount} 题`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "value" as const,
      min: 0,
      max: 100,
      axisLabel: { formatter: "{value}%" },
    },
    yAxis: {
      type: "category" as const,
      inverse: true,
      data: sorted.map((row) => row.knowledge),
    },
    series: [
      {
        type: "bar" as const,
        name: "正确率",
        barMaxWidth: 28,
        data: sorted.map((row) => ({
          value: rateToPercent(row.correctRate),
          itemStyle: { color: rateColorOf(row.correctRate) },
        })),
        label: {
          show: true,
          position: "right" as const,
          formatter: (param: TooltipParam): string => {
            const row = sorted[param.dataIndex];
            return row !== undefined && row.correctRate !== null
              ? formatRateText(row.correctRate)
              : "—";
          },
        },
      },
    ],
  };
}

/** 图表用的考点行（升序 + topN；导出供测试直接断言排序） */
export function knowledgeRowsForChart(
  rows: AnalyticsKnowledgeRow[],
  topN: number = KNOWLEDGE_CHART_TOP_N,
): AnalyticsKnowledgeRow[] {
  return [...rows]
    .sort((a, b) => {
      // null（无已判定题）最薄弱排最前；同为 null 按错误数降序
      if (a.correctRate === null && b.correctRate === null) {
        return b.wrongCount - a.wrongCount;
      }
      if (a.correctRate === null) return -1;
      if (b.correctRate === null) return 1;
      if (a.correctRate !== b.correctRate) {
        return a.correctRate - b.correctRate;
      }
      return b.wrongCount - a.wrongCount;
    })
    .slice(0, topN);
}
