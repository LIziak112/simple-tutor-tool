import type {
  AssignmentDetailData,
  AssignmentStatus,
  TeacherAssignment,
} from "@tutor/contract";
import {
  Dumbbell,
  Loader2,
  Lock,
  LogOut,
  Pencil,
  UserRoundPlus,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
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
import { useStudents } from "@/features/students/student-queries";
import { ApiError } from "@/lib/api";
import { localInputToUtcIso, utcIsoToLocalInput } from "@/lib/time";
import { useAssignmentDetail, useUpdateAssignment } from "./assignment-queries";
import { DiscardConfirmDialog } from "./DiscardConfirmDialog";

/**
 * 作业编辑弹层（T2A.7 完整版，D13/D14）：
 * - 名单区：每人状态徽章（未开始/进行中/已交卷/已批改，来自详情 roster）+
 *   移出按钮（支持多选批量移出，§4-2）；「补充课程新成员（N 人）」快捷入口
 *   （courseNewMembers，无课程或无新成员时隐藏）与通用「添加学生」；
 * - 移出未开始学生直接调用 PATCH；移出已开始/已交卷学生 → 后端 409
 *   CONFIRM_REQUIRED（extra._students 附名单）→ 二次确认列出姓名与影响
 *   （§4-1：该作业从其待办消失、已交卷结果保留）→ 带 confirmStarted 重发；
 * - 内容锁定展示（D14）：locked 时单元列表只读并说明锁定原因与人数；
 *   标题、截止时间、名单不受锁定影响，仍可编辑；
 * - 标题/截止/公布时机（T2A.8：交卷即公布（默认）/ 截止后公布——后者须保留
 *   截止时间，否则即时提示并阻止保存）为表单暂存编辑，有未保存改动时关闭需
 *   确认（§4-5）。
 */

/** 名单状态徽章文案（D13） */
const ROSTER_STATUS_LABELS: Record<AssignmentStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  submitted: "已交卷",
  graded: "已批改",
};

/** 状态徽章配色（进行中蓝、已交卷琥珀、已批改绿） */
const ROSTER_STATUS_BADGE_CLASS: Record<AssignmentStatus, string> = {
  not_started: "bg-muted text-muted-foreground",
  in_progress: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  submitted: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  graded: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
};

/** 409 CONFIRM_REQUIRED 错误体携带的受影响学生（D13） */
interface ConfirmStudent {
  studentId: string;
  displayName: string;
}

export function AssignmentEditDialog({
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
    assignment.dueAt !== null ? utcIsoToLocalInput(assignment.dueAt) : "",
  );
  /** 答案公布时机（T2A.8）：与标题/截止同一「暂存编辑、保存提交」表单 */
  const [answerRelease, setAnswerRelease] = useState(assignment.answerRelease);
  /** 名单中勾选待移出的学生（多选批量，§4-2） */
  const [selectedRemove, setSelectedRemove] = useState<ReadonlySet<string>>(
    new Set(),
  );
  /** 待二次确认重发的移出清单（409 CONFIRM_REQUIRED 触发时冻结） */
  const [pendingRemoveIds, setPendingRemoveIds] = useState<string[] | null>(
    null,
  );
  const [confirmStudents, setConfirmStudents] = useState<
    ConfirmStudent[] | null
  >(null);
  /** 加入名单弹层：course = 补充课程新成员；any = 从学生列表添加 */
  const [addMode, setAddMode] = useState<"course" | "any" | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const detail = detailQuery.data;

  /** 标题/截止/公布时机是否有未保存改动（名单操作是即时的，不参与） */
  const metaDirty =
    title !== assignment.title ||
    dueLocal !==
      (assignment.dueAt !== null ? utcIsoToLocalInput(assignment.dueAt) : "") ||
    answerRelease !== assignment.answerRelease;

  /**
   * T2A.8：「截止后公布」必须有截止时间。改后状态的截止 = 表单值非空则新值，
   * 清空则取消截止（null）——即 dueLocal 为空时改后恒无截止，此时选 after_due
   * 即时提示并阻止保存（服务端同口径 400，双保险）。
   */
  const releaseBlocked = answerRelease === "after_due" && dueLocal.length === 0;

  function requestClose(): void {
    if (updateMutation.isPending) return;
    if (metaDirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  /** 组装标题/截止/公布时机的增量 PATCH：只带发生变化的字段 */
  function buildMetaRequest() {
    const trimmed = title.trim();
    const nextDue =
      dueLocal.length > 0
        ? localInputToUtcIso(dueLocal)
        : assignment.dueAt !== null
          ? null
          : undefined;
    return {
      ...(trimmed.length > 0 && trimmed !== assignment.title
        ? { title: trimmed }
        : {}),
      ...(nextDue !== undefined && nextDue !== assignment.dueAt
        ? { dueAt: nextDue }
        : {}),
      ...(answerRelease !== assignment.answerRelease ? { answerRelease } : {}),
    };
  }

  function handleMetaSubmit(event: React.FormEvent): void {
    event.preventDefault();
    if (releaseBlocked) return;
    updateMutation.mutate(
      { id: assignment.id, request: buildMetaRequest() },
      { onSuccess: onClose },
    );
  }

  /** 移出学生（未开始直接生效；已开始/已交卷由后端 409 触发二次确认） */
  function removeStudents(studentIds: string[]): void {
    if (studentIds.length === 0) return;
    setPendingRemoveIds(studentIds);
    updateMutation.mutate(
      { id: assignment.id, request: { removeStudentIds: studentIds } },
      {
        onSuccess: () => {
          setPendingRemoveIds(null);
          setSelectedRemove(new Set());
        },
        onError: (error) => {
          if (
            error instanceof ApiError &&
            error.code === "CONFIRM_REQUIRED" &&
            Array.isArray(error.extra?._students)
          ) {
            setConfirmStudents(error.extra._students as ConfirmStudent[]);
          } else {
            setPendingRemoveIds(null);
          }
        },
      },
    );
  }

  /** 二次确认后带 confirmStarted 重发（D13） */
  function confirmRemoveStarted(): void {
    const ids = pendingRemoveIds ?? [];
    setConfirmStudents(null);
    updateMutation.mutate(
      {
        id: assignment.id,
        request: { removeStudentIds: ids, confirmStarted: true },
      },
      {
        onSuccess: () => {
          setPendingRemoveIds(null);
          setSelectedRemove(new Set());
        },
      },
    );
  }

  /** 加入名单（补充课程新成员 / 从学生列表添加共用） */
  function addStudents(studentIds: string[]): void {
    if (studentIds.length === 0) return;
    updateMutation.mutate({
      id: assignment.id,
      request: { addStudentIds: studentIds },
    });
  }

  function toggleRemoveSelect(id: string, checked: boolean): void {
    setSelectedRemove((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  const mutationError =
    updateMutation.isError && updateMutation.error instanceof ApiError
      ? updateMutation.error.message
      : updateMutation.isError
        ? "操作失败，请稍后重试"
        : null;

  const busy = updateMutation.isPending;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : requestClose())}>
      <DialogContent className="max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑作业</DialogTitle>
          <DialogDescription>
            可修改标题、截止时间与指派名单（增删学生即时生效）
            {assignment.courseName !== null
              ? `；所属课程：${assignment.courseName}`
              : ""}
            。
          </DialogDescription>
        </DialogHeader>

        {detailQuery.isPending || detail === undefined ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            正在加载作业详情…
          </p>
        ) : detailQuery.isError ? (
          <div role="alert" className="flex flex-col gap-2 py-4">
            <p className="text-sm font-medium text-destructive">详情加载失败</p>
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
          <div className="flex flex-col gap-4">
            {/* 作业内容（只读；D14 锁定原因展示） */}
            <section className="flex flex-col gap-1.5 rounded-xl border border-border p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Dumbbell
                  aria-hidden
                  className="size-4 text-muted-foreground"
                />
                作业内容（{detail.units.length} 个单元 · 共{" "}
                {detail.totalQuestionCount} 题）
              </p>
              {detail.locked && (
                <p className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Lock aria-hidden className="size-4 shrink-0" />
                  已有 {detail.startedCount} 名学生开始作答，内容已锁定；
                  标题、截止时间与名单仍可修改。
                </p>
              )}
              <ol className="flex flex-col gap-1">
                {detail.units.map((unit, index) => (
                  <li
                    key={unit.unitId}
                    className={`text-sm text-muted-foreground ${
                      unit.deleted ? "line-through opacity-70" : ""
                    }`}
                  >
                    {index + 1}. {unit.title}（{unit.questionCount} 题）
                    {unit.deleted && "（已删除）"}
                  </li>
                ))}
              </ol>
              {!detail.locked && (
                <p className="text-xs text-muted-foreground">
                  单元内容在布置时确定；如需调整内容，请另布置一份作业。
                </p>
              )}
            </section>

            {/* 标题 / 截止 / 公布时机（暂存编辑，保存提交） */}
            <form className="flex flex-col gap-3" onSubmit={handleMetaSubmit}>
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
              {/* T2A.8（D11）答案公布时机；after_due 需要截止时间 */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="edit-release" className="text-sm">
                  答案公布时机
                </label>
                <select
                  id="edit-release"
                  value={answerRelease}
                  onChange={(e) =>
                    // 选项值受下方两个 option 约束，收窄安全
                    setAnswerRelease(
                      e.target.value as "on_submit" | "after_due",
                    )
                  }
                  className="flex h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                >
                  <option value="on_submit">交卷即公布（默认）</option>
                  <option value="after_due">
                    截止后公布（须保留截止时间）
                  </option>
                </select>
                {releaseBlocked && (
                  <p role="alert" className="text-xs text-destructive">
                    「截止后公布」需要截止时间：请先填写截止时间，或改回「交卷即公布」。
                  </p>
                )}
              </div>
              <Button
                type="submit"
                variant="outline"
                className="min-h-11 self-start px-4"
                disabled={busy || !metaDirty || releaseBlocked}
              >
                {busy ? (
                  <Loader2 aria-hidden className="animate-spin" />
                ) : (
                  <Pencil aria-hidden />
                )}
                保存标题与截止
              </Button>
            </form>

            {/* 名单（每人状态徽章 + 移出；批量多选 §4-2） */}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm">
                指派名单（{detail.roster.length} 人）
              </legend>
              <div className="flex flex-wrap gap-2">
                {detail.courseId !== null &&
                  detail.courseNewMembers.length > 0 && (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={busy}
                      onClick={() => setAddMode("course")}
                    >
                      <UserRoundPlus aria-hidden />
                      补充课程新成员（{detail.courseNewMembers.length} 人）
                    </Button>
                  )}
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => setAddMode("any")}
                >
                  <UserRoundPlus aria-hidden />
                  添加学生
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11 text-destructive hover:text-destructive"
                  disabled={selectedRemove.size === 0 || busy}
                  onClick={() => removeStudents([...selectedRemove])}
                >
                  <LogOut aria-hidden />
                  移出所选
                  {selectedRemove.size > 0
                    ? `（${selectedRemove.size} 人）`
                    : ""}
                </Button>
              </div>

              {detail.roster.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                  名单为空：学生看不到这份作业，可通过上方按钮添加。
                </p>
              ) : (
                <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1">
                  {detail.roster.map((entry) => (
                    <li
                      key={entry.studentId}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5"
                    >
                      <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-3 rounded-md px-1 text-sm outline-none select-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
                        <input
                          type="checkbox"
                          className="size-5 accent-primary"
                          aria-label={`选择 ${entry.displayName}`}
                          checked={selectedRemove.has(entry.studentId)}
                          onChange={(e) =>
                            toggleRemoveSelect(
                              entry.studentId,
                              e.target.checked,
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {entry.displayName}
                        </span>
                        {/* T3.1（D8）：已开始的名单状态徽章可点进该生 attempt 详情；
                            未开始（attemptId=null）为纯徽章。链接在 label 内点击不会
                            触发勾选（label 对交互后代不转发激活行为） */}
                        {entry.attemptId !== null ? (
                          <Link
                            to={`/t/data/attempts/${entry.attemptId}`}
                            aria-label={`查看 ${entry.displayName} 的作答详情`}
                            className={`inline-flex min-h-11 shrink-0 items-center rounded-md px-2 text-xs underline-offset-2 outline-none transition-colors hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 ${ROSTER_STATUS_BADGE_CLASS[entry.status]}`}
                          >
                            {ROSTER_STATUS_LABELS[entry.status]}
                          </Link>
                        ) : (
                          <span
                            className={`shrink-0 rounded-md px-2 py-0.5 text-xs ${ROSTER_STATUS_BADGE_CLASS[entry.status]}`}
                          >
                            {ROSTER_STATUS_LABELS[entry.status]}
                          </span>
                        )}
                      </label>
                      <Button
                        variant="ghost"
                        className="min-h-11 shrink-0 px-3 text-destructive hover:text-destructive"
                        aria-label={`移出 ${entry.displayName}`}
                        disabled={busy}
                        onClick={() => removeStudents([entry.studentId])}
                      >
                        <LogOut aria-hidden className="size-4" />
                        移出
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>

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
                onClick={requestClose}
                disabled={busy}
              >
                取消
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* 移出已开始学生的二次确认（D13；409 CONFIRM_REQUIRED 后出现，§4-1 影响说明） */}
        {confirmStudents !== null && (
          <Dialog
            open
            onOpenChange={(open) =>
              open ? undefined : setConfirmStudents(null)
            }
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>确认移出已开始作答的学生</DialogTitle>
                <DialogDescription asChild>
                  <div className="flex flex-col gap-2">
                    <p>
                      以下学生已开始作答这份作业：
                      {confirmStudents
                        .map((student) => student.displayName)
                        .join("、")}
                      。
                    </p>
                    <p>
                      移出后：该作业从其待办中消失；已交卷的结果保留在其记录中；
                      教师侧数据保留。
                    </p>
                  </div>
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setConfirmStudents(null)}
                  disabled={busy}
                >
                  取消
                </Button>
                <Button
                  className="min-h-11 px-4"
                  onClick={confirmRemoveStarted}
                  disabled={busy}
                >
                  确认移出
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* 加入名单（补充课程新成员 / 从学生列表添加共用弹层） */}
        {addMode !== null && detail !== undefined && (
          <AddStudentsDialog
            mode={addMode}
            courseNewMembers={detail.courseNewMembers}
            students={studentsQuery.data?.students ?? []}
            rosterIds={new Set(detail.roster.map((entry) => entry.studentId))}
            busy={busy}
            onClose={() => setAddMode(null)}
            onSubmit={addStudents}
          />
        )}

        {/* 标题/截止/公布时机未保存改动时的关闭守卫（§4-5） */}
        {confirmDiscard && (
          <DiscardConfirmDialog
            description="关闭后已修改但未保存的标题/截止时间/公布时机会丢失（名单操作即时生效，不受影响）。"
            onCancel={() => setConfirmDiscard(false)}
            onDiscard={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 加入名单弹层：mode=course 列 courseNewMembers；mode=any 列不在名单的未归档学生 */
function AddStudentsDialog({
  mode,
  courseNewMembers,
  students,
  rosterIds,
  busy,
  onClose,
  onSubmit,
}: {
  mode: "course" | "any";
  courseNewMembers: AssignmentDetailData["courseNewMembers"];
  students: { id: string; displayName: string }[];
  rosterIds: ReadonlySet<string>;
  busy: boolean;
  onClose: () => void;
  onSubmit: (studentIds: string[]) => void;
}) {
  const candidates =
    mode === "course"
      ? courseNewMembers.map((member) => ({
          studentId: member.studentId,
          displayName: member.displayName,
        }))
      : students
          .filter((student) => !rosterIds.has(student.id))
          .map((student) => ({
            studentId: student.id,
            displayName: student.displayName,
          }));
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  function toggle(id: string, checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "course" ? "补充课程新成员" : "添加学生"}
          </DialogTitle>
          <DialogDescription>
            {mode === "course"
              ? "这些学生是课程成员但不在本作业名单中，勾选后加入（新加入立即可见作业）。"
              : "从学生名单中多选加入本作业；已在名单中的学生不再列出。"}
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
            {mode === "course"
              ? "课程成员都已在名单中。"
              : "没有可添加的学生（未归档学生都已在名单中）。"}
          </p>
        ) : (
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {candidates.map((candidate) => (
              <li key={candidate.studentId}>
                <label
                  className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    selected.has(candidate.studentId)
                      ? "border-primary/50 bg-primary/5"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="size-5 shrink-0 accent-[var(--color-primary)]"
                    checked={selected.has(candidate.studentId)}
                    onChange={(e) =>
                      toggle(candidate.studentId, e.target.checked)
                    }
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {candidate.displayName}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </Button>
          <Button
            type="button"
            className="min-h-11 px-4"
            disabled={busy || selected.size === 0}
            onClick={() => {
              onSubmit([...selected]);
              onClose();
            }}
          >
            {busy ? (
              <Loader2 aria-hidden className="animate-spin" />
            ) : (
              <UserRoundPlus aria-hidden />
            )}
            加入名单{selected.size > 0 ? `（${selected.size} 人）` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
