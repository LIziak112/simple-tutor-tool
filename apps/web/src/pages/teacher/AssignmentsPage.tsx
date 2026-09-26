import type { TeacherAssignment } from "@tutor/contract";
import {
  CalendarClock,
  ClipboardList,
  ClipboardPen,
  ListChecks,
  Loader2,
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
  useCreateAssignment,
  useDeleteAssignment,
  useTeacherAssignments,
  useUpdateAssignment,
} from "@/features/assignments/assignment-queries";
import { useContentTree } from "@/features/content/content-queries";
import { DeleteConfirmDialog } from "@/features/content/DeleteConfirmDialog";
import { useStudents } from "@/features/students/student-queries";
import { ApiError } from "@/lib/api";
import {
  formatDueTime,
  formatRelativeTime,
  localInputToUtcIso,
  utcIsoToLocalInput,
} from "@/lib/time";

/**
 * /t/assignments 作业页（T2.2）：布置作业 + 作业列表。
 * - 布置流程：选单元（只列有题目的练习单元）→ 选学生（多选）→ 截止时间可选 → 确认；
 * - 列表卡片：标题、单元、题数、学生名单、截止时间、编辑与删除；
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
  const assignmentsQuery = useTeacherAssignments(includeDeleted);

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">作业</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            选一份练习单元布置给学生，随时查看与调整指派名单。
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
        <AssignmentFormDialog
          editing={null}
          onClose={() => setFormOpen(false)}
        />
      )}
      {editing && (
        <AssignmentFormDialog
          editing={editing}
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
        <p className="ml-auto text-xs text-muted-foreground">
          {formatRelativeTime(assignment.createdAt)}布置
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        单元：{assignment.unitTitle}（{assignment.questionCount} 题）
      </p>

      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <ListChecks
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
        {assignment.students.length > 0
          ? assignment.students.map((student) => student.displayName).join("、")
          : "（无学生）"}
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

// ---------- 布置 / 编辑弹层 ----------

/** 弹层内可选项：练习单元（只列有题目的），含课程分组信息 */
interface UnitOption {
  courseTitle: string;
  unitId: string;
  unitTitle: string;
  questionCount: number;
}

/**
 * 布置（editing=null）/ 编辑（editing=作业）弹层。
 * 单元、学生、内容树数据在弹层打开时才加载（页面首屏不付这个成本）；
 * 编辑模式下单元不可改（PATCH 契约不含 unitId）。
 */
function AssignmentFormDialog({
  editing,
  onClose,
}: {
  editing: TeacherAssignment | null;
  onClose: () => void;
}) {
  const treeQuery = useContentTree();
  const studentsQuery = useStudents(false);
  const createMutation = useCreateAssignment();
  const updateMutation = useUpdateAssignment();

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

  const [unitId, setUnitId] = useState("");
  const [title, setTitle] = useState(editing?.title ?? "");
  const [studentIds, setStudentIds] = useState<ReadonlySet<string>>(
    new Set(editing?.students.map((student) => student.id) ?? []),
  );
  const [dueLocal, setDueLocal] = useState(
    editing?.dueAt ? utcIsoToLocalInput(editing.dueAt) : "",
  );
  const [formError, setFormError] = useState<string | null>(null);

  // 数据未到时 initial state 为空：首项作为派生默认值（避免 useEffect 同步）
  const effectiveUnitId =
    unitId || editing?.unitId || unitOptions[0]?.unitId || "";
  const selectedUnit = unitOptions.find(
    (option) => option.unitId === effectiveUnitId,
  );
  const mutation = editing ? updateMutation : createMutation;
  const mutationError =
    mutation.isError && mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.isError
        ? "操作失败，请稍后重试"
        : null;

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

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (studentIds.size === 0) {
      setFormError("请至少选择一名学生");
      return;
    }
    if (!editing && !selectedUnit) {
      setFormError("请选择练习单元");
      return;
    }
    setFormError(null);

    if (editing) {
      updateMutation.mutate(
        {
          id: editing.id,
          request: {
            studentIds: [...studentIds],
            ...(title.trim().length > 0 ? { title: title.trim() } : {}),
            // 空输入 = 取消截止（原有截止时）；填了值 = 改截止；原本无且留空 = 不动
            ...(dueLocal.length > 0
              ? { dueAt: localInputToUtcIso(dueLocal) }
              : editing.dueAt != null
                ? { dueAt: null }
                : {}),
          },
        },
        { onSuccess: onClose },
      );
      return;
    }
    if (!selectedUnit) return; // 前面已拦，类型收窄防御
    createMutation.mutate(
      {
        unitId: selectedUnit.unitId,
        studentIds: [...studentIds],
        ...(title.trim().length > 0 ? { title: title.trim() } : {}),
        ...(dueLocal.length > 0 ? { dueAt: localInputToUtcIso(dueLocal) } : {}),
      },
      { onSuccess: onClose },
    );
  }

  const hasUnits = unitOptions.length > 0;
  const hasStudents = (studentsQuery.data?.students.length ?? 0) > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "编辑作业" : "布置作业"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "可修改标题、截止时间与指派名单（名单全量替换）；练习单元不可改。"
              : "选择一份练习单元，指派给一名或多名学生；截止时间可不填。"}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          {treeQuery.isPending || studentsQuery.isPending ? (
            <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              正在加载单元与学生…
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="assignment-unit" className="text-sm">
                  练习单元{editing ? "（不可修改）" : ""}
                </label>
                <select
                  id="assignment-unit"
                  value={effectiveUnitId}
                  onChange={(e) => setUnitId(e.target.value)}
                  disabled={editing != null}
                  required={!editing}
                  className="flex h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
                >
                  {unitOptions.length === 0 && (
                    <option value="">（暂无可布置的单元）</option>
                  )}
                  {/* 编辑模式下作业的单元可能已不在可选列表（如题目被删空），保留原值展示 */}
                  {editing && !selectedUnit && (
                    <option value={editing.unitId}>
                      {editing.unitTitle}（当前单元）
                    </option>
                  )}
                  {unitOptions.map((option) => (
                    <option key={option.unitId} value={option.unitId}>
                      {option.courseTitle} / {option.unitTitle}（
                      {option.questionCount} 题）
                    </option>
                  ))}
                </select>
                {!hasUnits && (
                  <p className="text-sm text-muted-foreground">
                    还没有可布置的练习：请先到「内容」页导入带题目的练习文档。
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="assignment-title" className="text-sm">
                  作业标题（可选）
                </label>
                <Input
                  id="assignment-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={
                    selectedUnit
                      ? `默认用单元标题：${selectedUnit.unitTitle}`
                      : "默认用单元标题"
                  }
                  maxLength={100}
                />
              </div>

              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-sm">指派学生（多选，至少一名）</legend>
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
                  {editing?.dueAt != null && " 清空输入并保存 = 取消截止。"}
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
              disabled={mutation.isPending}
            >
              取消
            </Button>
            <Button
              type="submit"
              className="min-h-11 px-4"
              disabled={
                mutation.isPending ||
                treeQuery.isPending ||
                studentsQuery.isPending ||
                (!editing && !hasUnits)
              }
            >
              {mutation.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  保存中…
                </>
              ) : editing ? (
                <>
                  <Pencil aria-hidden />
                  保存修改
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
