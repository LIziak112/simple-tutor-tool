import type {
  AnalyticsKnowledgeRow,
  AnalyticsTrendPoint,
} from "@tutor/contract";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import type { EChartsCoreOption, EChartsType } from "echarts/core";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useMemo, useRef } from "react";
import { buildKnowledgeBarOption, buildTrendOption } from "./chart-options";

/**
 * 学情页的两张图表（T4.2）——**本模块只经动态 import() 加载**（页面级
 * React.lazy 引用本文件），echarts 相关代码全部落进独立异步 chunk，
 * 不进学情页与主包（架构 §2.2：ECharts 按需加载）。
 *
 * 按需注册（禁全量 import "echarts"）：折线 + 条形 + 网格 + 提示框 + canvas
 * 渲染器，仅此五项；新增图型时在这里补注册。
 *
 * 自有封装直连 echarts/core（替代 echarts-for-react）：其 lib/core 的 CJS
 * default 导出在 Vite 8/rolldown 工具链下互操作解包不一致（dev 预构建与
 * 生产产物均得到 exports 对象而非组件），画像页整树崩溃（React #130）；
 * 生命周期在这里自己管：init → setOption → ResizeObserver 自适应容器尺寸
 * （iPad 横竖屏切换）→ 卸载 dispose。
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

/** EChart 容器透传属性（data-testid / 无障碍标注） */
interface EChartContainerProps {
  "data-testid"?: string;
  role?: string;
  "aria-label"?: string;
}

interface EChartProps extends EChartContainerProps {
  /** echarts option；变更时整体重设（notMerge，防旧系列/旧配色残留） */
  option: EChartsCoreOption;
}

/**
 * 轻量 echarts 封装（仅本模块内部使用）：
 * - 挂载：echarts.init(容器) + ResizeObserver 监听容器尺寸 → resize()；
 * - option 变更：setOption(option, { notMerge: true }) 整体重设；
 * - 卸载：断开监听并 dispose（StrictMode 双挂载下先 dispose 再重建，同样成立）。
 */
function EChart({ option, ...containerProps }: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);

  // 生命周期（仅挂载/卸载一次）：init → 监听尺寸 → 卸载 dispose
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) {
      return undefined;
    }
    const chart = echarts.init(el);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => {
      chart.resize();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // option 变更（挂载时在 init 之后执行一次）：整体重设
  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={containerRef}
      style={{ height: CHART_MIN_HEIGHT, minHeight: CHART_MIN_HEIGHT }}
      {...containerProps}
    />
  );
}

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
  // memo：points 不变时不重复构造 option，避免无谓 setOption
  const option = useMemo(() => buildTrendOption(points), [points]);
  if (points.length === 0 || !hasJudged) {
    return <ChartEmpty text="时间范围内还没有已判定的作答，暂无趋势可看。" />;
  }
  return (
    <EChart
      option={option}
      data-testid="analytics-trend-chart"
      role="img"
      aria-label="总正确率周趋势折线图"
    />
  );
}

/**
 * 考点正确率横向条形图（D25：按正确率升序 top N、薄弱在上，不用雷达图）：
 * 无任何已判定题时空态。
 */
export function KnowledgeBarChart({ rows }: { rows: AnalyticsKnowledgeRow[] }) {
  const hasJudged = rows.some((row) => row.judgedCount > 0);
  const option = useMemo(() => buildKnowledgeBarOption(rows), [rows]);
  if (rows.length === 0 || !hasJudged) {
    return <ChartEmpty text="时间范围内还没有已判定的作答，暂无考点统计。" />;
  }
  return (
    <EChart
      option={option}
      data-testid="analytics-knowledge-chart"
      role="img"
      aria-label="考点正确率条形图，薄弱考点在上"
    />
  );
}
