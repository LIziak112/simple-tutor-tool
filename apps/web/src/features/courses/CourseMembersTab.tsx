import type { CourseDetailData } from "@tutor/contract";
import {
  Loader2,
  LogOut,
  TriangleAlert,
  UserRoundPlus,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useAddCourseMembers,
  useRemoveCourseMembers,
} from "@/features/courses/course-queries";
import { useStudents } from "@/features/students/student-queries";
import { formatRelativeTime } from "@/lib/time";

/**
 * 课程成员页签（T2A.4，D7）：成员列表 + 从学生中多选添加 + 批量移出
 * （确认弹层说明影响：立即看不到课程；已交卷记录保留；未交卷草稿不可访问；
 * 数据保留不删）。§4-2 批量操作、§4-6 可撤回（不删数据）。
 */
export function CourseMembersTab({
  courseId,
  detail,
}: {
  courseId: string;
  detail: CourseDetailData;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const removeMutation = useRemoveCourseMembers(courseId);

  const members = detail.members;
  const memberIds = useMemo(
    () => new Set(members.map((member) => member.studentId)),
    [members],
  );

  function toggle(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const removeTargets = members.filter((member) =>
    selectedIds.has(member.studentId),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button className="min-h-11 px-4" onClick={() => setAddOpen(true)}>
          <UserRoundPlus aria-hidden />
          添加成员
        </Button>
        <Button
          variant="outline"
          className="min-h-11 text-destructive hover:text-destructive"
          disabled={selectedIds.size === 0 || removeMutation.isPending}
          onClick={() => setConfirmRemove(true)}
        >
          <LogOut aria-hidden />
          移出{selectedIds.size > 0 ? ` ${selectedIds.size} 人` : ""}
        </Button>
        <p aria-live="polite" className="ml-auto text-sm text-muted-foreground">
          共 {members.length} 名成员
        </p>
      </div>

      {members.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
          <Users aria-hidden className="size-10 text-muted-foreground" />
          <p className="text-sm font-medium">课程还没有成员</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            把学生加为成员后，他们才能看到这门课程里可见的讲义与练习。
          </p>
          <Button className="min-h-11 px-4" onClick={() => setAddOpen(true)}>
            <UserRoundPlus aria-hidden />
            添加学生
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {members.map((member) => (
            <li key={member.studentId}>
              <label
                className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition-colors ${
                  selectedIds.has(member.studentId)
                    ? "border-primary/50 bg-primary/5"
                    : "border-border bg-card hover:bg-muted/50"
                }`}
              >
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-[var(--color-primary)]"
                  checked={selectedIds.has(member.studentId)}
                  onChange={() => toggle(member.studentId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {member.displayName}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {formatRelativeTime(member.joinedAt)}加入
                  </span>
                </span>
                {member.archived && (
                  <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    学生已归档
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}

      {removeMutation.isError && (
        <p role="alert" className="text-sm text-destructive">
          {removeMutation.error instanceof Error
            ? removeMutation.error.message
            : "移出失败，请稍后重试"}
        </p>
      )}

      {addOpen && (
        <AddMembersDialog
          courseId={courseId}
          memberIds={memberIds}
          onClose={() => setAddOpen(false)}
        />
      )}

      {confirmRemove && (
        <Dialog open onOpenChange={(open) => !open && setConfirmRemove(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>移出 {removeTargets.length} 名成员？</DialogTitle>
              <DialogDescription asChild>
                <div className="flex flex-col gap-2">
                  <p>
                    将移出：{removeTargets.map((m) => m.displayName).join("、")}
                  </p>
                  <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                    <TriangleAlert
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0"
                    />
                    移出后学生立即看不到这门课程；已交卷的练习记录会保留，
                    未交卷的草稿作答将无法继续（数据不删除，重新加入可恢复访问）。
                  </p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setConfirmRemove(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="min-h-11 px-4"
                disabled={removeMutation.isPending}
                onClick={() => {
                  removeMutation.mutate([...selectedIds]);
                  setSelectedIds(new Set());
                  setConfirmRemove(false);
                }}
              >
                {removeMutation.isPending ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    正在移出…
                  </>
                ) : (
                  "确认移出"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** 从学生列表多选添加（未归档、不在本课程的学生） */
function AddMembersDialog({
  courseId,
  memberIds,
  onClose,
}: {
  courseId: string;
  memberIds: Set<string>;
  onClose: () => void;
}) {
  const studentsQuery = useStudents(false);
  const addMutation = useAddCourseMembers(courseId);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const candidates =
    studentsQuery.data?.students.filter(
      (student) => !memberIds.has(student.id),
    ) ?? [];

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
          <DialogDescription>
            从学生名单中多选加入本课程；已在课程中的学生不再列出。
          </DialogDescription>
        </DialogHeader>

        {studentsQuery.isPending && (
          <div role="status" className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-lg bg-muted/50"
              />
            ))}
            <p className="sr-only">正在加载学生…</p>
          </div>
        )}
        {studentsQuery.isError && (
          <div
            role="alert"
            className="flex flex-col items-start gap-2 text-sm text-destructive"
          >
            <p>
              {studentsQuery.error instanceof Error
                ? studentsQuery.error.message
                : "学生加载失败"}
            </p>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => void studentsQuery.refetch()}
            >
              重试
            </Button>
          </div>
        )}
        {studentsQuery.data &&
          (candidates.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
              没有可添加的学生（全部未归档学生都已在课程中）。
              可先到「学生」页新增学生。
            </p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
              {candidates.map((student) => (
                <li key={student.id}>
                  <label
                    className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      selected.has(student.id)
                        ? "border-primary/50 bg-primary/5"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="size-5 shrink-0 accent-[var(--color-primary)]"
                      checked={selected.has(student.id)}
                      onChange={() => toggle(student.id)}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {student.displayName}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      登录名：{student.loginName}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ))}

        {addMutation.isError && (
          <p role="alert" className="text-sm text-destructive">
            {addMutation.error instanceof Error
              ? addMutation.error.message
              : "添加失败，请稍后重试"}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onClose}
            disabled={addMutation.isPending}
          >
            取消
          </Button>
          <Button
            type="button"
            className="min-h-11 px-4"
            disabled={addMutation.isPending || selected.size === 0}
            onClick={() => {
              addMutation.mutate([...selected]);
              setSelected(new Set());
              onClose();
            }}
          >
            {addMutation.isPending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                正在添加…
              </>
            ) : (
              `添加${selected.size > 0 ? ` ${selected.size} 人` : ""}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
