import type { CourseSummary, StudentSummary } from "@tutor/contract";
import {
  Archive,
  ArchiveRestore,
  CircleCheck,
  Copy,
  GraduationCap,
  KeyRound,
  Loader2,
  Plus,
  RotateCcw,
  TriangleAlert,
  UserRound,
  UserRoundPlus,
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
import { Input } from "@/components/ui/input";
import {
  useAddStudentToCourses,
  useSyncStudentCourses,
  useTeacherCourses,
} from "@/features/courses/course-queries";
import {
  useCreateStudent,
  useResetStudentLink,
  useResetStudentPassword,
  useStudents,
  useUpdateStudent,
} from "@/features/students/student-queries";
import { ApiError } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { formatRelativeTime } from "@/lib/time";

/**
 * /t/students 学生页（T2.1）：名单 + 两种登录方式管理。
 * T2A.4 追加：「所在课程」列（经课程列表 memberIds 聚合）、新增学生时可选加入课程、
 * 行操作「管理课程」（多选课程，调成员接口增删）。
 * - 列表：姓名、登录名、专属链接/密码开关（可直接点按切换）、所在课程、归档标记、备注；
 * - 新增：姓名 + 登录名（缺省同姓名）+ 可选初始密码（留空自动生成，一次性展示）
 *   + 可选加入课程；
 * - 复制专属链接（`${origin}/s/${token}`，HTTP 环境降级复制）；
 * - 重置密码（一次性明文弹窗）/ 重置链接（旧链接立即失效）/ 归档与取消归档。
 * 三态齐全（加载骨架 / 空态指引 / 错误重试），触控目标 ≥44px。
 */

/** 由 linkToken 拼学生专属链接（学生端 /s/:token 路由页由 T2.3 提供） */
export function studentLinkUrl(linkToken: string): string {
  return `${window.location.origin}/s/${linkToken}`;
}

export function StudentsPage() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  /** 一次性明文弹窗（初始密码 / 重置密码 / 新专属链接） */
  const [oneTime, setOneTime] = useState<OneTimeValue | null>(null);
  /** 「管理课程」弹窗的目标学生 */
  const [manageCoursesOf, setManageCoursesOf] = useState<StudentSummary | null>(
    null,
  );
  const studentsQuery = useStudents(includeArchived);
  const activeCoursesQuery = useTeacherCourses(false);
  const archivedCoursesQuery = useTeacherCourses(true);

  /** 学生 id → 所在课程（未归档 + 已归档都展示，带归档标记） */
  const coursesByStudent = useMemo(() => {
    const map = new Map<string, CourseSummary[]>();
    const all = [
      ...(activeCoursesQuery.data?.courses ?? []),
      ...(archivedCoursesQuery.data?.courses ?? []),
    ];
    for (const course of all) {
      for (const studentId of course.memberIds) {
        const list = map.get(studentId) ?? [];
        list.push(course);
        map.set(studentId, list);
      }
    }
    return map;
  }, [activeCoursesQuery.data, archivedCoursesQuery.data]);

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">学生</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            新增学生后把专属链接或登录名+初始密码发给学生即可开始。
          </p>
        </div>
        <Button className="min-h-11 px-4" onClick={() => setCreateOpen(true)}>
          <UserRoundPlus aria-hidden />
          新增学生
        </Button>
      </header>

      <div className="flex items-center justify-between gap-3">
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {studentsQuery.data
            ? `共 ${studentsQuery.data.students.length} 名学生`
            : "…"}
        </p>
        <Button
          variant="outline"
          className="min-h-11"
          aria-pressed={includeArchived}
          onClick={() => setIncludeArchived((v) => !v)}
        >
          {includeArchived ? "只看未归档" : "显示已归档"}
        </Button>
      </div>

      {studentsQuery.isPending && <StudentsSkeleton />}

      {studentsQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            学生加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {studentsQuery.error instanceof Error
              ? studentsQuery.error.message
              : "网络异常，请稍后重试"}
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
        (studentsQuery.data.students.length === 0 ? (
          <StudentsEmpty onCreate={() => setCreateOpen(true)} />
        ) : (
          <ul className="flex flex-col gap-3">
            {studentsQuery.data.students.map((student) => (
              <StudentCard
                key={student.id}
                student={student}
                courses={coursesByStudent.get(student.id) ?? []}
                onManageCourses={() => setManageCoursesOf(student)}
                onOneTime={setOneTime}
              />
            ))}
          </ul>
        ))}

      {createOpen && (
        <CreateStudentDialog
          activeCourses={activeCoursesQuery.data?.courses ?? []}
          onClose={() => setCreateOpen(false)}
          onOneTime={setOneTime}
        />
      )}

      {oneTime && (
        <OneTimeValueDialog value={oneTime} onClose={() => setOneTime(null)} />
      )}

      {manageCoursesOf !== null && (
        <ManageCoursesDialog
          student={manageCoursesOf}
          activeCourses={activeCoursesQuery.data?.courses ?? []}
          onClose={() => setManageCoursesOf(null)}
        />
      )}
    </section>
  );
}

// ---------- 加载 / 空态 ----------

/** 加载骨架（不白屏；role=status 让读屏可感知加载中） */
function StudentsSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载学生"
      className="flex flex-col gap-3"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-36 animate-pulse rounded-xl border border-border bg-muted/50"
        />
      ))}
      <p className="text-sm text-muted-foreground">正在加载学生…</p>
    </div>
  );
}

/** 空态：解释 + 下一步动作 */
function StudentsEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
      <UserRound aria-hidden className="size-10 text-muted-foreground" />
      <p className="text-sm font-medium">还没有学生</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        新增第一位学生后，系统会生成一条专属链接，微信发给学生即可打开使用。
      </p>
      <Button className="min-h-11 px-4" onClick={onCreate}>
        <UserRoundPlus aria-hidden />
        新增学生
      </Button>
    </div>
  );
}

// ---------- 学生卡片 ----------

function StudentCard({
  student,
  courses,
  onManageCourses,
  onOneTime,
}: {
  student: StudentSummary;
  /** 该学生所在的课程（未归档 + 已归档） */
  courses: CourseSummary[];
  onManageCourses: () => void;
  onOneTime: (value: OneTimeValue) => void;
}) {
  const updateMutation = useUpdateStudent();
  const resetPasswordMutation = useResetStudentPassword();
  const resetLinkMutation = useResetStudentLink();
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);

  const busy =
    updateMutation.isPending ||
    resetPasswordMutation.isPending ||
    resetLinkMutation.isPending;

  /** 复制结果反馈 2 秒后消失 */
  async function handleCopyLink() {
    const ok = await copyText(studentLinkUrl(student.linkToken));
    setCopied(ok ? "ok" : "fail");
    window.setTimeout(() => setCopied(null), 2000);
  }

  const updateError =
    updateMutation.error ??
    resetPasswordMutation.error ??
    resetLinkMutation.error;

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-base font-semibold">{student.displayName}</p>
        <p className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
          登录名：{student.loginName}
        </p>
        {student.archived && (
          <p className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            已归档
          </p>
        )}
        <p className="ml-auto text-xs text-muted-foreground">
          {formatRelativeTime(student.createdAt)}创建
        </p>
      </div>

      {/* 所在课程（T2A.4）：经课程列表 memberIds 聚合 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <GraduationCap aria-hidden className="size-3.5" />
          所在课程：
        </span>
        {courses.length === 0 ? (
          <span className="text-xs text-muted-foreground">未加入任何课程</span>
        ) : (
          courses.map((course) => (
            <span
              key={course.id}
              className={`rounded-md px-2 py-0.5 text-xs ${
                course.archived
                  ? "bg-muted text-muted-foreground"
                  : "bg-primary/10 text-primary"
              }`}
            >
              {course.name}
              {course.archived ? "（已归档）" : ""}
            </span>
          ))
        )}
      </div>

      {/* 两种登录方式：点按即切换（≥44px 触控目标） */}
      <div className="flex flex-wrap gap-2">
        <LoginMethodToggle
          label="专属链接"
          enabled={student.linkEnabled}
          disabled={busy}
          onToggle={() =>
            updateMutation.mutate({
              id: student.id,
              request: { linkEnabled: !student.linkEnabled },
            })
          }
        />
        <LoginMethodToggle
          label="密码登录"
          enabled={student.passwordEnabled}
          disabled={busy || !student.hasPassword}
          onToggle={() =>
            updateMutation.mutate({
              id: student.id,
              request: { passwordEnabled: !student.passwordEnabled },
            })
          }
        />
        {!student.hasPassword && (
          <span className="self-center text-xs text-muted-foreground">
            尚未设置密码，可先重置密码
          </span>
        )}
      </div>

      {student.note && (
        <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
          备注：{student.note}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() => void handleCopyLink()}
        >
          <Copy aria-hidden />
          复制专属链接
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() =>
            resetPasswordMutation.mutate(student.id, {
              onSuccess: (data) => {
                onOneTime({
                  title: `${student.displayName} 的新密码`,
                  description:
                    "新密码只显示这一次，请复制后发给学生。旧密码已立即失效。",
                  value: data.password,
                  copyLabel: "复制新密码",
                });
              },
            })
          }
        >
          <KeyRound aria-hidden />
          重置密码
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() =>
            resetLinkMutation.mutate(student.id, {
              onSuccess: (data) => {
                onOneTime({
                  title: `${student.displayName} 的新专属链接`,
                  description:
                    "旧链接已立即失效，请把新链接发给学生（也可直接复制）。",
                  value: studentLinkUrl(data.linkToken),
                  copyLabel: "复制新链接",
                });
              },
            })
          }
        >
          <RotateCcw aria-hidden />
          重置链接
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          onClick={onManageCourses}
        >
          <GraduationCap aria-hidden />
          管理课程
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() =>
            updateMutation.mutate({
              id: student.id,
              request: { archived: !student.archived },
            })
          }
        >
          {student.archived ? (
            <>
              <ArchiveRestore aria-hidden />
              取消归档
            </>
          ) : (
            <>
              <Archive aria-hidden />
              归档
            </>
          )}
        </Button>
      </div>

      {/* 复制反馈与行内错误 */}
      {copied && (
        <p
          aria-live="polite"
          className={`flex items-center gap-1.5 text-sm ${
            copied === "ok" ? "text-primary" : "text-destructive"
          }`}
        >
          {copied === "ok" ? (
            <>
              <CircleCheck aria-hidden className="size-4" />
              已复制专属链接
            </>
          ) : (
            "复制失败，请长按链接手动复制"
          )}
        </p>
      )}
      {updateError && (
        <p role="alert" className="text-sm text-destructive">
          {updateError instanceof Error
            ? updateError.message
            : "操作失败，请稍后重试"}
        </p>
      )}
    </li>
  );
}

/** 登录方式开关（aria-pressed 按钮，44px 触控目标） */
function LoginMethodToggle({
  label,
  enabled,
  disabled,
  onToggle,
}: {
  label: string;
  enabled: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant={enabled ? "secondary" : "outline"}
      className="min-h-11"
      aria-pressed={enabled}
      disabled={disabled}
      onClick={onToggle}
    >
      {enabled ? `${label}：已开启` : `${label}：已关闭`}
    </Button>
  );
}

// ---------- 新增学生 ----------

/** 一次性明文弹窗的内容 */
interface OneTimeValue {
  title: string;
  description: string;
  value: string;
  copyLabel: string;
}

function CreateStudentDialog({
  activeCourses,
  onClose,
  onOneTime,
}: {
  activeCourses: CourseSummary[];
  onClose: () => void;
  onOneTime: (value: OneTimeValue) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [loginName, setLoginName] = useState("");
  /** 登录名是否被手动改过（未改过则跟随姓名自动填充） */
  const [loginNameTouched, setLoginNameTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  /** 创建后要加入的课程（T2A.4） */
  const [courseIds, setCourseIds] = useState<Set<string>>(new Set());
  const createMutation = useCreateStudent();
  const addToCoursesMutation = useAddStudentToCourses();

  const effectiveLoginName = loginNameTouched ? loginName : displayName;

  function toggleCourse(id: string) {
    setCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    createMutation.mutate(
      {
        displayName: displayName.trim(),
        loginName: effectiveLoginName.trim(),
        // 空密码不提交（服务端生成随机初始密码）
        ...(password.length > 0 ? { password } : {}),
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      },
      {
        onSuccess: (data) => {
          if (data.initialPassword) {
            onOneTime({
              title: `${data.student.displayName} 的初始密码`,
              description:
                "初始密码只显示这一次，请复制后发给学生（也可让学生用专属链接直接登录）。",
              value: data.initialPassword,
              copyLabel: "复制初始密码",
            });
          }
          if (courseIds.size > 0) {
            // 加入课程失败不打断创建结果（行内可再「管理课程」补救）
            addToCoursesMutation.mutate({
              studentId: data.student.id,
              courseIds: [...courseIds],
            });
          }
          onClose();
        },
      },
    );
  }

  const errorMessage = createMutation.isError
    ? createMutation.error instanceof ApiError &&
      createMutation.error.code === "LOGIN_NAME_TAKEN"
      ? "登录名已被使用，请换一个（如「张三2」）"
      : createMutation.error instanceof Error
        ? createMutation.error.message
        : "创建失败，请稍后重试"
    : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增学生</DialogTitle>
          <DialogDescription>
            创建后自动生成专属链接；密码可留空，系统会生成随机初始密码。
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="student-display-name" className="text-sm">
              姓名
            </label>
            <Input
              id="student-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="如：张三"
              required
              maxLength={32}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="student-login-name" className="text-sm">
              登录名（默认同姓名，需全局唯一）
            </label>
            <Input
              id="student-login-name"
              value={effectiveLoginName}
              onChange={(e) => {
                setLoginNameTouched(true);
                setLoginName(e.target.value);
              }}
              placeholder="如：张三 或 张三2"
              required
              maxLength={32}
              aria-invalid={errorMessage != null}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="student-password" className="text-sm">
              初始密码（可选）
            </label>
            <Input
              id="student-password"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="留空自动生成（8 位，创建后显示一次）"
              autoComplete="off"
              minLength={password.length > 0 ? 6 : undefined}
              maxLength={128}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="student-note" className="text-sm">
              备注（可选）
            </label>
            <Input
              id="student-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="如：初二，周三晚课"
              maxLength={200}
            />
          </div>
          {activeCourses.length > 0 && (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm">加入课程（可选，多选）</legend>
              <div className="flex flex-wrap gap-2">
                {activeCourses.map((course) => (
                  <label
                    key={course.id}
                    className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm transition-colors ${
                      courseIds.has(course.id)
                        ? "border-primary/50 bg-primary/5"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="size-5 accent-[var(--color-primary)]"
                      checked={courseIds.has(course.id)}
                      onChange={() => toggleCourse(course.id)}
                    />
                    {course.name}
                    <span className="text-xs text-muted-foreground">
                      {course.memberCount} 人
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {addToCoursesMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              学生已创建，但加入课程失败：{addToCoursesMutation.error instanceof Error ? addToCoursesMutation.error.message : "请稍后在「管理课程」中重试"}
            </p>
          )}
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
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
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  正在创建…
                </>
              ) : (
                <>
                  <Plus aria-hidden />
                  创建
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 一次性明文弹窗 ----------

function OneTimeValueDialog({
  value,
  onClose,
}: {
  value: OneTimeValue;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);

  async function handleCopy() {
    const ok = await copyText(value.value);
    setCopied(ok ? "ok" : "fail");
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{value.title}</DialogTitle>
          <DialogDescription>{value.description}</DialogDescription>
        </DialogHeader>
        <p className="rounded-lg bg-muted px-4 py-3 text-center font-mono text-lg break-all select-all">
          {value.value}
        </p>
        <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
          {copied === "ok" && "已复制"}
          {copied === "fail" && "复制失败，请长按上方内容手动复制"}
        </p>
        <DialogFooter>
          <Button type="button" className="min-h-11 px-4" onClick={onClose}>
            完成
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-4"
            onClick={() => void handleCopy()}
          >
            <Copy aria-hidden />
            {value.copyLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 管理课程（T2A.4 行操作） ----------

/**
 * 多选课程调成员接口增删（与课程页成员页签同一组底层接口，D7）。
 * 只列出未归档课程；已归档课程中的成员关系不受本次操作影响。
 */
function ManageCoursesDialog({
  student,
  activeCourses,
  onClose,
}: {
  student: StudentSummary;
  activeCourses: CourseSummary[];
  onClose: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(
    new Set(
      activeCourses
        .filter((course) => course.memberIds.includes(student.id))
        .map((course) => course.id),
    ),
  );
  const syncMutation = useSyncStudentCourses();

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSave() {
    const addCourseIds: string[] = [];
    const removeCourseIds: string[] = [];
    for (const course of activeCourses) {
      const isMember = course.memberIds.includes(student.id);
      const shouldBe = checked.has(course.id);
      if (!isMember && shouldBe) addCourseIds.push(course.id);
      if (isMember && !shouldBe) removeCourseIds.push(course.id);
    }
    if (addCourseIds.length === 0 && removeCourseIds.length === 0) {
      onClose();
      return;
    }
    syncMutation.mutate(
      { studentId: student.id, addCourseIds, removeCourseIds },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>管理「{student.displayName}」的课程</DialogTitle>
          <DialogDescription>
            勾选 = 加入课程（学生立即看到课程内可见内容）；取消勾选 = 移出
            （立即看不到，已交卷记录保留、数据不删）。已归档课程不在此列。
          </DialogDescription>
        </DialogHeader>

        {activeCourses.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
            还没有未归档的课程。先到「课程」页新建。
          </p>
        ) : (
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {activeCourses.map((course) => (
              <li key={course.id}>
                <label
                  className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    checked.has(course.id)
                      ? "border-primary/50 bg-primary/5"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="size-5 shrink-0 accent-[var(--color-primary)]"
                    checked={checked.has(course.id)}
                    onChange={() => toggle(course.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {course.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {course.memberCount} 名成员 · 目录 {course.itemCount} 条
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {syncMutation.isError && (
          <p role="alert" className="text-sm text-destructive">
            {syncMutation.error instanceof Error
              ? syncMutation.error.message
              : "保存失败，请稍后重试"}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onClose}
            disabled={syncMutation.isPending}
          >
            取消
          </Button>
          <Button
            type="button"
            className="min-h-11 px-4"
            disabled={syncMutation.isPending}
            onClick={handleSave}
          >
            {syncMutation.isPending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                正在保存…
              </>
            ) : (
              "保存"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 供 App.tsx 路由级懒加载
export default StudentsPage;
