import type { AdminTeacherSummary } from "@tutor/contract";
import { teacherLoginNameSchema, teacherPasswordSchema } from "@tutor/contract";
import {
  Ban,
  CircleCheck,
  Copy,
  KeyRound,
  Loader2,
  PenLine,
  Plus,
  Search,
  ShieldCheck,
  ShieldOff,
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
  useAdminTeachers,
  useCreateAdminTeacher,
  useDisableAdminTeacher,
  useEnableAdminTeacher,
  useResetAdminTeacherPassword,
  useUpdateAdminTeacher,
} from "@/features/admin/admin-queries";
import { useTeacherMe } from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { formatCnTime } from "@/lib/time";

/**
 * /a/teachers 教师管理（T2B.6，D3 常用集 + §4 约定逐条落实）：
 * - 列表：登录名、「我」标注、「管理员」徽章、「正常/已禁用」状态标签、
 *   学生数、创建时间（北京时间）；
 * - 操作：创建（初始密码一次性展示 §4.4）、改登录名、重置密码（一次性明文 +
 *   「需线下告知对方」§4.1）、禁用/启用（确认弹层写明影响 §4.1/§4.2）、
 *   授予/撤销 isAdmin（影响说明）；
 * - 「我」所在行：禁用与撤销 isAdmin 按钮置灰（§4.3）；
 * - 搜索（登录名，前端即时过滤 §4.5）与状态筛选；三态齐全（§4.6）；
 * - 成功操作 aria-live 反馈（§4.2）；触控目标 ≥44px（§4.8）。
 */

export function AdminTeachersPage() {
  const meQuery = useTeacherMe();
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "disabled"
  >("all");
  const [keyword, setKeyword] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  /** 一次性明文弹窗（初始密码 / 重置密码） */
  const [oneTime, setOneTime] = useState<OneTimeValue | null>(null);
  /** 待确认动作（禁用/启用/授予/撤销——确认弹层先说清影响） */
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  /** 改登录名弹窗目标 */
  const [renameOf, setRenameOf] = useState<AdminTeacherSummary | null>(null);
  /** 重置密码弹窗目标 */
  const [resetOf, setResetOf] = useState<AdminTeacherSummary | null>(null);
  /** 成功操作反馈（aria-live，2.5 小时文案见各分支） */
  const [notice, setNotice] = useState<string | null>(null);

  const teachersQuery = useAdminTeachers(statusFilter);
  const updateMutation = useUpdateAdminTeacher();
  const disableMutation = useDisableAdminTeacher();
  const enableMutation = useEnableAdminTeacher();

  const myId = meQuery.data?.id;

  /** 前端即时过滤（§4.5：按登录名搜索） */
  const filtered = useMemo(() => {
    const list = teachersQuery.data?.teachers ?? [];
    const q = keyword.trim();
    if (q.length === 0) return list;
    return list.filter((teacher) => teacher.loginName.includes(q));
  }, [teachersQuery.data, keyword]);

  function showNotice(text: string): void {
    setNotice(text);
    window.setTimeout(() => {
      setNotice((current) => (current === text ? null : current));
    }, 4000);
  }

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">教师管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理老师账号：创建、改登录名、重置密码、停用与授予管理员。
            老师名下的题库、课程与学生数据管理员不可见。
          </p>
        </div>
        <Button className="min-h-11 px-4" onClick={() => setCreateOpen(true)}>
          <UserRoundPlus aria-hidden />
          创建教师
        </Button>
      </header>

      {/* 筛选与搜索（§4.5） */}
      <div className="flex flex-wrap items-center gap-2">
        <fieldset
          aria-label="状态筛选"
          className="flex gap-1 rounded-lg border border-border bg-card p-1"
        >
          {(
            [
              ["all", "全部"],
              ["active", "未禁用"],
              ["disabled", "已禁用"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant={statusFilter === value ? "secondary" : "ghost"}
              className="min-h-11 px-3"
              aria-pressed={statusFilter === value}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </Button>
          ))}
        </fieldset>
        <div className="relative min-w-52 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="按登录名搜索"
            placeholder="搜索登录名"
            className="min-h-11 pl-9"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
      </div>

      {/* 成功操作反馈（§4.2，aria-live） */}
      {notice && (
        <p
          aria-live="polite"
          data-testid="admin-notice"
          className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary"
        >
          <CircleCheck aria-hidden className="size-4 shrink-0" />
          {notice}
        </p>
      )}

      {teachersQuery.isPending && <TeachersSkeleton />}

      {teachersQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            教师列表加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {teachersQuery.error instanceof Error
              ? teachersQuery.error.message
              : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void teachersQuery.refetch()}
          >
            重试
          </Button>
        </div>
      )}

      {teachersQuery.data &&
        (teachersQuery.data.teachers.length === 0 ? (
          <TeachersEmpty onCreate={() => setCreateOpen(true)} />
        ) : filtered.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
            没有匹配「{keyword.trim()}」的老师。
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {filtered.map((teacher) => (
              <TeacherCard
                key={teacher.id}
                teacher={teacher}
                isMe={teacher.id === myId}
                busy={
                  updateMutation.isPending ||
                  disableMutation.isPending ||
                  enableMutation.isPending
                }
                onRename={() => setRenameOf(teacher)}
                onResetPassword={() => setResetOf(teacher)}
                onConfirm={(action) => setConfirmAction({ ...action, teacher })}
              />
            ))}
          </ul>
        ))}

      {createOpen && (
        <CreateTeacherDialog
          onClose={() => setCreateOpen(false)}
          onOneTime={setOneTime}
        />
      )}
      {renameOf !== null && (
        <RenameTeacherDialog
          teacher={renameOf}
          onClose={() => setRenameOf(null)}
        />
      )}
      {resetOf !== null && (
        <ResetPasswordDialog
          teacher={resetOf}
          onClose={() => setResetOf(null)}
          onOneTime={setOneTime}
        />
      )}
      {confirmAction !== null && (
        <ConfirmActionDialog
          action={confirmAction}
          onClose={() => setConfirmAction(null)}
          onDone={(text) => showNotice(text)}
        />
      )}
      {oneTime && (
        <OneTimeValueDialog value={oneTime} onClose={() => setOneTime(null)} />
      )}
    </section>
  );
}

// ---------- 加载 / 空态 ----------

function TeachersSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载教师"
      className="flex flex-col gap-3"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-32 animate-pulse rounded-xl border border-border bg-muted/50"
        />
      ))}
      <p className="text-sm text-muted-foreground">正在加载教师…</p>
    </div>
  );
}

/** 空态（§4.6：解释 + 下一步动作——创建教师 或 打开注册开关） */
function TeachersEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
      <UserRound aria-hidden className="size-10 text-muted-foreground" />
      <p className="text-sm font-medium">还没有其他老师</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        可以直接创建教师账号（初始密码一次性显示），或在概览页打开自助注册开关，
        让同事自己注册。
      </p>
      <Button className="min-h-11 px-4" onClick={onCreate}>
        <UserRoundPlus aria-hidden />
        创建教师
      </Button>
    </div>
  );
}

// ---------- 教师卡片 ----------

/** 待确认动作（确认弹层先说清影响，§4.1） */
interface ConfirmAction {
  kind: "disable" | "enable" | "grant" | "revoke";
  teacher: AdminTeacherSummary;
}

function TeacherCard({
  teacher,
  isMe,
  busy,
  onRename,
  onResetPassword,
  onConfirm,
}: {
  teacher: AdminTeacherSummary;
  isMe: boolean;
  busy: boolean;
  onRename: () => void;
  onResetPassword: () => void;
  onConfirm: (action: Omit<ConfirmAction, "teacher">) => void;
}) {
  const disabled = teacher.disabledAt != null;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-base font-semibold">{teacher.loginName}</p>
        {isMe && (
          <span
            data-testid="me-badge"
            className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
          >
            我
          </span>
        )}
        {teacher.isAdmin && (
          <span className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            <ShieldCheck aria-hidden className="size-3" />
            管理员
          </span>
        )}
        {/* 状态标签（§4.3：正常 / 已禁用） */}
        <span
          data-testid="teacher-status"
          className={`rounded-md px-2 py-0.5 text-xs ${
            disabled
              ? "bg-destructive/10 text-destructive"
              : "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
          }`}
        >
          {disabled ? "已禁用" : "正常"}
        </span>
        <p className="ml-auto text-xs text-muted-foreground">
          {teacher.studentCount} 名学生 · {formatCnTime(teacher.createdAt)}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={onRename}
        >
          <PenLine aria-hidden />
          改登录名
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={onResetPassword}
        >
          <KeyRound aria-hidden />
          重置密码
        </Button>
        {/* 「我」行禁用按钮置灰（§4.3；不能禁自己） */}
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy || isMe}
          onClick={() =>
            disabled
              ? onConfirm({ kind: "enable" })
              : onConfirm({ kind: "disable" })
          }
        >
          {disabled ? (
            <>
              <CircleCheck aria-hidden />
              启用
            </>
          ) : (
            <>
              <Ban aria-hidden />
              禁用
            </>
          )}
        </Button>
        {/* 「我」行撤销 isAdmin 置灰（不能把自己撤成普通老师） */}
        <Button
          variant="outline"
          className="min-h-11"
          disabled={
            busy || (isMe && teacher.isAdmin) || (!teacher.isAdmin && disabled)
          }
          onClick={() =>
            onConfirm(teacher.isAdmin ? { kind: "revoke" } : { kind: "grant" })
          }
        >
          {teacher.isAdmin ? (
            <>
              <ShieldOff aria-hidden />
              撤销管理员
            </>
          ) : (
            <>
              <ShieldCheck aria-hidden />
              授予管理员
            </>
          )}
        </Button>
      </div>
    </li>
  );
}

// ---------- 创建教师（§4.4 初始密码一次性展示） ----------

interface OneTimeValue {
  title: string;
  description: string;
  value: string;
  copyLabel: string;
}

function CreateTeacherDialog({
  onClose,
  onOneTime,
}: {
  onClose: () => void;
  onOneTime: (value: OneTimeValue) => void;
}) {
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const createMutation = useCreateAdminTeacher();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsedName = teacherLoginNameSchema.safeParse(loginName);
    if (!parsedName.success) {
      setFormError(parsedName.error.issues[0]?.message ?? "登录名格式不正确");
      return;
    }
    if (password.length > 0) {
      const parsedPassword = teacherPasswordSchema.safeParse(password);
      if (!parsedPassword.success) {
        setFormError(
          parsedPassword.error.issues[0]?.message ?? "密码格式不正确",
        );
        return;
      }
    }
    setFormError(null);
    createMutation.mutate(
      {
        loginName: parsedName.data,
        // 空密码不提交（服务端生成 12 位随机初始密码）
        ...(password.length > 0 ? { password } : {}),
      },
      {
        onSuccess: (data) => {
          if (data.initialPassword) {
            onOneTime({
              title: `${data.teacher.loginName} 的初始密码`,
              description:
                "初始密码只显示这一次，请复制后线下告知对方（关闭后无法再查看）。对方首次登录即可使用。",
              value: data.initialPassword,
              copyLabel: "复制初始密码",
            });
          }
          onClose();
        },
      },
    );
  }

  const serverError = createMutation.error
    ? createMutation.error instanceof Error
      ? createMutation.error.message
      : "创建失败，请稍后重试"
    : null;
  const shownError = formError ?? serverError;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建教师</DialogTitle>
          <DialogDescription>
            创建后老师用「登录名 + 密码」登录；密码可留空，系统生成 12
            位随机初始密码 （只显示一次）。
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="admin-create-login-name" className="text-sm">
              登录名
            </label>
            <Input
              id="admin-create-login-name"
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              placeholder="2–32 个字符，可用中文、字母、数字"
              autoComplete="off"
              aria-invalid={shownError != null}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="admin-create-password" className="text-sm">
              初始密码（可选）
            </label>
            <Input
              id="admin-create-password"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="留空自动生成（12 位，创建后显示一次）"
              autoComplete="off"
            />
          </div>
          {shownError != null && (
            <p role="alert" className="text-sm text-destructive">
              {shownError}
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

// ---------- 改登录名 ----------

function RenameTeacherDialog({
  teacher,
  onClose,
}: {
  teacher: AdminTeacherSummary;
  onClose: () => void;
}) {
  const [loginName, setLoginName] = useState(teacher.loginName);
  const [formError, setFormError] = useState<string | null>(null);
  const updateMutation = useUpdateAdminTeacher();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = teacherLoginNameSchema.safeParse(loginName);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "登录名格式不正确");
      return;
    }
    if (parsed.data === teacher.loginName) {
      onClose();
      return;
    }
    setFormError(null);
    updateMutation.mutate(
      { id: teacher.id, request: { loginName: parsed.data } },
      { onSuccess: onClose },
    );
  }

  const serverError =
    updateMutation.error instanceof ApiError &&
    updateMutation.error.code === "TEACHER_LOGIN_EXISTS"
      ? "登录名已被使用，请换一个"
      : updateMutation.error instanceof Error
        ? updateMutation.error.message
        : null;
  const shownError = formError ?? serverError;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改「{teacher.loginName}」的登录名</DialogTitle>
          <DialogDescription>
            改名后老师需用新登录名登录（密码不变）。
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="admin-rename-input" className="text-sm">
              新登录名
            </label>
            <Input
              id="admin-rename-input"
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              autoComplete="off"
              aria-invalid={shownError != null}
            />
          </div>
          {shownError != null && (
            <p role="alert" className="text-sm text-destructive">
              {shownError}
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
              {updateMutation.isPending ? "正在保存…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 重置密码（§4.1：新密码需线下告知对方） ----------

function ResetPasswordDialog({
  teacher,
  onClose,
  onOneTime,
}: {
  teacher: AdminTeacherSummary;
  onClose: () => void;
  onOneTime: (value: OneTimeValue) => void;
}) {
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const resetMutation = useResetAdminTeacherPassword();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (password.length > 0) {
      const parsed = teacherPasswordSchema.safeParse(password);
      if (!parsed.success) {
        setFormError(parsed.error.issues[0]?.message ?? "密码格式不正确");
        return;
      }
    }
    setFormError(null);
    resetMutation.mutate(
      { id: teacher.id, request: password.length > 0 ? { password } : {} },
      {
        onSuccess: (data) => {
          onOneTime({
            title: `${teacher.loginName} 的新密码`,
            description:
              "新密码只显示这一次，请复制后线下告知对方。旧密码已立即失效。",
            value: data.password,
            copyLabel: "复制新密码",
          });
          onClose();
        },
      },
    );
  }

  const shownError =
    formError ??
    (resetMutation.error instanceof Error ? resetMutation.error.message : null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置「{teacher.loginName}」的密码</DialogTitle>
          <DialogDescription>
            新密码需线下告知对方。可留空由系统生成 12 位随机密码（显示一次）。
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="admin-reset-password" className="text-sm">
              新密码（可选）
            </label>
            <Input
              id="admin-reset-password"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="留空自动生成（12 位，重置后显示一次）"
              autoComplete="off"
              aria-invalid={shownError != null}
            />
          </div>
          {shownError != null && (
            <p role="alert" className="text-sm text-destructive">
              {shownError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onClose}
              disabled={resetMutation.isPending}
            >
              取消
            </Button>
            <Button
              type="submit"
              className="min-h-11 px-4"
              disabled={resetMutation.isPending}
            >
              {resetMutation.isPending ? "正在重置…" : "重置密码"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 禁用 / 启用 / 授予撤销管理员（确认弹层，§4.1 影响先说清） ----------

function ConfirmActionDialog({
  action,
  onClose,
  onDone,
}: {
  action: ConfirmAction;
  onClose: () => void;
  onDone: (notice: string) => void;
}) {
  const { kind, teacher } = action;
  const disableMutation = useDisableAdminTeacher();
  const enableMutation = useEnableAdminTeacher();
  const updateMutation = useUpdateAdminTeacher();

  const pending =
    disableMutation.isPending ||
    enableMutation.isPending ||
    updateMutation.isPending;
  const error =
    disableMutation.error ??
    enableMutation.error ??
    updateMutation.error ??
    null;

  const config = confirmCopy(kind, teacher);

  function handleConfirm() {
    if (kind === "disable") {
      // mutationFn 直接是 disableAdminTeacherApi(id)，变量即教师 id
      disableMutation.mutate(teacher.id, {
        onSuccess: () => {
          onDone(`已停用「${teacher.loginName}」`);
          onClose();
        },
      });
    } else if (kind === "enable") {
      enableMutation.mutate(teacher.id, {
        onSuccess: () => {
          onDone(`已启用「${teacher.loginName}」`);
          onClose();
        },
      });
    } else {
      updateMutation.mutate(
        { id: teacher.id, request: { isAdmin: kind === "grant" } },
        {
          onSuccess: () => {
            onDone(
              kind === "grant"
                ? `已授予「${teacher.loginName}」管理员权限`
                : `已撤销「${teacher.loginName}」的管理员权限`,
            );
            onClose();
          },
        },
      );
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{config.title}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error instanceof Error ? error.message : "操作失败，请稍后重试"}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onClose}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            type="button"
            variant={kind === "disable" ? "destructive" : "default"}
            className="min-h-11 px-4"
            disabled={pending}
            onClick={handleConfirm}
          >
            {pending ? "正在处理…" : config.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 确认弹层文案（§4.1：影响先说清——具体到学生数与可恢复性） */
function confirmCopy(
  kind: ConfirmAction["kind"],
  teacher: AdminTeacherSummary,
): { title: string; description: string; confirmLabel: string } {
  switch (kind) {
    case "disable":
      return {
        title: `停用「${teacher.loginName}」？`,
        description: `该老师的登录将立即失效；其名下 ${teacher.studentCount} 名学生不受影响，历史数据全部保留；可随时重新启用。`,
        confirmLabel: "确认停用",
      };
    case "enable":
      return {
        title: `启用「${teacher.loginName}」？`,
        description:
          "重新启用后该老师可立即用原登录名与密码登录，数据完整恢复。",
        confirmLabel: "确认启用",
      };
    case "grant":
      return {
        title: `授予「${teacher.loginName}」管理员权限？`,
        description:
          "对方将能进入管理端：管理教师账号（含停用老师、重置密码）与注册开关。请谨慎授予。",
        confirmLabel: "授予管理员",
      };
    case "revoke":
      return {
        title: `撤销「${teacher.loginName}」的管理员权限？`,
        description:
          "对方将无法再进入管理端（教师功能不受影响）。系统必须保留至少一位可用管理员。",
        confirmLabel: "撤销管理员",
      };
  }
}

// ---------- 一次性明文弹窗（§4.4：关闭后不可再查） ----------

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
        <p
          data-testid="one-time-password"
          className="rounded-lg bg-muted px-4 py-3 text-center font-mono text-lg break-all select-all"
        >
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

// 供 App.tsx 路由级懒加载
export default AdminTeachersPage;
