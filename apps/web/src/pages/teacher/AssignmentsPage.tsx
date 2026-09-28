import {
  defaultAssignmentTitle,
  type TeacherAssignment,
} from "@tutor/contract";
import {
  CalendarClock,
  ClipboardList,
  ClipboardPen,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  useAssignmentDetail,
  useCreateAssignment,
  useDeleteAssignment,
  useTeacherAssignments,
  useUpdateAssignment,
} from "@/features/assignments/assignment-queries";
import { useContentTree } from "@/features/content/content-queries";
import { DeleteConfirmDialog } from "@/features/content/DeleteConfirmDialog";
import { useTeacherCourses } from "@/features/courses/course-queries";
import { useStudents } from "@/features/students/student-queries";
import { ApiError } from "@/lib/api";
import {
  formatDueTime,
  formatRelativeTime,
  localInputToUtcIso,
  utcIsoToLocalInput,
} from "@/lib/time";

/**
 * /t/assignments 作业页（T2.2；T2A.7 最小可用适配——完整三步向导是下一任务）：
 * - 布置：多单元勾选（内容树按课程分组）+ 可选所属课程 + 学生多选 + 标题/截止；
 * - 列表卡片：课程名、单元列表（含已删标记）、总题数、名单四态统计、
 *   内容锁定与「含已删除单元」标记；
 * - 编辑：标题/截止 + 名单增删（移出已开始学生时二次确认后带 confirmStarted 重发）；
 * - 删除为软删（作答保留，学生端立即不可见），二次确认文案说明后果。
 * 三态齐全（加载骨架 / 空态指引 / 错误重试），触控目标 ≥44px。
 */

export function AssignmentsPage() {
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  /** 正在编辑的作业（null = 关闭编辑弹层） */
  const [editing, setEditing] = useState<TeacherAssignment | null>(null);
  /** 正在删除的作业（null = 关闭删除确认） */
  const [deleting, setDeleting] = useState<TeacherAssignment | null>(null);
  // T2A.7：courseId 筛选 UI 属于完整向导任务，此处先取全量（undefined）
  const assignmentsQuery = useTeacherAssignments(undefined, includeDeleted);

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">作业</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            选若干练习单元布置给学生，随时查看与调整指派名单。
          </p>
        </div>
        <Button className="min-h-11 px-4" onClick={() => setFormOpen(true)}>
          <ClipboardPen aria-hidden />
          布置作业
        </Button>
      </header>

      <div className="flex items-center justify-between gap-3">
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
          <AssignmentsEmpty onCreate={() => setFormOpen(true)} />
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

      {formOpen && (
        <AssignmentCreateDialog onClose={() => setFormOpen(false)} />
      )}
      {editing && (
        <AssignmentEditForm
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

/** 空态：解释 + 下一步动作（含前置条件指引） */
function AssignmentsEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
      <ClipboardList aria-hidden className="size-10 text-muted-foreground" />
      <p className="text-sm font-medium">还没有作业</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        布置第一份作业前，请确认已在「内容」页导入练习、在「学生」页添加学生。
      </p>
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

// ---------- 布置弹层（多单元勾选 + 课程 + 学生） ----------

/** 弹层内可选项：练习单元（只列有题目的），含课程分组信息 */
interface UnitOption {
  courseTitle: string;
  unitId: string;
  unitTitle: string;
  questionCount: number;
}

/**
 * 布置弹层（T2A.7 最小可用版；完整三步向导在下一任务）：
 * - 内容：内容树按课程分组多选单元（勾选顺序即作业内顺序）；
 * - 对象：可选所属课程（选课后名单默认带出课程成员，可逐个取消）+ 学生多选；
 * - 确认：标题缺省「首个单元标题 / 首个单元标题 等 n 个单元」+ 可选截止。
 */
function AssignmentCreateDialog({ onClose }: { onClose: () => void }) {
  const treeQuery = useContentTree();
  const coursesQuery = useTeacherCourses(false);
  const studentsQuery = useStudents(false);
  const createMutation = useCreateAssignment();

  const unitOptions: UnitOption[] =
    treeQuery.data?.courses.flatMap((course) =>
      course.units
        .filter((unit) => unit.questions.length > 0)
        .map((unit) => ({
          courseTitle: course.title,
          unitId: unit.id,
          unitTitle: unit.title,
          questionCount: unit.questions.length,
        })),
    ) ?? [];

  /** 已选单元（数组维护勾选顺序 = 提交的 unitIds 顺序） */
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [courseId, setCourseId] = useState("");
  const [title, setTitle] = useState("");
  const [studentIds, setStudentIds] = useState<ReadonlySet<string>>(new Set());
  const [dueLocal, setDueLocal] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const courseMemberIds = coursesQuery.data?.courses.find(
    (course) => course.id === courseId,
  )?.memberIds;
  const selectedUnits = selectedUnitIds
    .map((id) => unitOptions.find((option) => option.unitId === id))
    .filter((option): option is UnitOption => option !== undefined);

  const mutationError =
    createMutation.isError && createMutation.error instanceof ApiError
      ? createMutation.error.message
      : createMutation.isError
        ? "操作失败，请稍后重试"
        : null;

  function toggleUnit(unitId: string, checked: boolean) {
    setSelectedUnitIds((prev) =>
      checked ? [...prev, unitId] : prev.filter((id) => id !== unitId),
    );
  }

  function toggleStudent(id: string, checked: boolean) {
    setStudentIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  /** 选课 → 名单默认带出全部课程成员（D13；可逐个取消勾选） */
  function handleCourseChange(nextCourseId: string) {
    setCourseId(nextCourseId);
    const members = coursesQuery.data?.courses.find(
      (course) => course.id === nextCourseId,
    )?.memberIds;
    setStudentIds(new Set(members ?? []));
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (selectedUnitIds.length === 0) {
      setFormError("请至少选择一个练习单元");
      return;
    }
    if (studentIds.size === 0) {
      setFormError("请至少选择一名学生");
      return;
    }
    setFormError(null);
    createMutation.mutate(
      {
        unitIds: selectedUnitIds,
        studentIds: [...studentIds],
        ...(courseId.length > 0 ? { courseId } : {}),
        ...(title.trim().length > 0 ? { title: title.trim() } : {}),
        ...(dueLocal.length > 0 ? { dueAt: localInputToUtcIso(dueLocal) } : {}),
      },
      { onSuccess: onClose },
    );
  }

  const hasUnits = unitOptions.length > 0;
  const hasStudents = (studentsQuery.data?.students.length ?? 0) > 0;
  const loading =
    treeQuery.isPending || studentsQuery.isPending || coursesQuery.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>布置作业</DialogTitle>
          <DialogDescription>
            勾选若干练习单元（勾选顺序即作答顺序），指派给一名或多名学生；
            可选所属课程与截止时间。
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          {loading ? (
            <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              正在加载课程、单元与学生…
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="assignment-course" className="text-sm">
                  所属课程（可选；选择后名单默认带出课程成员）
                </label>
                <select
                  id="assignment-course"
                  value={courseId}
                  onChange={(e) => handleCourseChange(e.target.value)}
                  className="flex h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                >
                  <option value="">（不挂课程）</option>
                  {coursesQuery.data?.courses.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.name}（{course.memberCount} 名成员）
                    </option>
                  ))}
                </select>
              </div>

              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-sm">
                  练习单元（多选，按课程分组；勾选顺序即作答顺序）
                </legend>
                {!hasUnits && (
                  <p className="text-sm text-muted-foreground">
                    还没有可布置的练习：请先到「资源库」导入带题目的练习文档。
                  </p>
                )}
                <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1">
                  {unitOptions.map((option) => (
                    <li key={option.unitId}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
                        <input
                          type="checkbox"
                          className="size-5 accent-primary"
                          checked={selectedUnitIds.includes(option.unitId)}
                          onChange={(e) =>
                            toggleUnit(option.unitId, e.target.checked)
                          }
                        />
                        <span>{option.unitTitle}</span>
                        <span className="text-xs text-muted-foreground">
                          {option.courseTitle} · {option.questionCount} 题
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {selectedUnits.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    已选 {selectedUnits.length} 个单元，共{" "}
                    {selectedUnits.reduce(
                      (sum, option) => sum + option.questionCount,
                      0,
                    )}{" "}
                    题。
                  </p>
                )}
              </fieldset>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="assignment-title" className="text-sm">
                  作业标题（可选）
                </label>
                <Input
                  id="assignment-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={
                    selectedUnits.length > 0
                      ? `默认：${defaultAssignmentTitle(
                          selectedUnits.map((option) => option.unitTitle),
                        )}`
                      : "默认用单元标题组合"
                  }
                  maxLength={100}
                />
              </div>

              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-sm">
                  指派学生（多选，至少一名
                  {courseMemberIds !== undefined
                    ? `；已带出课程成员 ${courseMemberIds.length} 人`
                    : ""}
                  ）
                </legend>
                {!hasStudents && (
                  <p className="text-sm text-muted-foreground">
                    还没有学生：请先到「学生」页添加。
                  </p>
                )}
                <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1">
                  {studentsQuery.data?.students.map((student) => (
                    <li key={student.id}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
                        <input
                          type="checkbox"
                          className="size-5 accent-primary"
                          checked={studentIds.has(student.id)}
                          onChange={(e) =>
                            toggleStudent(student.id, e.target.checked)
                          }
                        />
                        <span>{student.displayName}</span>
                        <span className="text-xs text-muted-foreground">
                          {student.loginName}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="assignment-due" className="text-sm">
                  截止时间（可选）
                </label>
                <Input
                  id="assignment-due"
                  type="datetime-local"
                  value={dueLocal}
                  onChange={(e) => setDueLocal(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  按浏览器本地时间输入，保存后换算为北京时间展示。
                </p>
              </div>
            </>
          )}

          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          {mutationError && (
            <p role="alert" className="text-sm text-destructive">
              {mutationError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onClose}
              disabled={createMutation.isPending}
            >
              取消
            </Button>
            <Button
              type="submit"
              className="min-h-11 px-4"
              disabled={createMutation.isPending || loading || !hasUnits}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  保存中…
                </>
              ) : (
                <>
                  <Plus aria-hidden />
                  确认布置
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 编辑弹层（标题/截止 + 名单增删，T2A.7） ----------

/**
 * 编辑弹层：标题/截止 + 名单增删（勾选差集 → addStudentIds / removeStudentIds）。
 * - 名单初始值取详情 roster（在册成员）；保存时按差集增量提交；
 * - 移出已开始作答的学生 → 后端 409 CONFIRM_REQUIRED（extra._students 附名单），
 *   弹层内二次确认后带 confirmStarted: true 重发（D13）；
 * - 单元内容不可改（已有学生开始作答时后端也会 409 ASSIGNMENT_CONTENT_LOCKED）。
 */
export function AssignmentEditForm({
  assignment,
  onClose,
}: {
  assignment: TeacherAssignment;
  onClose: () => void;
}) {
  const detailQuery = useAssignmentDetail(assignment.id);
  const studentsQuery = useStudents(false);
  const updateMutation = useUpdateAssignment();
  const [title, setTitle] = useState(assignment.title);
  const [dueLocal, setDueLocal] = useState(
    assignment.dueAt ? utcIsoToLocalInput(assignment.dueAt) : "",
  );
  /** 在册名单的勾选状态（null = 详情未到，暂不渲染表单） */
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  /** 待确认的「移出已开始学生」名单（409 CONFIRM_REQUIRED 触发） */
  const [confirmStudents, setConfirmStudents] = useState<
    { studentId: string; displayName: string }[] | null
  >(null);
  const [formError, setFormError] = useState<string | null>(null);

  // 详情到达后初始化勾选（在册成员全选）。直接在渲染路径 setState 是受控的
  // 「懒初始化」模式：selected 仍为 null 时才置值，不会循环。
  const roster = detailQuery.data?.roster;
  if (selected === null && roster !== undefined) {
    setSelected(new Set(roster.map((entry) => entry.studentId)));
  }

  const mutationError =
    updateMutation.isError && updateMutation.error instanceof ApiError
      ? updateMutation.error.message
      : updateMutation.isError
        ? "操作失败，请稍后重试"
        : null;

  function toggleStudent(id: string, checked: boolean) {
    setSelected((prev) => {
      if (prev === null) return prev;
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  /** 组装 PATCH 请求：标题/截止 + 名单差集（增/删）+ 可选 confirmStarted */
  function buildRequest(confirmStarted: boolean) {
    const rosterIds = roster?.map((entry) => entry.studentId) ?? [
      ...(selected ?? []),
    ];
    const current = selected ?? new Set(rosterIds);
    const addStudentIds = [...current].filter((id) => !rosterIds.includes(id));
    const removeStudentIds = rosterIds.filter((id) => !current.has(id));
    return {
      id: assignment.id,
      request: {
        ...(title.trim().length > 0 && title.trim() !== assignment.title
          ? { title: title.trim() }
          : {}),
        // 空输入 = 取消截止（原有截止时）；填了值 = 改截止；原本无且留空 = 不动
        ...(dueLocal.length > 0
          ? { dueAt: localInputToUtcIso(dueLocal) }
          : assignment.dueAt != null
            ? { dueAt: null }
            : {}),
        ...(addStudentIds.length > 0 ? { addStudentIds } : {}),
        ...(removeStudentIds.length > 0 ? { removeStudentIds } : {}),
        ...(confirmStarted ? { confirmStarted: true } : {}),
      },
    };
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (selected === null) return;
    setFormError(null);
    updateMutation.mutate(buildRequest(false), {
      onSuccess: onClose,
      onError: (error) => {
        if (
          error instanceof ApiError &&
          error.code === "CONFIRM_REQUIRED" &&
          Array.isArray(error.extra?._students)
        ) {
          setConfirmStudents(
            error.extra._students as {
              studentId: string;
              displayName: string;
            }[],
          );
        }
      },
    });
  }

  function handleConfirmRemove() {
    setConfirmStudents(null);
    updateMutation.mutate(buildRequest(true), { onSuccess: onClose });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑作业</DialogTitle>
          <DialogDescription>
            可修改标题、截止时间与指派名单（增删学生）；练习单元内容不可改
            {assignment.locked
              ? "（已有学生开始作答，内容已锁定）"
              : "，单元在布置时确定"}
            。
          </DialogDescription>
        </DialogHeader>
        {detailQuery.isPending || selected === null ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            正在加载名单…
          </p>
        ) : detailQuery.isError ? (
          <div role="alert" className="flex flex-col gap-2 py-4">
            <p className="text-sm font-medium text-destructive">名单加载失败</p>
            <p className="text-sm text-muted-foreground">
              {detailQuery.error instanceof Error
                ? detailQuery.error.message
                : "网络异常，请稍后重试"}
            </p>
            <Button
              variant="outline"
              className="min-h-11 w-fit"
              onClick={() => void detailQuery.refetch()}
            >
              重试
            </Button>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="edit-title" className="text-sm">
                作业标题
              </label>
              <Input
                id="edit-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={100}
              />
            </div>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm">
                指派学生（勾选即保留或新增，取消勾选即移出）
              </legend>
              <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1">
                {studentsQuery.data?.students.map((student) => (
                  <li key={student.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
                      <input
                        type="checkbox"
                        className="size-5 accent-primary"
                        checked={selected.has(student.id)}
                        onChange={(e) =>
                          toggleStudent(student.id, e.target.checked)
                        }
                      />
                      <span>{student.displayName}</span>
                      <span className="text-xs text-muted-foreground">
                        {student.loginName}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="edit-due" className="text-sm">
                截止时间（清空并保存 = 取消截止）
              </label>
              <Input
                id="edit-due"
                type="datetime-local"
                value={dueLocal}
                onChange={(e) => setDueLocal(e.target.value)}
              />
            </div>

            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
            {mutationError && (
              <p role="alert" className="text-sm text-destructive">
                {mutationError}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={onClose}
                disabled={updateMutation.isPending}
              >
                取消
              </Button>
              <Button
                type="submit"
                className="min-h-11 px-4"
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    保存中…
                  </>
                ) : (
                  <>
                    <Pencil aria-hidden />
                    保存修改
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        )}

        {/* 移出已开始学生的二次确认（D13；409 CONFIRM_REQUIRED 后出现） */}
        {confirmStudents !== null && (
          <Dialog
            open
            onOpenChange={(open) => !open && setConfirmStudents(null)}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>确认移出已开始作答的学生</DialogTitle>
                <DialogDescription>
                  以下学生已开始作答这份作业，移出后作业从其待办中消失
                  （已交卷的结果仍保留在其记录中）：
                  {confirmStudents
                    .map((student) => student.displayName)
                    .join("、")}
                  。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setConfirmStudents(null)}
                  disabled={updateMutation.isPending}
                >
                  取消
                </Button>
                <Button
                  className="min-h-11 px-4"
                  onClick={handleConfirmRemove}
                  disabled={updateMutation.isPending}
                >
                  确认移出
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
    </Dialog>
  );
}
