import type { TeacherAssignment } from "@tutor/contract";
import {
  CalendarClock,
  ClipboardList,
  ClipboardPen,
  Lock,
  Pencil,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { AssignmentComposeWizard } from "@/features/assignments/AssignmentComposeWizard";
import { AssignmentEditDialog } from "@/features/assignments/AssignmentEditDialog";
import {
  useDeleteAssignment,
  useTeacherAssignments,
} from "@/features/assignments/assignment-queries";
import { DeleteConfirmDialog } from "@/features/content/DeleteConfirmDialog";
import { useTeacherCourses } from "@/features/courses/course-queries";
import { formatDueTime, formatRelativeTime } from "@/lib/time";

/**
 * /t/assignments 作业页（T2.2；T2A.7 完整版）：
 * - 布置：三步向导（对象 → 内容 → 确认，见 AssignmentComposeWizard）；
 * - 列表：课程筛选（全部 / 无课程 / 各课程）+ 卡片（课程名、单元列表含已删标记、
 *   总题数、四态统计、内容锁定、「含已删除单元」标记）；
 * - 编辑：AssignmentEditDialog（名单状态徽章、增删与确认移出、锁定展示）；
 * - 课程页入口：?courseId=<uuid>&compose=1 → 预选该课程并直接打开向导，
 *   消费后 replace 清参避免刷新重复弹层；
 * - 删除为软删（作答保留，学生端立即不可见），二次确认文案说明后果。
 * 三态齐全（加载骨架 / 空态指引 / 错误重试），触控目标 ≥44px。
 */

/** 课程页「布置作业」入口的 courseId 形状校验（UUID；不合法则忽略该参数） */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 课程筛选值：all = 全部；none = 无课程；其余为课程 UUID */
type CourseFilter = "all" | "none" | string;

export function AssignmentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [courseFilter, setCourseFilter] = useState<CourseFilter>("all");
  const [composeOpen, setComposeOpen] = useState(false);
  /** 向导预选课程（课程页入口带入；null = 从空白开始） */
  const [composeCourseId, setComposeCourseId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TeacherAssignment | null>(null);
  const [deleting, setDeleting] = useState<TeacherAssignment | null>(null);

  const coursesQuery = useTeacherCourses(false);
  const assignmentsQuery = useTeacherAssignments(
    courseFilter === "all" ? undefined : courseFilter,
    includeDeleted,
  );

  // 课程页「布置作业」入口：挂载时消费一次 ?courseId&compose=1，随后 replace 清参
  const entryConsumed = useRef(false);
  useEffect(() => {
    if (entryConsumed.current) return;
    entryConsumed.current = true;
    if (searchParams.toString().length === 0) return;
    const courseId = searchParams.get("courseId") ?? "";
    if (searchParams.get("compose") === "1" && UUID_PATTERN.test(courseId)) {
      setComposeCourseId(courseId);
      setComposeOpen(true);
    }
    void setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  function openCompose(courseId: string | null): void {
    setComposeCourseId(courseId);
    setComposeOpen(true);
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">作业</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            选择一个或多个练习单元布置给学生，随时查看与调整指派名单。
          </p>
        </div>
        <Button className="min-h-11 px-4" onClick={() => openCompose(null)}>
          <ClipboardPen aria-hidden />
          布置作业
        </Button>
      </header>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="assignment-course-filter" className="text-sm">
            课程筛选
          </label>
          <select
            id="assignment-course-filter"
            className="min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            value={courseFilter}
            onChange={(e) => setCourseFilter(e.target.value)}
          >
            <option value="all">全部课程</option>
            <option value="none">无课程</option>
            {coursesQuery.data?.courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {assignmentsQuery.data
              ? `共 ${assignmentsQuery.data.assignments.length} 份作业`
              : "…"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            aria-pressed={includeDeleted}
            onClick={() => setIncludeDeleted((v) => !v)}
          >
            {includeDeleted ? "只看未删除" : "显示已删除"}
          </Button>
        </div>
      </div>

      {assignmentsQuery.isPending && <AssignmentsSkeleton />}

      {assignmentsQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            作业加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {assignmentsQuery.error instanceof Error
              ? assignmentsQuery.error.message
              : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void assignmentsQuery.refetch()}
          >
            重试
          </Button>
        </div>
      )}

      {assignmentsQuery.data &&
        (assignmentsQuery.data.assignments.length === 0 ? (
          <AssignmentsEmpty
            filtered={courseFilter !== "all"}
            onCreate={() => openCompose(null)}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {assignmentsQuery.data.assignments.map((assignment) => (
              <AssignmentCard
                key={assignment.id}
                assignment={assignment}
                onEdit={() => setEditing(assignment)}
                onDelete={() => setDeleting(assignment)}
              />
            ))}
          </ul>
        ))}

      {composeOpen && (
        <AssignmentComposeWizard
          initialCourseId={composeCourseId}
          onClose={() => {
            setComposeOpen(false);
            setComposeCourseId(null);
          }}
        />
      )}
      {editing && (
        <AssignmentEditDialog
          assignment={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <DeleteAssignmentDialog
          assignment={deleting}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

// 供 App.tsx 路由级懒加载
export default AssignmentsPage;

// ---------- 加载 / 空态 ----------

/** 加载骨架（不白屏；role=status 让读屏可感知加载中） */
function AssignmentsSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载作业"
      className="flex flex-col gap-3"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-32 animate-pulse rounded-xl border border-border bg-muted/50"
        />
      ))}
      <p className="text-sm text-muted-foreground">正在加载作业…</p>
    </div>
  );
}

/** 空态：解释 + 下一步动作（区分「还没有作业」与「当前筛选为空」） */
function AssignmentsEmpty({
  filtered,
  onCreate,
}: {
  filtered: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
      <ClipboardList aria-hidden className="size-10 text-muted-foreground" />
      {filtered ? (
        <>
          <p className="text-sm font-medium">当前筛选下没有作业</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            换一个课程筛选（或选「全部课程」）再看看。
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium">还没有作业</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            布置第一份作业前，请确认已在「资源库」导入带题目的练习、
            在「学生」页添加学生；作业可包含多个练习单元。
          </p>
        </>
      )}
      <Button className="min-h-11 px-4" onClick={onCreate}>
        <ClipboardPen aria-hidden />
        布置作业
      </Button>
    </div>
  );
}

// ---------- 作业卡片 ----------

function AssignmentCard({
  assignment,
  onEdit,
  onDelete,
}: {
  assignment: TeacherAssignment;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const deleted = assignment.deleted; // 已删作业不可再编辑/删除（编辑会被后端 404）
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-base font-semibold">{assignment.title}</p>
        {assignment.deleted && (
          <p className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            已删除
          </p>
        )}
        {assignment.locked && (
          <p className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            <Lock aria-hidden className="size-3" />
            内容已锁定
          </p>
        )}
        {assignment.containsDeletedUnit && (
          <p className="rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
            含已删除单元
          </p>
        )}
        <p className="ml-auto text-xs text-muted-foreground">
          {formatRelativeTime(assignment.createdAt)}布置
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        {assignment.courseName !== null && (
          <span className="mr-3">课程：{assignment.courseName}</span>
        )}
        <span>共 {assignment.totalQuestionCount} 题</span>
      </p>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        {assignment.units.length > 0 ? (
          assignment.units.map((unit) => (
            <span
              key={unit.unitId}
              className={unit.deleted ? "line-through opacity-70" : undefined}
            >
              {unit.title}（{unit.questionCount} 题）
            </span>
          ))
        ) : (
          <span>（无单元）</span>
        )}
      </p>

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>
          名单 {assignment.studentCount} 人：未开始{" "}
          {assignment.rosterStats.notStarted} · 进行中{" "}
          {assignment.rosterStats.inProgress} · 已交{" "}
          {assignment.rosterStats.submitted} · 已批{" "}
          {assignment.rosterStats.graded}
        </span>
      </p>

      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <CalendarClock aria-hidden className="size-4 shrink-0" />
        {assignment.dueAt
          ? `截止：${formatDueTime(assignment.dueAt)}`
          : "不限截止时间"}
      </p>

      {!deleted && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-11" onClick={onEdit}>
            <Pencil aria-hidden />
            编辑
          </Button>
          <Button variant="outline" className="min-h-11" onClick={onDelete}>
            <Trash2 aria-hidden />
            删除
          </Button>
        </div>
      )}
    </li>
  );
}

// ---------- 删除确认 ----------

function DeleteAssignmentDialog({
  assignment,
  onClose,
}: {
  assignment: TeacherAssignment;
  onClose: () => void;
}) {
  const deleteMutation = useDeleteAssignment();
  return (
    <DeleteConfirmDialog
      title="删除作业"
      targetName={assignment.title}
      description="删除后学生端立即不可见，作答记录会保留（不影响历史统计）。此操作不可恢复。"
      pending={deleteMutation.isPending}
      onConfirm={() =>
        deleteMutation.mutate(assignment.id, { onSuccess: onClose })
      }
      onCancel={onClose}
    />
  );
}
