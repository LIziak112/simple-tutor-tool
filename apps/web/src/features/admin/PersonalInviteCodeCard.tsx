import { adminPersonalInviteCodeSchema } from "@tutor/contract";
import { KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminSettings, useUpdateAdminSettings } from "./admin-queries";

/**
 * 个人学习邀请码卡（模块 0，Q7 定案 b）：管理端概览页就地配置。
 * - 有邀请码 = 个人学习注册开放（登录页出现「用邀请码注册」）；清空 = 关闭；
 * - 邀请码明文可见（管理员要念给人听 / 发给人），不是机密凭据，但也不在站外展示；
 * - 三态齐全：加载中骨架 / 失败重试 / 正常表单；保存成功后以服务端回显为准。
 */
export function PersonalInviteCodeCard() {
  const settingsQuery = useAdminSettings();
  const update = useUpdateAdminSettings();
  const [draft, setDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const current = settingsQuery.data?.personalInviteCode ?? null;
  // 服务端值落定 / 变化时同步到输入框（保存成功后回显 trim 后的值）
  useEffect(() => {
    setDraft(current ?? "");
  }, [current]);

  if (settingsQuery.isPending) {
    return (
      <div
        role="status"
        aria-label="正在加载个人学习邀请码"
        className="h-28 animate-pulse rounded-xl border border-border bg-muted/50"
      />
    );
  }
  if (settingsQuery.isError) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"
      >
        <p className="flex items-center gap-2 text-sm text-destructive">
          <TriangleAlert aria-hidden className="size-4 shrink-0" />
          个人学习邀请码加载失败：
          {settingsQuery.error instanceof Error
            ? settingsQuery.error.message
            : "网络异常，请稍后重试"}
        </p>
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => void settingsQuery.refetch()}
        >
          重试
        </Button>
      </div>
    );
  }

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = adminPersonalInviteCodeSchema.safeParse(draft);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "邀请码格式不正确");
      return;
    }
    setFormError(null);
    update.mutate({ personalInviteCode: parsed.data });
  }
  function handleClose() {
    setFormError(null);
    update.mutate({ personalInviteCode: null });
  }

  const open = current !== null;
  const shownError =
    formError ?? (update.error instanceof Error ? update.error.message : null);

  return (
    <form
      onSubmit={handleSave}
      noValidate
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground"
    >
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <KeyRound aria-hidden className="size-4" />
          个人学习注册（邀请码）
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          当前状态：
          <span
            data-testid="personal-registration-state"
            className={
              open
                ? "font-medium text-primary"
                : "font-medium text-muted-foreground"
            }
          >
            {open ? "开放中" : "已关闭"}
          </span>
          。配置邀请码后，个人学习者可在登录页凭邀请码自助注册（一个账号 =
          学习视角 + 管理视角，一枚 AI Token）；清空即关闭。已注册账号不受影响。
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="personal-invite-code" className="text-sm font-medium">
            邀请码
          </label>
          <Input
            id="personal-invite-code"
            type="text"
            name="personalInviteCode"
            autoComplete="off"
            placeholder="1–64 个字符，发给需要注册的人"
            value={draft}
            aria-invalid={shownError != null}
            onChange={(e) => setDraft(e.target.value)}
            disabled={update.isPending}
            className="min-h-11"
          />
        </div>
        <Button
          type="submit"
          className="min-h-11 px-4"
          disabled={update.isPending || draft.trim().length === 0}
        >
          {update.isPending ? (
            <>
              <Loader2 aria-hidden className="animate-spin" />
              正在保存…
            </>
          ) : open ? (
            "更新邀请码"
          ) : (
            "保存并开放个人注册"
          )}
        </Button>
        {open && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-4"
            disabled={update.isPending}
            onClick={handleClose}
          >
            关闭个人注册
          </Button>
        )}
      </div>
      {shownError != null && (
        <p role="alert" className="text-sm text-destructive">
          {shownError}
        </p>
      )}
    </form>
  );
}
