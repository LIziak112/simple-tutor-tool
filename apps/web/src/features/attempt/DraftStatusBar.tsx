import dayjs from "dayjs";
import { Ban, Check, CloudOff, LoaderCircle } from "lucide-react";
import { DISPLAY_TZ } from "@/lib/time";
import type { DraftSaveStatus } from "./use-draft-sync";

/**
 * 顶栏草稿状态（T2.9 三态）：
 * - 保存中…（本地有未确认内容，正在/等待同步）
 * - 已保存 HH:mm（本地与服务端一致；从未作答时不带时间）
 * - 离线，已存本机（断网或最近同步失败；作答不中断，恢复后自动补发）
 * 纯展示、无交互，不设触控目标要求；文案中文（ui-conventions）。
 */
export function DraftStatusBar({ status }: { status: DraftSaveStatus }) {
  if (status.state === "saving") {
    return (
      <p
        data-testid="draft-status"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
        保存中…
      </p>
    );
  }
  if (status.state === "offline") {
    return (
      <p
        data-testid="draft-status"
        className="flex items-center gap-1.5 text-xs text-amber-600"
      >
        <CloudOff aria-hidden className="size-3.5" />
        离线，已存本机
      </p>
    );
  }
  if (status.state === "denied") {
    return (
      <p
        data-testid="draft-status"
        role="alert"
        className="flex items-center gap-1.5 text-xs text-red-600"
      >
        <Ban aria-hidden className="size-3.5" />
        已无权限访问该练习
      </p>
    );
  }
  const time =
    status.savedAt > 0
      ? ` ${dayjs(status.savedAt).tz(DISPLAY_TZ).format("HH:mm")}`
      : "";
  return (
    <p
      data-testid="draft-status"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Check aria-hidden className="size-3.5" />
      已保存{time}
    </p>
  );
}
