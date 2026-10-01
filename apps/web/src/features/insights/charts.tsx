import type {
  AnalyticsKnowledgeRow,
  AnalyticsTrendPoint,
} from "@tutor/contract";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import ReactEChartsCore from "echarts-for-react/lib/core";
import { buildKnowledgeBarOption, buildTrendOption } from "./chart-options";

/**
 * 学情页的两张图表（T4.2）——**本模块只经动态 import() 加载**（页面级
 * React.lazy 引用本文件），echarts 相关代码全部落进独立异步 chunk，
 * 不进学情页与主包（架构 §2.2：ECharts 按需加载）。
 *
 * 按需注册（禁全量 import "echarts"）：折线 + 条形 + 网格 + 提示框 + canvas
 * 渲染器，仅此五项；新增图型时在这里补注册。echarts-for-react 走 lib/core
 * 绑定（echarts 实例由 props 注入，支持 tree-shaking），自带 size-sensor
 * 自适应容器宽度（iPad 横竖屏切换自动 resize）。
 */
echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);

/** 图表容器最小高度（触控友好；空数据不渲染 canvas，只出占位文案） */
const CHART_MIN_HEIGHT = 280;

/** 空数据占位（解释性文案，UI 约定三态中的空态） */
function ChartEmpty({ text }: { text: string }) {
  return (
    <p className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
      {text}
    </p>
  );
}

/**
 * 正确率周趋势折线（D5 自然周）：
 * 至少一个周桶有已判定题才渲染 canvas，否则空态。
 */
export function TrendLineChart({ points }: { points: AnalyticsTrendPoint[] }) {
  const hasJudged = points.some((point) => point.judgedCount > 0);
  if (points.length === 0 || !hasJudged) {
    return <ChartEmpty text="时间范围内还没有已判定的作答，暂无趋势可看。" />;
  }
  return (
    <ReactEChartsCore
      echarts={echarts}
      option={buildTrendOption(points)}
      notMerge
      lazyUpdate
      data-testid="analytics-trend-chart"
      role="img"
      aria-label="总正确率周趋势折线图"
      style={{ height: CHART_MIN_HEIGHT, minHeight: CHART_MIN_HEIGHT }}
    />
  );
}

/**
 * 考点正确率横向条形图（D25：按正确率升序 top N、薄弱在上，不用雷达图）：
 * 无任何已判定题时空态。
 */
export function KnowledgeBarChart({ rows }: { rows: AnalyticsKnowledgeRow[] }) {
  const hasJudged = rows.some((row) => row.judgedCount > 0);
  if (rows.length === 0 || !hasJudged) {
    return <ChartEmpty text="时间范围内还没有已判定的作答，暂无考点统计。" />;
  }
  return (
    <ReactEChartsCore
      echarts={echarts}
      option={buildKnowledgeBarOption(rows)}
      notMerge
      lazyUpdate
      data-testid="analytics-knowledge-chart"
      role="img"
      aria-label="考点正确率条形图，薄弱考点在上"
      style={{ height: CHART_MIN_HEIGHT, minHeight: CHART_MIN_HEIGHT }}
    />
  );
}
