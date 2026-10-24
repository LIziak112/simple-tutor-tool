import { AlertTriangle, Ban, Grid2X2, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAttemptEditor } from "./AttemptEditorContext";

/**
 * 答题页吸底操作条（T2.6 建立，T2.12 抽成组件并加离线交卷保护）：
 * - 已答进度 + 保存/上传/交卷错误提示 + 交卷按钮；
 * - 离线（T2.12）：交卷按钮禁用并提示「离线中，已作答内容保存在本机，
 *   恢复网络后可交卷」——离线时交卷必然失败，提前禁用比让用户点了再报错
 *   更友好；作答不受影响（草稿本地保存，T2.9），恢复网络自动可交；
 * - 无权限（T2A.6，D7）：保存/上传收到 403/404 的终态——交卷同样必然被拒，
 *   按钮禁用并提示「已无权限访问该练习」。
 * 从页面文件抽出以便直接做组件测试（离线态渲染断言），页面只负责接线。
 * 单题紧凑布局（2026-10-24）：传入 primaryActions（单题主操作条）时，操作条
 * 与进度合并在同一容器（宽屏一行、窄屏两排，无内嵌卡片）；进度文案由
 * progressLabel 接管（题号 + 提交进度只出现这一处），整卷交卷降级为文字
 * 按钮「提前交卷」，禁用条件不变。
 */
export function AttemptBottomBar({
  primaryActions,
  hideSubmit = false,
  progressLabel,
  progressValue,
  answered,
  total,
  offline,
  denied,
  saveFailed,
  inkFlushError,
  submitError,
  practiceSubmittedCount,
  viewResult = false,
  onOpenSubmit,
  onViewResult,
  onOpenNavigator,
}: {
  primaryActions?: ReactNode;
  /** 单题主动作已经承担交卷时，隐藏重复的整卷入口。 */
  hideSubmit?: boolean;
  /** 单题紧凑布局的进度文案（替代默认「已填写/已提交」计数） */
  progressLabel?: ReactNode;
  /** 进度条比例（0–1）；缺省按已填写比例 */
  progressValue?: number | undefined;
  answered: number;
  total: number;
  /** 是否离线（useOnlineStatus；离线时禁用交卷） */
  offline: boolean;
  /** 访问权终态失去（403/404，T2A.6 D7；禁用交卷并提示） */
  denied: boolean;
  /** 有答案保存失败（T2.9 草稿链路） */
  saveFailed: boolean;
  /** 交卷 flush 笔迹失败（T2.8） */
  inkFlushError: boolean;
  /** 交卷请求失败的错误文案（null=无错误） */
  submitError: string | null;
  /** 逐题提交已提交数（v1 新协议卷；undefined = 旧卷不显示该行） */
  practiceSubmittedCount?: number | undefined;
  /** 逐题提交全部收尾：主按钮换「查看本次结果」（列表模式入口） */
  viewResult?: boolean | undefined;
  onOpenSubmit: () => void;
  onViewResult?: (() => void) | undefined;
  onOpenNavigator?: (() => void) | undefined;
}) {
  const editor = useAttemptEditor();
  if (editor?.active?.kind === "annotation") return null;
  const compact = Boolean(primaryActions);
  const ratio =
    progressValue ?? (total === 0 ? 0 : Math.min(1, answered / total));
  const navigatorButton = onOpenNavigator && (
    <Button
      variant="ghost"
      className="h-11 shrink-0 px-2 lg:hidden"
      aria-label="答题卡"
      onClick={onOpenNavigator}
    >
      <Grid2X2 aria-hidden className="size-4" />
      <span className="hidden min-[390px]:inline">答题卡</span>
      <span className="sr-only min-[390px]:hidden">答题卡</span>
    </Button>
  );
  const progress = (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {progressLabel !== undefined ? (
          <span aria-live="polite" className="tabular-nums">
            {progressLabel}
          </span>
        ) : (
          <>
            <span className="tabular-nums">
              已填写 <b className="text-primary">{answered}</b> / {total} 题
            </span>
            {practiceSubmittedCount !== undefined && (
              <span className="tabular-nums">
                已提交 {practiceSubmittedCount} / {total} 题
              </span>
            )}
          </>
        )}
        {offline && (
          <span className="flex items-center gap-1 text-xs text-amber-600">
            <WifiOff aria-hidden className="size-4" />
            离线中，已作答内容保存在本机，恢复网络后可交卷
          </span>
        )}
        {denied && (
          <span
            role="alert"
            className="flex items-center gap-1 text-xs text-destructive"
          >
            <Ban aria-hidden className="size-4" />
            已无权限访问该练习，无法继续作答或交卷
          </span>
        )}
        {saveFailed && (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <AlertTriangle aria-hidden className="size-4" />
            有答案保存失败，请检查网络后重试（重新作答该题即可）
          </span>
        )}
        {inkFlushError && (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <AlertTriangle aria-hidden className="size-4" />
            有题目的笔迹还没上传成功，交卷被暂时阻止——请检查网络后重新点「交卷」
          </span>
        )}
        {submitError !== null && (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <AlertTriangle aria-hidden className="size-4" />
            {submitError}
          </span>
        )}
      </p>
      {/* 进度条只作视觉提示（读屏已有进度文本） */}
      <div
        aria-hidden
        className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary motion-safe:transition-[width]"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
  const submitDisabled = total === 0 || offline || denied;
  return (
    <div
      data-slot="attempt-bottom-bar"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur group-data-[keyboard-open=true]/workspace:hidden"
    >
      {compact ? (
        // 单题紧凑布局：窄屏主操作在上、进度在下；宽屏同一行（进度居左）
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-1 px-3 py-2 sm:px-6 md:flex-row-reverse md:items-center md:gap-4">
          <div className="min-w-0 md:shrink-0">{primaryActions}</div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {navigatorButton}
            {progress}
            {!hideSubmit && !viewResult && (
              <Button
                variant="ghost"
                className="h-11 shrink-0 px-3 text-sm text-muted-foreground"
                disabled={submitDisabled}
                onClick={onOpenSubmit}
              >
                提前交卷
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="mx-auto flex min-h-16 w-full max-w-[1120px] items-center justify-between gap-3 px-3 py-2 sm:px-6">
          {navigatorButton}
          {progress}
          {hideSubmit ? null : viewResult ? (
            <Button
              className="h-11 min-w-[88px] shrink-0 px-4 text-base"
              onClick={onViewResult}
            >
              查看本次结果
            </Button>
          ) : (
            <Button
              className="h-11 min-w-[88px] shrink-0 px-4 text-base"
              disabled={submitDisabled}
              onClick={onOpenSubmit}
            >
              交卷
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
