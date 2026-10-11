import {
  parseStudentRecordsUrl,
  studentRecordsUrlQuery,
} from "./records-filters";

/** 返回上下文只允许记录页，不接受协议、外链、任意路由或未知字段。 */
export function recordsReturnTarget(raw: string | null): string | null {
  if (!raw?.startsWith("/s/records") || raw.startsWith("//")) return null;
  try {
    const url = new URL(raw, "https://student.invalid");
    if (
      url.origin !== "https://student.invalid" ||
      url.pathname !== "/s/records"
    )
      return null;
    const state = parseStudentRecordsUrl(url.searchParams);
    const query = studentRecordsUrlQuery(state).toString();
    return `/s/records${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

export function recordReviewHref(
  attemptId: string,
  search: URLSearchParams,
): string {
  return `/s/attempts/${encodeURIComponent(attemptId)}?${new URLSearchParams({ returnTo: recordsReturnTarget(`/s/records?${search}`) ?? "/s/records" })}`;
}
