import {
  ANALYTICS_DAYS_DEFAULT,
  ANALYTICS_FOCUS_DAYS_DEFAULT,
} from "@tutor/contract";
import { RotateCcw } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import type { AnalyticsFetchParams } from "@/lib/api";

/**
 * 学情页筛选的 URL 状态与筛选条（T4.2，D3/D5）：
 * - days（时间范围快捷项 7/30/90 天/全部，默认 30）与 courseId（含「全部」）
 *   同步进 URL query，刷新、返回、总览 ↔ 题目视角切换都不丢；
 * - focusDays（「下节课重点」周期，默认 14 天，与 days 独立——看的是最近一个
 *   教学周期的错误）只在总览页出现；
 * - 默认值取契约常量（ANALYTICS_DAYS_DEFAULT / ANALYTICS_FOCUS_DAYS_DEFAULT），
 *   页面不另行写死口径。
 */

/** 时间范围取值：正整数天数或 "all"（全部） */
export type AnalyticsDaysValue = number | "all";

/** 时间范围快捷项（D5；30 为默认） */
export const ANALYTICS_DAYS_QUICK: readonly AnalyticsDaysValue[] = [
  7,
  30,
  90,
  "all",
];

/** 快捷项文案 */
export const ANALYTICS_DAYS_LABEL: Record<AnalyticsDaysValue, string> = {
  7: "最近 7 天",
  30: "最近 30 天",
  90: "最近 90 天",
  all: "全部",
};

/** 「下节课重点」周期可选项（天；14 为默认） */
export const ANALYTICS_FOCUS_DAYS_OPTIONS: readonly number[] = [7, 14, 30, 90];

/** 学情页 URL 状态（单一事实来源是 URL query） */
export interface AnalyticsUrlState {
  days: AnalyticsDaysValue;
  /** 课程筛选（D3）；null = 全部 */
  courseId: string | null;
  /** 「下节课重点」周期（天，D5；仅总览页使用与序列化） */
  focusDays: number;
}

/** 默认状态（契约默认：30 天 / 全部课程 / 重点周期 14 天） */
export function defaultAnalyticsUrlState(): AnalyticsUrlState {
  return {
    days: ANALYTICS_DAYS_DEFAULT,
    courseId: null,
    focusDays: ANALYTICS_FOCUS_DAYS_DEFAULT,
  };
}

/** URLSearchParams → 页面状态（非法/越界值一律回契约默认） */
export function parseAnalyticsUrl(search: URLSearchParams): AnalyticsUrlState {
  const rawDays = search.get("days");
  let days: AnalyticsDaysValue = ANALYTICS_DAYS_DEFAULT;
  if (rawDays === "all") {
    days = "all";
  } else if (rawDays !== null && rawDays !== "") {
    const parsed = Number.parseInt(rawDays, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 3650) {
      days = parsed;
    }
  }
  const rawFocus = search.get("focusDays");
  let focusDays = ANALYTICS_FOCUS_DAYS_DEFAULT;
  if (rawFocus !== null && rawFocus !== "") {
    const parsed = Number.parseInt(rawFocus, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 365) {
      focusDays = parsed;
    }
  }
  return {
    days,
    courseId: search.get("courseId"),
    focusDays,
  };
}

/** 页面状态 → URLSearchParams（只写非默认项，保持地址干净） */
export function analyticsUrlQuery(state: AnalyticsUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.days !== ANALYTICS_DAYS_DEFAULT) {
    params.set("days", String(state.days));
  }
  if (state.courseId !== null) params.set("courseId", state.courseId);
  if (state.focusDays !== ANALYTICS_FOCUS_DAYS_DEFAULT) {
    params.set("focusDays", String(state.focusDays));
  }
  return params;
}

/** 状态里是否任一筛选生效（用于「清除筛选」的显隐与空态区分） */
export function hasActiveAnalyticsFilters(state: AnalyticsUrlState): boolean {
  return (
    state.days !== ANALYTICS_DAYS_DEFAULT ||
    state.courseId !== null ||
    state.focusDays !== ANALYTICS_FOCUS_DAYS_DEFAULT
  );
}

/**
 * 状态 → 学情接口查询参数（非默认项才发送；focusDays 只有总览页传
 * includeFocusDays=true 时携带——学生画像/题目视角的响应不消费该参数）。
 */
export function analyticsApiParams(
  state: AnalyticsUrlState,
  includeFocusDays: boolean,
): AnalyticsFetchParams {
  const params: AnalyticsFetchParams = {};
  if (state.courseId !== null) params.courseId = state.courseId;
  if (state.days !== ANALYTICS_DAYS_DEFAULT) params.days = state.days;
  if (includeFocusDays && state.focusDays !== ANALYTICS_FOCUS_DAYS_DEFAULT) {
    params.focusDays = state.focusDays;
  }
  return params;
}

/** 学情两个视图（总览 /t/insights；题目视角 /t/insights/questions） */
export type InsightsViewMode = "overview" | "questions";

/** 视图中文（切换按钮文案） */
export const INSIGHTS_VIEW_LABELS: Record<InsightsViewMode, string> = {
  overview: "总览",
  questions: "题目视角",
};

/**
 * 视图切换（总览 ↔ 题目视角）：用 Link 携带当前筛选 query，切换不丢时间范围
 * 与课程筛选；aria-pressed 表当前视图；触控 ≥44px。
 */
export function InsightsViewSwitcher({
  view,
  query,
}: {
  view: InsightsViewMode;
  query: string;
}) {
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">学情视图</legend>
      {(Object.keys(INSIGHTS_VIEW_LABELS) as InsightsViewMode[]).map((mode) => (
        <Button
          key={mode}
          variant={mode === view ? "default" : "outline"}
          className="min-h-11"
          aria-pressed={mode === view}
          asChild
        >
          <Link
            to={{
              pathname:
                mode === "overview" ? "/t/insights" : "/t/insights/questions",
              search: query,
            }}
          >
            {INSIGHTS_VIEW_LABELS[mode]}
          </Link>
        </Button>
      ))}
    </fieldset>
  );
}

/** 学情筛选条（课程下拉数据由页面传入；patch 回调由页面合并进 URL 状态） */
export function AnalyticsFilterBar({
  state,
  courses,
  showFocusDays,
  onPatch,
  onReset,
}: {
  state: AnalyticsUrlState;
  courses: { id: string; name: string }[];
  showFocusDays: boolean;
  onPatch: (patch: Partial<AnalyticsUrlState>) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-3">
      <fieldset className="flex min-w-0 flex-col gap-1.5">
        <legend className="text-sm">时间范围</legend>
        <div className="flex flex-wrap gap-2">
          {ANALYTICS_DAYS_QUICK.map((value) => (
            <Button
              key={String(value)}
              variant={state.days === value ? "default" : "outline"}
              className="min-h-11"
              aria-pressed={state.days === value}
              onClick={() => onPatch({ days: value })}
            >
              {ANALYTICS_DAYS_LABEL[value]}
            </Button>
          ))}
        </div>
      </fieldset>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="analytics-course-filter" className="text-sm">
          课程
        </label>
        <select
          id="analytics-course-filter"
          className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={state.courseId ?? ""}
          onChange={(e) =>
            onPatch({
              courseId: e.target.value === "" ? null : e.target.value,
            })
          }
        >
          <option value="">全部课程</option>
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.name}
            </option>
          ))}
        </select>
      </div>

      {showFocusDays && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="analytics-focus-days" className="text-sm">
            下节课重点周期
          </label>
          <select
            id="analytics-focus-days"
            className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            value={state.focusDays}
            onChange={(e) =>
              onPatch({ focusDays: Number.parseInt(e.target.value, 10) })
            }
          >
            {ANALYTICS_FOCUS_DAYS_OPTIONS.map((value) => (
              <option key={value} value={value}>
                最近 {value} 天
              </option>
            ))}
          </select>
        </div>
      )}

      {hasActiveAnalyticsFilters(state) && (
        <Button variant="outline" className="min-h-11" onClick={onReset}>
          <RotateCcw aria-hidden />
          清除筛选
        </Button>
      )}
    </div>
  );
}
