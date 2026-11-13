import {
  type ReactNode,
  useCallback,
  useRef,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import type { LazyMountWindow } from "./lazy-mount-window";

/** 定位锚点常驻，昂贵的题面与结果控件靠近视口才首次挂载。 */
export function ResultQuestionRow({
  questionId,
  index,
  height,
  controller,
  lazy,
  children,
}: {
  questionId: string;
  index: number;
  height: number;
  controller: LazyMountWindow | null;
  lazy: boolean;
  children: ReactNode;
}) {
  const elementRef = useRef<HTMLLIElement | null>(null);
  const register = useCallback(
    (element: HTMLLIElement | null) => {
      elementRef.current = element;
      controller?.attach(questionId, element);
    },
    [controller, questionId],
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      controller?.subscribe(questionId, listener) ?? (() => {}),
    [controller, questionId],
  );
  const snapshot = useCallback(
    () => controller?.isMounted(questionId) ?? false,
    [controller, questionId],
  );
  const mounted = useSyncExternalStore(subscribe, snapshot, snapshot);
  const reveal = () => {
    flushSync(() => controller?.forceMount(questionId));
    elementRef.current
      ?.querySelector<HTMLElement>("[data-review-heading]")
      ?.focus({ preventScroll: true });
  };
  return (
    <li
      ref={register}
      data-review-question={questionId}
      className="min-w-0 scroll-mt-[calc(var(--attempt-header-height,96px)+16px)]"
    >
      {!lazy || mounted ? (
        children
      ) : (
        <div
          data-slot="result-question-placeholder"
          className="rounded-lg border border-dashed border-border/70 bg-card/40 p-4"
          style={{ minHeight: height }}
        >
          <button
            type="button"
            onFocus={reveal}
            onClick={reveal}
            className="min-h-11 rounded-md px-3 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            显示第 {index + 1} 题
          </button>
        </div>
      )}
    </li>
  );
}
