import { ClipboardCheck, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { useStudents } from "@/features/students/student-queries";
import {
  AttemptListFilters,
  type AttemptListUrlState,
  type AttemptViewMode,
  attemptListApiParams,
  attemptListUrlQuery,
  exportCsvParamsOf,
  hasActiveFilters,
  parseAttemptListUrl,
  VIEW_MODE_LABELS,
} from "@/features/teacher-attempts/attempt-filters";
import {
  AttemptGroupedList,
  AttemptListPagination,
} from "@/features/teacher-attempts/attempt-views";
import { ExportCsvButton } from "@/features/teacher-attempts/ExportCsvButton";
import {
  ATTEMPT_PAGE_SIZE,
  useTeacherAttempts,
} from "@/features/teacher-attempts/teacher-attempt-queries";

/**
 * /t/data 作答数据页（T3.1，D5/D6）：教师视角的全部学生作答。
 * - 筛选（来源类型/状态/学生/时间范围）与视图、分页 offset 全部同步在 URL
 *   query——刷新、返回、从详情页回来都不丢；
 * - 三视图（按课程默认 / 按作业 / 按学生）是同一份平铺列表的前端分组；
 * - 进行中（draft）作答也在列表中，徽章显著（D5）；分页作用于底层数据；
 * - 三态齐全（加载骨架 / 空态指引 / 错误重试），触控目标 ≥44px。
 */

/** 视图切换按钮（aria-pressed 表当前视图；触控 ≥44px） */
function ViewSwitcher({
  view,
  onViewChange,
}: {
  view: AttemptViewMode;
  onViewChange: (view: AttemptViewMode) => void;
}) {
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">分组视图</legend>
      {(Object.keys(VIEW_MODE_LABELS) as AttemptViewMode[]).map((mode) => (
        <Button
          key={mode}
          variant={mode === view ? "default" : "outline"}
          className="min-h-11"
          aria-pressed={mode === view}
          onClick={() => onViewChange(mode)}
        >
          {VIEW_MODE_LABELS[mode]}
        </Button>
      ))}
    </fieldset>
  );
}

/** 加载骨架（不白屏） */
function DataPageSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载作答数据"
      className="flex flex-col gap-3"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-xl border border-border bg-muted/50"
        />
      ))}
      <p className="text-sm text-muted-foreground">正在加载作答数据…</p>
    </div>
  );
}

/** 空态（区分「还没有作答」与「当前筛选为空」） */
function DataPageEmpty({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
      {filtered ? (
        <>
          <p className="text-sm font-medium">当前筛选下没有作答</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            换一组筛选条件（或点「清除筛选」）再看看。
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium">还没有作答记录</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            布置作业或开放课程练习后，学生的每一次作答（包括进行中的草稿）
            都会出现在这里。
          </p>
        </>
      )}
    </div>
  );
}

export function DataPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // URL query 是筛选/视图/分页的单一事实来源（刷新与返回不丢）
  const state = useMemo(
    () => parseAttemptListUrl(searchParams),
    [searchParams],
  );

  // 学生筛选项含归档学生（历史作答可能属于已归档学生）
  const studentsQuery = useStudents(true);
  const attemptsQuery = useTeacherAttempts(
    attemptListApiParams(state, ATTEMPT_PAGE_SIZE),
  );

  /** 筛选/视图变化：合并补丁并重置到第一页（D6） */
  function applyPatch(patch: Partial<AttemptListUrlState>): void {
    void setSearchParams(
      attemptListUrlQuery({ ...state, ...patch, offset: 0 }),
    );
  }

  function resetFilters(): void {
    void setSearchParams(
      attemptListUrlQuery({
        ...state,
        sourceType: "all",
        status: "all",
        studentId: null,
        from: "",
        to: "",
        offset: 0,
      }),
    );
  }

  const total = attemptsQuery.data?.total ?? 0;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">作答数据</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            按课程、作业或学生浏览每一次作答；进行中的草稿也会列出，
            点击卡片查看逐题详情。
          </p>
        </div>
        {/* T3.2b：待批队列入口（去 /t/data/pending 连续批改；未批徽章提示待处理） */}
        <div className="flex gap-2">
          <ExportCsvButton params={exportCsvParamsOf(state)} />
          <Button variant="outline" className="min-h-11" asChild>
            <Link to="/t/data/pending" aria-label="打开待批队列">
              <ClipboardCheck aria-hidden />
              待批队列
            </Link>
          </Button>
        </div>
      </header>

      <AttemptListFilters
        state={state}
        students={studentsQuery.data?.students ?? []}
        onPatch={applyPatch}
        onReset={resetFilters}
      />

      <ViewSwitcher
        view={state.view}
        onViewChange={(view) => applyPatch({ view })}
      />

      {attemptsQuery.isPending && <DataPageSkeleton />}

      {attemptsQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            作答数据加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {attemptsQuery.error instanceof Error
              ? attemptsQuery.error.message
              : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void attemptsQuery.refetch()}
          >
            重试
          </Button>
        </div>
      )}

      {attemptsQuery.data &&
        (attemptsQuery.data.attempts.length === 0 ? (
          <DataPageEmpty filtered={hasActiveFilters(state)} />
        ) : (
          <AttemptGroupedList
            attempts={attemptsQuery.data.attempts}
            view={state.view}
          />
        ))}

      {attemptsQuery.data !== undefined &&
        attemptsQuery.data.attempts.length > 0 && (
          <AttemptListPagination
            offset={state.offset}
            limit={ATTEMPT_PAGE_SIZE}
            total={total}
            onOffsetChange={(offset) =>
              void setSearchParams(attemptListUrlQuery({ ...state, offset }))
            }
          />
        )}
    </section>
  );
}

// 供 App.tsx 路由级懒加载
export default DataPage;
