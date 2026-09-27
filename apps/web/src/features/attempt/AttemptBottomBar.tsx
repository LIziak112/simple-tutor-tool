import { AlertTriangle, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 答题页吸底操作条（T2.6 建立，T2.12 抽成组件并加离线交卷保护）：
 * - 已答进度 + 保存/上传/交卷错误提示 + 交卷按钮；
 * - 离线（T2.12）：交卷按钮禁用并提示「离线中，已作答内容保存在本机，
 *   恢复网络后可交卷」——离线时交卷必然失败，提前禁用比让用户点了再报错
 *   更友好；作答不受影响（草稿本地保存，T2.9），恢复网络自动可交。
 * 从页面文件抽出以便直接做组件测试（离线态渲染断言），页面只负责接线。
 */
export function AttemptBottomBar({
  answered,
  total,
  offline,
  saveFailed,
  inkFlushError,
  submitError,
  onOpenSubmit,
}: {
  answered: number;
  total: number;
  /** 是否离线（useOnlineStatus；离线时禁用交卷） */
  offline: boolean;
  /** 有答案保存失败（T2.9 草稿链路） */
  saveFailed: boolean;
  /** 交卷 flush 笔迹失败（T2.8） */
  inkFlushError: boolean;
  /** 交卷请求失败的错误文案（null=无错误） */
  submitError: string | null;
  onOpenSubmit: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span>
            已答 <b className="text-primary">{answered}</b> / {total} 题
          </span>
          {offline && (
            <span className="flex items-center gap-1 text-xs text-amber-600">
              <WifiOff aria-hidden className="size-4" />
              离线中，已作答内容保存在本机，恢复网络后可交卷
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
        <Button
          className="min-h-11 shrink-0 px-6"
          disabled={total === 0 || offline}
          onClick={onOpenSubmit}
        >
          交卷
        </Button>
      </div>
    </div>
  );
}
