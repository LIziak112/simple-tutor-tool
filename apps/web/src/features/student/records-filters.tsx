import type { AttemptSource, AttemptStatus } from "@tutor/contract";
import { CalendarRange, ChevronDown, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { localInputToUtcIso } from "@/lib/time";

/**
 * /s/records 我的记录筛选条的 URL 状态与 UI（T3.5，D10）：
 * - 筛选条件全部同步进 URL query（sourceType/courseId/assignmentId/status/
 *   from/to/offset），刷新、返回、从结果视图回列表都不丢；
 * - from/to 在 URL 里存 datetime-local 本地串（用户输入原样可回显），发请求前
 *   才经 localInputToUtcIso 转 UTC ISO（契约要求带 Z）；
 * - 课程/作业下拉选项由页面从学生现有接口（我的课程 / 我的作业）传入；
 *   选项加载失败不阻塞列表（只显示「全部」占位）；
 * - 任一筛选变化由页面统一重置 offset（本组件只回调补丁，不直接改 URL）。
 */

/** 来源类型筛选（all = 不筛） */
export type RecordsSourceFilter = "all" | AttemptSource;
/** 状态筛选（all = 不筛） */
export type RecordsStatusFilter = "all" | AttemptStatus;

/** 我的记录页 URL 状态（筛选 + 分页偏移；单一事实来源是 URL query） */
export interface StudentRecordsUrlState {
  sourceType: RecordsSourceFilter;
  courseId: string | null;
  assignmentId: string | null;
  status: RecordsStatusFilter;
  /** datetime-local 本地串；空串 = 未选 */
  from: string;
  to: string;
  offset: number;
}

/** 默认状态（无筛选、第一页） */
export const DEFAULT_STUDENT_RECORDS_URL_STATE: StudentRecordsUrlState = {
  sourceType: "all",
  courseId: null,
  assignmentId: null,
  status: "all",
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
export function parseStudentRecordsUrl(
  search: URLSearchParams,
): StudentRecordsUrlState {
  const offset = Number.parseInt(search.get("offset") ?? "", 10);
  const courseId = search.get("courseId");
  const assignmentId = search.get("assignmentId");
  return {
    sourceType: pickEnum(
      search.get("sourceType"),
      ["all", "assignment", "course", "wrong"],
      "all",
    ),
    courseId: courseId !== null && courseId !== "" ? courseId : null,
    assignmentId:
      assignmentId !== null && assignmentId !== "" ? assignmentId : null,
    status: pickEnum(
      search.get("status"),
      ["all", "draft", "submitted", "graded"],
      "all",
    ),
    from: search.get("from") ?? "",
    to: search.get("to") ?? "",
    offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
  };
}

/** 页面状态 → URLSearchParams（只写非默认项，保持地址干净） */
export function studentRecordsUrlQuery(
  state: StudentRecordsUrlState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.sourceType !== "all") params.set("sourceType", state.sourceType);
  if (state.courseId !== null) params.set("courseId", state.courseId);
  if (state.assignmentId !== null) {
    params.set("assignmentId", state.assignmentId);
  }
  if (state.status !== "all") params.set("status", state.status);
  if (state.from !== "") params.set("from", state.from);
  if (state.to !== "") params.set("to", state.to);
  if (state.offset > 0) params.set("offset", String(state.offset));
  return params;
}

/** 状态里是否任一筛选生效（offset 不算「筛选」） */
export function hasActiveRecordsFilters(
  state: StudentRecordsUrlState,
): boolean {
  return (
    state.sourceType !== "all" ||
    state.courseId !== null ||
    state.assignmentId !== null ||
    state.status !== "all" ||
    state.from !== "" ||
    state.to !== ""
  );
}

/** 状态 → 列表接口查询参数（from/to 本地串转 UTC ISO；offset 越界由后端兜底） */
export function studentRecordsApiParams(
  state: StudentRecordsUrlState,
  limit: number,
): {
  sourceType?: AttemptSource | undefined;
  courseId?: string | undefined;
  assignmentId?: string | undefined;
  status?: AttemptStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  offset: number;
} {
  return {
    ...(state.sourceType !== "all" ? { sourceType: state.sourceType } : {}),
    ...(state.courseId !== null ? { courseId: state.courseId } : {}),
    ...(state.assignmentId !== null
      ? { assignmentId: state.assignmentId }
      : {}),
    ...(state.status !== "all" ? { status: state.status } : {}),
    ...(state.from !== "" ? { from: localInputToUtcIso(state.from) } : {}),
    ...(state.to !== "" ? { to: localInputToUtcIso(state.to) } : {}),
    limit,
    offset: state.offset,
  };
}

/**
 * 筛选条（课程/作业下拉选项由页面传入）。patch 回调由页面合并进 URL 状态
 * 并重置 offset。
 */
export function StudentRecordsFilters({
  state,
  courses,
  assignments,
  onPatch,
  onReset,
}: {
  state: StudentRecordsUrlState;
  /** 课程下拉选项（我的课程；加载失败时页面传空数组） */
  courses: { id: string; name: string }[];
  /** 作业下拉选项（我的作业；加载失败时页面传空数组） */
  assignments: { id: string; title: string }[];
  onPatch: (patch: Partial<StudentRecordsUrlState>) => void;
  onReset: () => void;
}) {
  // 时间范围默认收起（学生很少用）；URL 里已有时间筛选时展开，避免「看不到的筛选」
  const [timeOpen, setTimeOpen] = useState(
    () => state.from !== "" || state.to !== "",
  );
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 shadow-xs">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label
            htmlFor="records-source-filter"
            className="text-sm text-muted-foreground"
          >
            来源类型
          </label>
          <select
            id="records-source-filter"
            className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            value={state.sourceType}
            onChange={(e) =>
              onPatch({ sourceType: e.target.value as RecordsSourceFilter })
            }
          >
            <option value="all">全部来源</option>
            <option value="assignment">作业</option>
            <option value="course">课程练习</option>
            <option value="wrong">错题重练</option>
          </select>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label
            htmlFor="records-course-filter"
            className="text-sm text-muted-foreground"
          >
            课程
          </label>
          <select
            id="records-course-filter"
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

        <div className="flex min-w-0 flex-col gap-1.5">
          <label
            htmlFor="records-assignment-filter"
            className="text-sm text-muted-foreground"
          >
            作业
          </label>
          <select
            id="records-assignment-filter"
            className="min-h-11 max-w-56 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            value={state.assignmentId ?? ""}
            onChange={(e) =>
              onPatch({
                assignmentId: e.target.value === "" ? null : e.target.value,
              })
            }
          >
            <option value="">全部作业</option>
            {assignments.map((assignment) => (
              <option key={assignment.id} value={assignment.id}>
                {assignment.title}
              </option>
            ))}
          </select>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label
            htmlFor="records-status-filter"
            className="text-sm text-muted-foreground"
          >
            状态
          </label>
          <select
            id="records-status-filter"
            className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            value={state.status}
            onChange={(e) =>
              onPatch({ status: e.target.value as RecordsStatusFilter })
            }
          >
            <option value="all">全部状态</option>
            <option value="draft">进行中</option>
            <option value="submitted">已交卷</option>
            <option value="graded">已批改</option>
          </select>
        </div>

        <Button
          variant="ghost"
          className="min-h-11 text-muted-foreground"
          aria-expanded={timeOpen}
          aria-controls="records-time-filters"
          onClick={() => setTimeOpen((open) => !open)}
        >
          <CalendarRange aria-hidden />
          按时间筛选
          <ChevronDown
            aria-hidden
            className={
              timeOpen
                ? "rotate-180 transition-transform"
                : "transition-transform"
            }
          />
        </Button>
      </div>

      {timeOpen && (
        <div
          id="records-time-filters"
          className="flex flex-wrap items-end gap-3 border-t border-border pt-3"
        >
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="records-from-filter" className="text-sm">
              开始日期（从）
            </label>
            <input
              id="records-from-filter"
              type="datetime-local"
              className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              value={state.from}
              onChange={(e) => onPatch({ from: e.target.value })}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="records-to-filter" className="text-sm">
              结束日期（到）
            </label>
            <input
              id="records-to-filter"
              type="datetime-local"
              className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              value={state.to}
              onChange={(e) => onPatch({ to: e.target.value })}
            />
          </div>
        </div>
      )}

      {hasActiveRecordsFilters(state) && (
        <div className="flex justify-end border-t border-border pt-3">
          <Button variant="outline" className="min-h-11" onClick={onReset}>
            <RotateCcw aria-hidden />
            清除筛选
          </Button>
        </div>
      )}
    </div>
  );
}
