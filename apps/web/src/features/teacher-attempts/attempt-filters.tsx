import type { AttemptSource, AttemptStatus } from "@tutor/contract";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { localInputToUtcIso } from "@/lib/time";

/**
 * /t/data 筛选条的 URL 状态与 UI（T3.1，D6）：
 * - 筛选条件全部同步进 URL query（view/sourceType/status/studentId/from/to/offset），
 *   刷新、返回、从详情页回列表都不丢（D8 返回保留筛选的前提）；
 * - from/to 在 URL 里存 datetime-local 本地串（用户输入原样可回显），发请求前
 *   才经 localInputToUtcIso 转 UTC ISO（契约要求带 Z）；
 * - 任一筛选变化由页面统一重置 offset（本组件只回调补丁，不直接改 URL）。
 */

/** 三视图（D6）：按课程（默认）/ 按作业 / 按学生 */
export type AttemptViewMode = "course" | "assignment" | "student";

/** 合法视图值集合（URL 参数白名单） */
const VIEW_MODES: readonly AttemptViewMode[] = [
  "course",
  "assignment",
  "student",
];

/** 来源类型筛选（all = 不筛） */
export type SourceFilter = "all" | AttemptSource;
/** 状态筛选（all = 不筛） */
export type StatusFilter = "all" | AttemptStatus;

/** 数据页 URL 状态（筛选 + 视图 + 分页偏移；单一事实来源是 URL query） */
export interface AttemptListUrlState {
  view: AttemptViewMode;
  sourceType: SourceFilter;
  status: StatusFilter;
  studentId: string | null;
  /** datetime-local 本地串；空串 = 未选 */
  from: string;
  to: string;
  offset: number;
}

/** 默认状态（按课程视图、无筛选、第一页） */
export const DEFAULT_ATTEMPT_LIST_URL_STATE: AttemptListUrlState = {
  view: "course",
  sourceType: "all",
  status: "all",
  studentId: null,
  from: "",
  to: "",
  offset: 0,
};

function pickEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

/** URLSearchParams → 页面状态（非法/未知值一律回默认；offset 非法回 0） */
export function parseAttemptListUrl(
  search: URLSearchParams,
): AttemptListUrlState {
  const offset = Number.parseInt(search.get("offset") ?? "", 10);
  return {
    view: pickEnum(search.get("view"), VIEW_MODES, "course"),
    sourceType: pickEnum(
      search.get("sourceType"),
      ["all", "assignment", "course"],
      "all",
    ),
    status: pickEnum(
      search.get("status"),
      ["all", "draft", "submitted", "graded"],
      "all",
    ),
    studentId: search.get("studentId") ?? null,
    from: search.get("from") ?? "",
    to: search.get("to") ?? "",
    offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
  };
}

/** 页面状态 → URLSearchParams（只写非默认项，保持地址干净） */
export function attemptListUrlQuery(
  state: AttemptListUrlState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.view !== "course") params.set("view", state.view);
  if (state.sourceType !== "all") params.set("sourceType", state.sourceType);
  if (state.status !== "all") params.set("status", state.status);
  if (state.studentId !== null) params.set("studentId", state.studentId);
  if (state.from !== "") params.set("from", state.from);
  if (state.to !== "") params.set("to", state.to);
  if (state.offset > 0) params.set("offset", String(state.offset));
  return params;
}

/** 状态里是否任一筛选生效（视图与 offset 不算「筛选」） */
export function hasActiveFilters(state: AttemptListUrlState): boolean {
  return (
    state.sourceType !== "all" ||
    state.status !== "all" ||
    state.studentId !== null ||
    state.from !== "" ||
    state.to !== ""
  );
}

/** 状态 → 列表接口查询参数（from/to 本地串转 UTC ISO；offset 越界由后端兜底） */
export function attemptListApiParams(
  state: AttemptListUrlState,
  limit: number,
): {
  studentId?: string | undefined;
  sourceType?: AttemptSource | undefined;
  status?: AttemptStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  offset: number;
} {
  return {
    ...(state.studentId !== null ? { studentId: state.studentId } : {}),
    ...(state.sourceType !== "all" ? { sourceType: state.sourceType } : {}),
    ...(state.status !== "all" ? { status: state.status } : {}),
    ...(state.from !== "" ? { from: localInputToUtcIso(state.from) } : {}),
    ...(state.to !== "" ? { to: localInputToUtcIso(state.to) } : {}),
    limit,
    offset: state.offset,
  };
}

/**
 * 状态 → CSV 导出接口查询参数（T3.4，D13）：studentId / sourceType / from / to
 * 映射（from/to 与列表同一本地串 → UTC ISO 转换）。status **不映射**——导出
 * 恒为已交卷 attempt 的逐题行，接口无该参数；view / offset 是展示概念同样不携带。
 */
export function exportCsvParamsOf(state: AttemptListUrlState): {
  studentId?: string | undefined;
  sourceType?: AttemptSource | undefined;
  from?: string | undefined;
  to?: string | undefined;
} {
  return {
    ...(state.studentId !== null ? { studentId: state.studentId } : {}),
    ...(state.sourceType !== "all" ? { sourceType: state.sourceType } : {}),
    ...(state.from !== "" ? { from: localInputToUtcIso(state.from) } : {}),
    ...(state.to !== "" ? { to: localInputToUtcIso(state.to) } : {}),
  };
}

/** 视图中文名（切换按钮文案） */
export const VIEW_MODE_LABELS: Record<AttemptViewMode, string> = {
  course: "按课程",
  assignment: "按作业",
  student: "按学生",
};

/**
 * 筛选条（学生下拉数据由页面传入；学生列表加载失败不阻塞页面——只显示「全部学生」）。
 * patch 回调由页面合并进 URL 状态并重置 offset。
 */
export function AttemptListFilters({
  state,
  students,
  onPatch,
  onReset,
}: {
  state: AttemptListUrlState;
  students: { id: string; displayName: string }[];
  onPatch: (patch: Partial<AttemptListUrlState>) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="attempt-source-filter" className="text-sm">
          来源类型
        </label>
        <select
          id="attempt-source-filter"
          className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={state.sourceType}
          onChange={(e) =>
            onPatch({ sourceType: e.target.value as SourceFilter })
          }
        >
          <option value="all">全部来源</option>
          <option value="assignment">作业</option>
          <option value="course">课程练习</option>
        </select>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="attempt-status-filter" className="text-sm">
          状态
        </label>
        <select
          id="attempt-status-filter"
          className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={state.status}
          onChange={(e) => onPatch({ status: e.target.value as StatusFilter })}
        >
          <option value="all">全部状态</option>
          <option value="draft">进行中</option>
          <option value="submitted">已交卷</option>
          <option value="graded">已批改</option>
        </select>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="attempt-student-filter" className="text-sm">
          学生
        </label>
        <select
          id="attempt-student-filter"
          className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={state.studentId ?? ""}
          onChange={(e) =>
            onPatch({
              studentId: e.target.value === "" ? null : e.target.value,
            })
          }
        >
          <option value="">全部学生</option>
          {students.map((student) => (
            <option key={student.id} value={student.id}>
              {student.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="attempt-from-filter" className="text-sm">
          开始日期（从）
        </label>
        <input
          id="attempt-from-filter"
          type="datetime-local"
          className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={state.from}
          onChange={(e) => onPatch({ from: e.target.value })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="attempt-to-filter" className="text-sm">
          结束日期（到）
        </label>
        <input
          id="attempt-to-filter"
          type="datetime-local"
          className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={state.to}
          onChange={(e) => onPatch({ to: e.target.value })}
        />
      </div>

      {hasActiveFilters(state) && (
        <Button variant="outline" className="min-h-11" onClick={onReset}>
          <RotateCcw aria-hidden />
          清除筛选
        </Button>
      )}
    </div>
  );
}
