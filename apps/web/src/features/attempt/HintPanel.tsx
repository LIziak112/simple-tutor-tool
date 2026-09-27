import type { HintOpenedEntry } from "@tutor/contract";
import { Lightbulb, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { openAttemptHintApi } from "@/lib/api";

/**
 * 题卡提示面板（T2.11 分步提示）：
 * - 「给我一点提示（剩余 n 条）」按钮（≥44px 触控）逐条解锁，已解锁提示
 *   列表常驻展示（含公式经 RichMarkdown 渲染）；
 * - 受控组件：hints 由页面（AnswerView）持有——草稿视图的 hintsOpened 回显
 *   （刷新不丢）+ 解锁成功后 onUnlocked 上抛追加；面板内部只管请求的
 *   加载/错误态（失败留在原地，点按钮即重试）；
 * - hintCount=0 的题整体不渲染（调用方也不传）；
 * - hint_open 事件由服务端在接口内直记（不经前端事件队列，避免双计）。
 */

/** 已解锁提示列表（答题面板与结果视图回看共用） */
export function HintEntryList({
  entries,
}: {
  entries: readonly HintOpenedEntry[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {entries.map((entry) => (
        <div
          key={entry.index}
          className="rounded-lg border border-amber-300/70 bg-amber-50 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-500/10"
        >
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
            <Lightbulb aria-hidden className="size-4" />
            提示 {entry.index + 1}
          </p>
          <RichMarkdown source={entry.text} className="text-sm" />
        </div>
      ))}
    </div>
  );
}

/** 解锁面板本体 */
export function HintPanel({
  attemptId,
  questionId,
  hintCount,
  hints,
  onUnlocked,
}: {
  attemptId: string;
  questionId: string;
  /** 该题提示总数（question.hintCount） */
  hintCount: number;
  /** 当前已解锁条目（升序；空数组=未解锁过） */
  hints: readonly HintOpenedEntry[];
  /** 解锁成功回调（上抛页面状态追加；面板内不持有列表） */
  onUnlocked: (entry: HintOpenedEntry) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = hintCount - hints.length;
  // 下一个要解锁的序号 = 最小未解锁值（正常流即「已解锁数」，防御非连续态）
  const openedIndexes = new Set(hints.map((entry) => entry.index));
  let nextIndex = 0;
  while (openedIndexes.has(nextIndex)) nextIndex += 1;

  const unlock = async () => {
    if (pending || remaining <= 0 || nextIndex >= hintCount) return;
    setPending(true);
    setError(null);
    try {
      const data = await openAttemptHintApi(attemptId, questionId, nextIndex);
      onUnlocked({ index: data.index, text: data.hint });
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message}，点按钮重试`
          : "提示获取失败，请检查网络后点按钮重试",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {hints.length > 0 && <HintEntryList entries={hints} />}
      {remaining > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-fit"
            disabled={pending}
            onClick={() => void unlock()}
          >
            {pending ? (
              <LoaderCircle aria-hidden className="size-4 animate-spin" />
            ) : (
              <Lightbulb aria-hidden className="size-4" />
            )}
            {pending ? "正在获取提示…" : `给我一点提示（剩余 ${remaining} 条）`}
          </Button>
          {error !== null && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
