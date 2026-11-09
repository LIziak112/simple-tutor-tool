import {
  AlertTriangle,
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Grid2X2,
  WifiOff,
} from "lucide-react";
import { type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { useAttemptEditor } from "./AttemptEditorContext";

const pressFeedback =
  "duration-150 ease-out motion-safe:transition-transform motion-safe:enabled:active:scale-[0.96] motion-reduce:transition-opacity motion-reduce:enabled:active:opacity-75";

/** 列表与单题共用底栏答题卡入口。 */
export function AttemptNavigatorButton({
  children,
  onOpen,
  disabled = false,
}: {
  children: ReactNode;
  onOpen: (trigger: HTMLButtonElement) => void;
  disabled?: boolean;
}) {
  const progressId = useId();
  return (
    <Button
      variant="ghost"
      className={`min-h-11 min-w-0 gap-1.5 ps-3 pe-2.5 ${pressFeedback}`}
      aria-label="答题卡"
      aria-describedby={progressId}
      aria-haspopup="dialog"
      disabled={disabled}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <Grid2X2 aria-hidden className="size-4" />
      <span
        id={progressId}
        className="flex items-center gap-1.5 tabular-nums text-sm"
      >
        {children}
      </span>
      <ChevronDown aria-hidden className="size-3 shrink-0" />
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
 * 列表的答题卡入口携带填写数；单题的题号入口嵌入主操作。
 * 异常提示独立于桌面统计，避免窄屏隐藏进度时一并隐藏保存失败与离线状态。
 *
 * 阶段 B 做题工作区改版（2026-11）：列表模式底栏收成「上一题 / 答题卡进度 /
 * 下一题 / 交卷」四件——上一题/下一题按滚动当前题步进（窄屏仅图标、可达名
 * 保留），交卷旁挂「未答 n」徽标并支持一键跳到第一道未答题（sm 起显示；
 * 窄屏 56px 底栏放不下，依靠答题卡入口与交卷确认弹层里的同款入口）。
 * 进度条随之移除（已填写/未答计数已把进度说清，进度条在 56px 底栏里只剩装饰）。
 */
export function AttemptBottomBar({
  primaryActions,
  progressLabel,
  answered,
  total,
  offline,
  denied,
  saveFailed,
  inkFlushError,
  submitError,
  practiceSubmittedCount,
  viewResult = false,
  hasPrev = false,
  hasNext = false,
  onPrev,
  onNext,
  onJumpUnanswered,
  onOpenSubmit,
  onViewResult,
  onOpenNavigator,
}: {
  primaryActions?: ReactNode;
  /** 单题紧凑布局的进度文案（替代默认「已填写/已提交」计数） */
  progressLabel?: ReactNode;
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
  /** 列表模式按滚动当前题步进；缺省不渲染上一题/下一题 */
  hasPrev?: boolean | undefined;
  hasNext?: boolean | undefined;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  /** 一键跳到第一道未答题（未答徽标的点击动作） */
  onJumpUnanswered?: (() => void) | undefined;
  onOpenSubmit: () => void;
  onViewResult?: (() => void) | undefined;
  onOpenNavigator?: ((trigger: HTMLButtonElement) => void) | undefined;
}) {
  const editor = useAttemptEditor();
  if (editor?.active?.kind === "annotation") return null;
  const compact = Boolean(primaryActions);
  const unanswered = Math.max(0, total - answered);
  const navigatorButton = onOpenNavigator && !compact && (
    <AttemptNavigatorButton onOpen={onOpenNavigator}>
      答题卡 · 已填写 {answered}/{total}
    </AttemptNavigatorButton>
  );
  const progress = (
    <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
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
  );
  const stepButtons = (onPrev !== undefined || onNext !== undefined) && {
    prev: (
      <Button
        type="button"
        variant="outline"
        className={`h-11 min-w-11 shrink-0 gap-1 px-2 sm:px-3 ${pressFeedback}`}
        aria-label="上一题"
        title="上一题（K）"
        disabled={!hasPrev}
        onClick={onPrev}
      >
        <ChevronLeft aria-hidden className="size-4" />
        <span aria-hidden className="hidden sm:inline">
          上一题
        </span>
      </Button>
    ),
    next: (
      <Button
        type="button"
        variant="outline"
        className={`h-11 min-w-11 shrink-0 gap-1 px-2 sm:px-3 ${pressFeedback}`}
        aria-label="下一题"
        title="下一题（J）"
        disabled={!hasNext}
        onClick={onNext}
      >
        <span aria-hidden className="hidden sm:inline">
          下一题
        </span>
        <ChevronRight aria-hidden className="size-4" />
      </Button>
    ),
  };
  // 未答徽标：交卷前把「还差几题」亮在交卷旁，点一下跳到第一道未答题
  const unansweredBadge = !viewResult &&
    unanswered > 0 &&
    onJumpUnanswered !== undefined && (
      <Button
        type="button"
        variant="ghost"
        data-slot="attempt-unanswered-badge"
        className={`hidden h-11 shrink-0 gap-1 px-2.5 text-amber-700 tabular-nums sm:inline-flex dark:text-amber-400 ${pressFeedback}`}
        title="跳到第一道未答题"
        onClick={onJumpUnanswered}
      >
        <AlertTriangle aria-hidden className="size-4" />
        未答 {unanswered}
      </Button>
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
        <div className="mx-auto flex min-h-14 w-full max-w-[1120px] items-center gap-2 px-3 py-1.5 sm:px-6 xl:max-w-[1280px]">
          <div className="min-w-0 flex-1 lg:order-2 lg:shrink-0 lg:flex-none">
            {primaryActions}
          </div>
          <div
            data-slot="attempt-desktop-progress"
            className="hidden min-w-0 flex-1 items-center gap-2 lg:flex"
          >
            {progress}
          </div>
        </div>
      ) : (
        <div className="mx-auto flex min-h-14 w-full max-w-[1120px] items-center gap-2 px-3 py-1.5 sm:px-6 xl:max-w-[1280px]">
          {stepButtons ? stepButtons.prev : null}
          <div className="flex min-w-0 flex-1 items-center">
            {navigatorButton}
            {!navigatorButton && (
              <div
                data-slot="attempt-desktop-progress"
                className="flex min-w-0 flex-1"
              >
                {progress}
              </div>
            )}
          </div>
          {unansweredBadge}
          {stepButtons ? stepButtons.next : null}
          {viewResult ? (
            <Button
              className={`h-11 min-w-[88px] shrink-0 px-4 text-base ${pressFeedback}`}
              onClick={onViewResult}
            >
              查看本次结果
            </Button>
          ) : (
            <Button
              className={`h-11 min-w-[72px] shrink-0 px-4 text-base ${pressFeedback}`}
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
          className="mx-auto flex max-w-[1120px] flex-col gap-1 px-3 pb-2 sm:px-6 xl:max-w-[1280px]"
        >
          {notices}
        </div>
      )}
    </div>
  );
}
