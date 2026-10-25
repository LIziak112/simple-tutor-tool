import {
  AlertTriangle,
  Ban,
  ChevronDown,
  Grid2X2,
  WifiOff,
} from "lucide-react";
import { type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { useAttemptEditor } from "./AttemptEditorContext";

/** 手机答题卡入口兼作紧凑进度；完整统计在面板中呈现。 */
export function AttemptNavigatorButton({
  children,
  onOpen,
  disabled = false,
  icon = true,
}: {
  children: ReactNode;
  onOpen: () => void;
  disabled?: boolean;
  icon?: boolean;
}) {
  const progressId = useId();
  return (
    <Button
      variant="ghost"
      className="h-11 shrink-0 gap-1 px-2 lg:hidden"
      aria-label="答题卡"
      aria-describedby={progressId}
      aria-haspopup="dialog"
      disabled={disabled}
      onClick={onOpen}
    >
      {icon && <Grid2X2 aria-hidden className="size-4" />}
      <span id={progressId} className="tabular-nums text-sm">
        {children}
      </span>
      <ChevronDown aria-hidden className="size-3" />
    </Button>
  );
}

/**
 * 答题页吸底操作条（T2.6 建立，T2.12 抽成组件并加离线交卷保护）：
 * - 已答进度 + 保存/上传/交卷错误提示 + 交卷按钮；
 * - 离线（T2.12）：交卷按钮禁用并提示「离线中，已作答内容保存在本机，
 *   恢复网络后可交卷」——离线时交卷必然失败，提前禁用比让用户点了再报错
 *   更友好；作答不受影响（草稿本地保存，T2.9），恢复网络自动可交；
 * - 无权限（T2A.6，D7）：保存/上传收到 403/404 的终态——交卷同样必然被拒，
 *   按钮禁用并提示「已无权限访问该练习」。
 * 从页面文件抽出以便直接做组件测试（离线态渲染断言），页面只负责接线。
 * 手机仅保留一行：列表的答题卡入口携带填写数，单题的题号入口嵌入主操作。
 * 完整统计、提前交卷在答题卡面板查看；桌面沿用进度条和次级交卷入口。
 * 异常提示独立于桌面统计，避免窄屏隐藏进度时一并隐藏保存失败与离线状态。
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
  const navigatorButton = onOpenNavigator && !compact && (
    <AttemptNavigatorButton onOpen={onOpenNavigator}>
      <span className="hidden min-[390px]:inline">答题卡 · </span>已填{" "}
      {answered}/{total}
    </AttemptNavigatorButton>
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
      </p>
      {/* 进度条只在桌面出现，手机通过答题卡查看详细进度。 */}
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
  const notices = (
    <>
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
    </>
  );
  const submitDisabled = total === 0 || offline || denied;
  return (
    <div
      data-slot="attempt-bottom-bar"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur group-data-[keyboard-open=true]/workspace:hidden"
    >
      {compact ? (
        <div className="mx-auto flex min-h-14 w-full max-w-[1120px] items-center gap-2 px-3 py-1.5 sm:px-6">
          <div className="min-w-0 flex-1 lg:order-2 lg:shrink-0 lg:flex-none">
            {primaryActions}
          </div>
          <div
            data-slot="attempt-desktop-progress"
            className="hidden min-w-0 flex-1 items-center gap-2 lg:flex"
          >
            {progress}
            {!hideSubmit && !viewResult && (
              <Button
                variant="ghost"
                className="h-11 shrink-0 px-3 text-sm text-muted-foreground lg:order-3"
                disabled={submitDisabled}
                onClick={onOpenSubmit}
              >
                提前交卷
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="mx-auto flex min-h-14 w-full max-w-[1120px] items-center justify-between gap-2 px-3 py-1.5 sm:px-6">
          {navigatorButton}
          <div
            data-slot="attempt-desktop-progress"
            className={`${onOpenNavigator ? "hidden lg:flex" : "flex"} min-w-0 flex-1`}
          >
            {progress}
          </div>
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
      {(offline ||
        denied ||
        saveFailed ||
        inkFlushError ||
        submitError !== null) && (
        <div
          role="status"
          className="mx-auto flex max-w-[1120px] flex-col gap-1 px-3 pb-2 sm:px-6"
        >
          {notices}
        </div>
      )}
    </div>
  );
}
