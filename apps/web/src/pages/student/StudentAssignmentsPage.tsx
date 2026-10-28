import { ClipboardList } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type AssignmentListState,
  assignmentDateError,
  assignmentListPage,
  assignmentListQuery,
  filterAssignmentList,
  parseAssignmentListUrl,
} from "@/features/student/assignment-list-filters";
import { useStudentAssignments } from "@/features/student/student-queries";
import {
  StudentAssignmentCard,
  StudentEmptyState,
  StudentErrorPanel,
  StudentListSkeleton,
  StudentPageHeader,
} from "@/features/student/student-ui";

const SELECT_CLASS =
  "min-h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** 完整作业索引：URL 保存筛选与分页，首页只承担待办摘要。 */
export default function StudentAssignmentsPage() {
  const query = useStudentAssignments();
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => parseAssignmentListUrl(params), [params]);
  const filtered = useMemo(
    () => filterAssignmentList(query.data?.assignments ?? [], state),
    [query.data, state],
  );
  const page = assignmentListPage(filtered, state.page);
  const dateError = assignmentDateError(state);
  const hasFilters =
    state.status !== "todo" || state.time !== "all" || state.search !== "";
  const reset = () => setParams(new URLSearchParams());
  const patch = (values: Partial<AssignmentListState>) =>
    setParams(assignmentListQuery({ ...state, ...values, page: 1 }), {
      replace: values.search !== undefined,
    });
  useEffect(() => {
    if (query.data && page.page !== state.page)
      setParams(assignmentListQuery({ ...state, page: page.page }), {
        replace: true,
      });
  }, [query.data, page.page, state, setParams]);
  const sourceQuery = assignmentListQuery({
    ...state,
    page: page.page,
  }).toString();
  const returnTo = `/s/assignments${sourceQuery ? `?${sourceQuery}` : ""}`;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <StudentPageHeader
        icon={<ClipboardList aria-hidden className="size-5" />}
        title="我的作业"
        description="查看待完成和已完成的作业，按布置时间查找。"
      />
      <fieldset
        aria-label="作业筛选"
        className="grid min-w-0 grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto]"
      >
        <label className="flex min-w-0 flex-col gap-1.5 text-sm text-muted-foreground">
          完成状态
          <select
            className={SELECT_CLASS}
            value={state.status}
            onChange={(event) =>
              patch({
                status: parseAssignmentListUrl(
                  new URLSearchParams({ status: event.target.value }),
                ).status,
              })
            }
          >
            <option value="todo">待完成</option>
            <option value="done">已完成</option>
            <option value="all">全部作业</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-sm text-muted-foreground">
          布置时间
          <select
            className={SELECT_CLASS}
            value={state.time}
            onChange={(event) =>
              patch({
                time: parseAssignmentListUrl(
                  new URLSearchParams({ time: event.target.value }),
                ).time,
              })
            }
          >
            <option value="all">全部时间</option>
            <option value="week">最近 7 天</option>
            <option value="month">最近 30 天</option>
            <option value="custom">自定义日期</option>
          </select>
        </label>
        <label
          htmlFor="assignment-search"
          className="flex min-w-0 flex-col gap-1.5 text-sm text-muted-foreground"
        >
          搜索作业标题
          <Input
            id="assignment-search"
            type="search"
            maxLength={200}
            value={state.search}
            placeholder="输入标题关键词"
            onChange={(event) => patch({ search: event.target.value })}
          />
        </label>
        {hasFilters && (
          <Button variant="outline" className="min-h-11" onClick={reset}>
            清除筛选
          </Button>
        )}
      </fieldset>
      {state.time === "custom" && (
        <fieldset
          aria-label="自定义布置日期"
          className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"
        >
          <label
            htmlFor="assignment-from"
            className="flex min-w-0 flex-col gap-1.5 text-sm text-muted-foreground"
          >
            起始日期
            <Input
              id="assignment-from"
              type="date"
              value={state.from}
              aria-invalid={dateError !== null}
              aria-describedby="assignment-date-help"
              onChange={(event) => patch({ from: event.target.value })}
            />
          </label>
          <label
            htmlFor="assignment-to"
            className="flex min-w-0 flex-col gap-1.5 text-sm text-muted-foreground"
          >
            结束日期
            <Input
              id="assignment-to"
              type="date"
              value={state.to}
              aria-invalid={dateError !== null}
              aria-describedby="assignment-date-help"
              onChange={(event) => patch({ to: event.target.value })}
            />
          </label>
          <p
            id="assignment-date-help"
            role={dateError ? "alert" : undefined}
            className={`text-sm sm:col-span-2 ${dateError ? "text-destructive" : "text-muted-foreground"}`}
          >
            {dateError ?? "按北京时间筛选，包含起止当天；日期可只填写一端。"}
          </p>
        </fieldset>
      )}
      {query.isPending ? (
        <StudentListSkeleton label="正在加载作业" rows={2} />
      ) : query.isError ? (
        <StudentErrorPanel
          title="作业加载失败"
          message={
            query.error instanceof Error
              ? query.error.message
              : "网络异常，请稍后重试"
          }
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          <p
            role="status"
            className="text-sm text-muted-foreground tabular-nums"
          >
            共 {page.total} 份作业
            {page.total > 0 && ` · 第 ${page.page} / ${page.pages} 页`}
          </p>
          {dateError ? null : page.total === 0 ? (
            <StudentEmptyState
              compact
              icon={<ClipboardList />}
              title={
                query.data?.assignments.length === 0
                  ? "还没有作业"
                  : "没有符合筛选条件的作业"
              }
              description={
                query.data?.assignments.length === 0
                  ? "老师布置作业后会出现在这里。"
                  : "可以切换完成状态、扩大时间范围，或清除筛选。"
              }
              action={
                hasFilters ? (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={reset}
                  >
                    清除筛选
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <ul aria-label="作业列表" className="flex min-w-0 flex-col gap-3">
                {page.items.map((assignment) => (
                  <StudentAssignmentCard
                    key={assignment.id}
                    assignment={assignment}
                    returnTo={returnTo}
                    showCreatedAt
                  />
                ))}
              </ul>
              <nav
                aria-label="作业分页"
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={page.page === 1}
                  onClick={() =>
                    setParams(
                      assignmentListQuery({ ...state, page: page.page - 1 }),
                    )
                  }
                >
                  上一页
                </Button>
                <span className="text-sm text-muted-foreground tabular-nums">
                  第 {page.page} / {page.pages} 页
                </span>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={page.page === page.pages}
                  onClick={() =>
                    setParams(
                      assignmentListQuery({ ...state, page: page.page + 1 }),
                    )
                  }
                >
                  下一页
                </Button>
              </nav>
            </>
          )}
        </>
      )}
    </div>
  );
}
