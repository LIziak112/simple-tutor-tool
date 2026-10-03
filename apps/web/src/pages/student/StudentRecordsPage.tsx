import { History, SearchX, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_STUDENT_RECORDS_URL_STATE,
  hasActiveRecordsFilters,
  parseStudentRecordsUrl,
  StudentRecordsFilters,
  type StudentRecordsUrlState,
  studentRecordsApiParams,
  studentRecordsUrlQuery,
} from "@/features/student/records-filters";
import {
  RecordCard,
  RecordsPagination,
} from "@/features/student/records-views";
import {
  useStudentAssignments,
  useStudentCourses,
} from "@/features/student/student-queries";
import {
  STUDENT_RECORDS_PAGE_SIZE,
  useStudentRecords,
} from "@/features/student/student-records-queries";
import {
  StudentEmptyState,
  StudentPageHeader,
  StudentSectionLink,
} from "@/features/student/student-ui";

/**
 * /s/records 我的记录（T3.5，D10）：本人全部作答的时间倒序索引——作业与
 * 课程练习混排，每条标来源徽章。筛选（来源类型/课程/作业/状态/时间范围）与
 * 分页 offset 全部同步在 URL query（刷新、返回、从结果视图回来都不丢）；
 * 进行中条目「继续作答」、已交/已批「查看结果」都进 /s/attempts/:attemptId
 * （AttemptSession 按 attempt.status 分支）。三态齐全，触控目标 ≥44px。
 * 2026-10 IA 调整：错题本升为一级导航（/s/wrong），页头入口已移除。
 */

/** 加载骨架（不白屏） */
function RecordsSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载我的记录"
      className="flex flex-col gap-3"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-2xl border border-border bg-muted/60"
        />
      ))}
      <p className="text-sm text-muted-foreground">正在加载我的记录…</p>
    </div>
  );
}

/** 空态（区分「还没有作答」与「当前筛选为空」） */
function RecordsEmpty({ filtered }: { filtered: boolean }) {
  return filtered ? (
    <StudentEmptyState
      icon={<SearchX />}
      title="当前筛选下没有记录"
      description="换一组筛选条件（或点「清除筛选」）再看看。"
    />
  ) : (
    <StudentEmptyState
      icon={<History />}
      title="还没有作答记录"
      description="做过的作业和课程练习（包括进行中的）都会汇总在这里，先去首页看看有什么待完成的作业吧。"
      action={
        <StudentSectionLink to="/s/home">回首页看作业</StudentSectionLink>
      }
    />
  );
}

export default function StudentRecordsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // URL query 是筛选/分页的单一事实来源（刷新与返回不丢）
  const state = useMemo(
    () => parseStudentRecordsUrl(searchParams),
    [searchParams],
  );

  // 课程/作业下拉选项（学生现有接口；失败不阻塞列表，只显示「全部」）
  const coursesQuery = useStudentCourses();
  const assignmentsQuery = useStudentAssignments();
  const recordsQuery = useStudentRecords(
    studentRecordsApiParams(state, STUDENT_RECORDS_PAGE_SIZE),
  );

  /** 筛选变化：合并补丁并重置到第一页 */
  function applyPatch(patch: Partial<StudentRecordsUrlState>): void {
    void setSearchParams(
      studentRecordsUrlQuery({ ...state, ...patch, offset: 0 }),
    );
  }

  function resetFilters(): void {
    void setSearchParams(
      studentRecordsUrlQuery({
        ...state,
        sourceType: DEFAULT_STUDENT_RECORDS_URL_STATE.sourceType,
        courseId: null,
        assignmentId: null,
        status: DEFAULT_STUDENT_RECORDS_URL_STATE.status,
        from: "",
        to: "",
        offset: 0,
      }),
    );
  }

  const total = recordsQuery.data?.total ?? 0;

  return (
    <section aria-labelledby="records-title" className="flex flex-col gap-4">
      <StudentPageHeader
        icon={<History />}
        title="我的记录"
        titleId="records-title"
        description="每一次作答都按时间排在这里，点卡片可以回看结果或继续没做完的练习。"
      />

      <StudentRecordsFilters
        state={state}
        courses={coursesQuery.data?.courses ?? []}
        assignments={assignmentsQuery.data?.assignments ?? []}
        onPatch={applyPatch}
        onReset={resetFilters}
      />

      {recordsQuery.isPending && <RecordsSkeleton />}

      {recordsQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-card p-5 dark:border-red-500/30"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            记录加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {recordsQuery.error instanceof Error
              ? recordsQuery.error.message
              : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void recordsQuery.refetch()}
          >
            重试
          </Button>
        </div>
      )}

      {recordsQuery.data &&
        (recordsQuery.data.records.length === 0 ? (
          <RecordsEmpty filtered={hasActiveRecordsFilters(state)} />
        ) : (
          <ol className="flex flex-col gap-2">
            {recordsQuery.data.records.map((row) => (
              <RecordCard key={row.attemptId} row={row} />
            ))}
          </ol>
        ))}

      {recordsQuery.data !== undefined &&
        recordsQuery.data.records.length > 0 && (
          <RecordsPagination
            offset={state.offset}
            limit={STUDENT_RECORDS_PAGE_SIZE}
            total={total}
            onOffsetChange={(offset) =>
              void setSearchParams(studentRecordsUrlQuery({ ...state, offset }))
            }
          />
        )}
    </section>
  );
}
