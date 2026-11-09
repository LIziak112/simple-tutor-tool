import { Check, HardDriveDownload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** 轻提示停留时长：够瞥一眼、不盖住下一次作答 */
export const SAVE_TOAST_DURATION_MS = 1600;

/** 保存状态摘要里「正在落盘/同步」的几种措辞（useAttemptSaveStatus） */
const SAVING_STATUSES = new Set(["正在保存到本机…", "已存本机，正在同步…"]);
/** 载入期的恢复措辞：还没到「静止」，不算用户作答前的基线 */
const RECOVERING_STATUS = "正在恢复作答与材料…";

/** 已到达一次静止态（非恢复、非保存中）——此后的保存边沿才是用户作答引起的 */
export function isSettledSaveStatus(status: string): boolean {
  return status !== RECOVERING_STATUS && !SAVING_STATUSES.has(status);
}

export type SaveToastKind = "saved" | "local";

/**
 * 由保存状态摘要推导轻提示：只在「正在保存 → 已保存」的边沿亮一次，静止态
 * 不反复提示；离线时落到本机也给一次「已存本机」。返回 null 表示不显示。
 */
export function saveToastTransition(
  previous: string | null,
  next: string,
): SaveToastKind | null {
  if (previous === null || previous === next) return null;
  if (!SAVING_STATUSES.has(previous)) return null;
  if (next === "全部已保存") return "saved";
  if (next === "离线，已存本机" || next === "已存本机，等待同步")
    return "local";
  return null;
}

/**
 * 监听保存状态摘要的边沿，产出当前应显示的轻提示（自动在停留后消失）。
 * 页面载入期的材料恢复 / 首次同步也会走一遍「正在同步 → 全部已保存」，那不是
 * 用户作答，不提示：先见过一次静止态（isSettledSaveStatus）才开始亮灯。
 */
export function useSaveToast(
  saveStatus: string,
  durationMs = SAVE_TOAST_DURATION_MS,
): SaveToastKind | null {
  const previous = useRef<string | null>(null);
  const settled = useRef(false);
  const [toast, setToast] = useState<{
    kind: SaveToastKind;
    at: number;
  } | null>(null);
  useEffect(() => {
    const kind = settled.current
      ? saveToastTransition(previous.current, saveStatus)
      : null;
    previous.current = saveStatus;
    if (isSettledSaveStatus(saveStatus)) settled.current = true;
    if (kind !== null) setToast({ kind, at: Date.now() });
  }, [saveStatus]);
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), durationMs);
    return () => window.clearTimeout(timer);
  }, [toast, durationMs]);
  return toast?.kind ?? null;
}

/**
 * 草稿自动保存轻提示（阶段 B 做题工作区改版，2026-11）：作答落盘后在底栏
 * 上方浮一枚「已保存」胶囊，1.6s 自动消失；离线时落本机显示「已存本机」。
 * 读屏播报仍由页头 sr-only 的 draft-status 负责（aria-live），本件 aria-hidden
 * 避免同一状态被播报两遍；位置跟随底栏实测高度变量，不盖住操作条。
 */
export function AttemptSaveToast({ kind }: { kind: SaveToastKind | null }) {
  if (kind === null) return null;
  return (
    <div
      aria-hidden
      data-slot="attempt-save-toast"
      data-kind={kind}
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--attempt-footer-height,64px)+12px)] z-30 flex justify-center px-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
    >
      <span className="flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur">
        {kind === "saved" ? (
          <Check aria-hidden className="size-3.5 text-primary" />
        ) : (
          <HardDriveDownload aria-hidden className="size-3.5 text-amber-600" />
        )}
        {kind === "saved" ? "已保存" : "已存本机"}
      </span>
    </div>
  );
}
