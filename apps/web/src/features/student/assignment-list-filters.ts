import type { AssignmentStatus, StudentAssignment } from "@tutor/contract";
import dayjs from "dayjs";
import { DISPLAY_TZ } from "@/lib/time";

/** 页面筛选状态，不参与 API 数据契约。 */
export interface AssignmentListState {
  status: "todo" | "done" | "all";
  time: "all" | "week" | "month" | "custom";
  search: string;
  from: string;
  to: string;
  page: number;
}

export function isAssignmentTodo(status: AssignmentStatus): boolean {
  return status === "not_started" || status === "in_progress";
}

export function parseAssignmentListUrl(
  params: URLSearchParams,
): AssignmentListState {
  const status = params.get("status");
  const time = params.get("time");
  const page = Number(params.get("page"));
  return {
    status: status === "done" || status === "all" ? status : "todo",
    time:
      time === "week" || time === "month" || time === "custom" ? time : "all",
    search: (params.get("q") ?? "").slice(0, 200),
    from: (params.get("from") ?? "").slice(0, 32),
    to: (params.get("to") ?? "").slice(0, 32),
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100_000) : 1,
  };
}

export function assignmentListQuery(
  state: AssignmentListState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.status !== "todo") params.set("status", state.status);
  if (state.time !== "all") params.set("time", state.time);
  if (state.search) params.set("q", state.search);
  if (state.time === "custom") {
    if (state.from) params.set("from", state.from);
    if (state.to) params.set("to", state.to);
  }
  if (state.page > 1) params.set("page", String(state.page));
  return params;
}

function dateStart(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = dayjs.tz(value, DISPLAY_TZ);
  return date.isValid() && date.format("YYYY-MM-DD") === value
    ? date.valueOf()
    : null;
}

export function assignmentDateError(state: AssignmentListState): string | null {
  if (state.time !== "custom") return null;
  if (
    (state.from && dateStart(state.from) === null) ||
    (state.to && dateStart(state.to) === null)
  )
    return "请输入有效的布置日期。";
  if (state.from && state.to && state.from > state.to)
    return "起始日期不能晚于结束日期。";
  return null;
}

export function filterAssignmentList(
  items: readonly StudentAssignment[],
  state: AssignmentListState,
  now: Date = new Date(),
): StudentAssignment[] {
  if (assignmentDateError(state)) return [];
  const day = dayjs(now).tz(DISPLAY_TZ).startOf("day");
  const days = state.time === "week" ? 7 : 30;
  const from =
    state.time === "custom"
      ? state.from
        ? dateStart(state.from)
        : null
      : state.time === "all"
        ? null
        : day.subtract(days - 1, "day").valueOf();
  const to =
    state.time === "custom"
      ? state.to
        ? dayjs.tz(state.to, DISPLAY_TZ).add(1, "day").valueOf()
        : null
      : state.time === "all"
        ? null
        : day.add(1, "day").valueOf();
  const search = state.search.trim().toLocaleLowerCase();
  return items
    .filter((item) => {
      const createdAt = Date.parse(item.createdAt);
      return (
        (state.status === "all" ||
          isAssignmentTodo(item.status) === (state.status === "todo")) &&
        (!search || item.title.toLocaleLowerCase().includes(search)) &&
        (from === null || createdAt >= from) &&
        (to === null || createdAt < to)
      );
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function assignmentListPage(
  items: readonly StudentAssignment[],
  requested: number,
) {
  const pages = Math.max(1, Math.ceil(items.length / 10));
  const page = Math.max(1, Math.min(pages, requested));
  return {
    items: items.slice((page - 1) * 10, page * 10),
    page,
    pages,
    total: items.length,
  };
}

/** 只允许完整作业列表作为来源，过滤外站与未知查询字段。 */
export function assignmentsReturnTarget(raw: string | null): string | null {
  if (!raw || !/^\/s\/assignments(?:[?#]|$)/.test(raw) || raw.includes("\\"))
    return null;
  try {
    const url = new URL(raw, "https://student.invalid");
    if (
      url.origin !== "https://student.invalid" ||
      url.pathname !== "/s/assignments"
    )
      return null;
    const query = assignmentListQuery(
      parseAssignmentListUrl(url.searchParams),
    ).toString();
    return `/s/assignments${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}
