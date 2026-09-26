import type { StudentSummary } from "@tutor/contract";
import {
  Archive,
  ArchiveRestore,
  CircleCheck,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RotateCcw,
  TriangleAlert,
  UserRound,
  UserRoundPlus,
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
 * - 列表：姓名、登录名、专属链接/密码开关（可直接点按切换）、归档标记、备注；
 * - 新增：姓名 + 登录名（缺省同姓名）+ 可选初始密码（留空自动生成，一次性展示）；
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
  const studentsQuery = useStudents(includeArchived);

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
                onOneTime={setOneTime}
              />
            ))}
          </ul>
        ))}

      {createOpen && (
        <CreateStudentDialog
          onClose={() => setCreateOpen(false)}
          onOneTime={setOneTime}
        />
      )}

      {oneTime && (
        <OneTimeValueDialog value={oneTime} onClose={() => setOneTime(null)} />
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
  onOneTime,
}: {
  student: StudentSummary;
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
  onClose,
  onOneTime,
}: {
  onClose: () => void;
  onOneTime: (value: OneTimeValue) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [loginName, setLoginName] = useState("");
  /** 登录名是否被手动改过（未改过则跟随姓名自动填充） */
  const [loginNameTouched, setLoginNameTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const createMutation = useCreateStudent();

  const effectiveLoginName = loginNameTouched ? loginName : displayName;

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

// 供 App.tsx 路由级懒加载
export default StudentsPage;
