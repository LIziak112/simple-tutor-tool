import {
  type KeyboardEvent,
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export interface MaterialSplitHandleProps {
  /** 当前左侧材料分栏比例（百分比，35~65） */
  ratio: number;
  /** 比例调整回调 */
  onRatioChange: (ratio: number) => void;
  /** 最小比例（默认 35） */
  minRatio?: number;
  /** 最大比例（默认 65） */
  maxRatio?: number;
  /** 分栏外层容器引用，用于换算指针像素到百分比 */
  containerRef?: React.RefObject<HTMLElement | null> | undefined;
  /** 是否禁用拖拽与键盘交互 */
  disabled?: boolean;
  /** 附加样式类 */
  className?: string;
  /** 自定义无障碍标签 */
  ariaLabel?: string;
}

/**
 * 材料题型中缝拖拽 Handle（Fenbi / 公考 / 申论阅读题分栏中缝）：
 * - 允许学生自由调整材料与题目宽度占比在 35%~65% 之间；
 * - 支持指针拖拽（pointerdown + setPointerCapture + clientX 换算）；
 * - 拖拽期间全局捕获指针，并施加 col-resize 与 user-select: none 防止文本跳选；
 * - 支持键盘无障碍微调（ArrowLeft/Right ±1%、Shift+Arrow ±5%、Home/End 极值）；
 * - role="separator" + aria-orientation="vertical" + aria-valuenow。
 */
export const MaterialSplitHandle = memo(function MaterialSplitHandle({
  ratio,
  onRatioChange,
  minRatio = 35,
  maxRatio = 65,
  containerRef,
  disabled = false,
  className = "",
  ariaLabel = "调整材料与题目分栏比例",
}: MaterialSplitHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const pointerIdRef = useRef<number | null>(null);
  const handleRef = useRef<HTMLDivElement>(null);

  const clamp = useCallback(
    (value: number) => Math.min(maxRatio, Math.max(minRatio, value)),
    [minRatio, maxRatio],
  );

  const resolveContainer = useCallback((): HTMLElement | null => {
    return (
      containerRef?.current ??
      handleRef.current?.closest<HTMLElement>('[data-layout="compare"]') ??
      handleRef.current?.parentElement ??
      null
    );
  }, [containerRef]);

  const updateRatioFromClientX = useCallback(
    (clientX: number) => {
      const container = resolveContainer();
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const relativeX = clientX - rect.left;
      const rawPercent = (relativeX / rect.width) * 100;
      onRatioChange(clamp(Math.round(rawPercent)));
    },
    [resolveContainer, clamp, onRatioChange],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || e.button !== 0) return;
      e.preventDefault();
      const target = e.currentTarget;
      pointerIdRef.current = e.pointerId;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // 部分环境或单测中 setPointerCapture 可能未实现，防御忽略
      }
      setIsDragging(true);
    },
    [disabled],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isDragging || disabled) return;
      updateRatioFromClientX(e.clientX);
    },
    [isDragging, disabled, updateRatioFromClientX],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      setIsDragging(false);
      if (pointerIdRef.current !== null) {
        try {
          e.currentTarget.releasePointerCapture(pointerIdRef.current);
        } catch {
          // 防御忽略
        }
        pointerIdRef.current = null;
      }
    },
    [isDragging],
  );

  // 全局指针监听：在拖拽期间保障鼠标移出/失焦时的平滑响应与文本防选
  useEffect(() => {
    if (!isDragging) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onWindowPointerMove = (e: PointerEvent) => {
      updateRatioFromClientX(e.clientX);
    };

    const onWindowPointerUp = () => {
      setIsDragging(false);
      pointerIdRef.current = null;
    };

    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerUp);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerUp);
    };
  }, [isDragging, updateRatioFromClientX]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const step = e.shiftKey ? 5 : 1;
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowDown":
          e.preventDefault();
          onRatioChange(clamp(ratio - step));
          break;
        case "ArrowRight":
        case "ArrowUp":
          e.preventDefault();
          onRatioChange(clamp(ratio + step));
          break;
        case "Home":
          e.preventDefault();
          onRatioChange(minRatio);
          break;
        case "End":
          e.preventDefault();
          onRatioChange(maxRatio);
          break;
      }
    },
    [disabled, ratio, clamp, minRatio, maxRatio, onRatioChange],
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: 垂直可拖拽中缝需遵循 WAI-ARIA separator 规范（不可用 hr 替代）
    <div
      ref={handleRef}
      role="separator"
      tabIndex={disabled ? -1 : 0}
      aria-orientation="vertical"
      aria-valuenow={ratio}
      aria-valuemin={minRatio}
      aria-valuemax={maxRatio}
      aria-valuetext={`材料占比 ${ratio}%，题目占比 ${100 - ratio}%`}
      aria-label={ariaLabel}
      aria-disabled={disabled}
      data-slot="material-split-handle"
      data-ratio={ratio}
      data-dragging={isDragging}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      style={{ touchAction: "none" }}
      className={`group relative flex w-3 shrink-0 cursor-col-resize select-none items-center justify-center transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring before:absolute before:inset-y-0 before:-left-2 before:-right-2 before:content-[''] ${
        disabled ? "pointer-events-none opacity-40" : ""
      } ${className}`}
    >
      {/* 中间可见分割线 */}
      <div
        className={`h-full w-[2px] rounded-full transition-colors motion-reduce:transition-none ${
          isDragging
            ? "bg-primary"
            : "bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary"
        }`}
      />
      {/* 拖拽 Handle 指示点胶囊 */}
      <div
        className={`pointer-events-none absolute z-10 flex flex-col items-center justify-center gap-1 rounded-full border border-border bg-card px-0.5 py-2.5 shadow-xs transition-transform motion-reduce:transition-none ${
          isDragging
            ? "scale-110 border-primary bg-primary text-primary-foreground shadow-sm"
            : "text-muted-foreground group-hover:border-primary/50 group-hover:text-foreground"
        }`}
      >
        <span className="size-1 rounded-full bg-current opacity-70" />
        <span className="size-1 rounded-full bg-current opacity-70" />
        <span className="size-1 rounded-full bg-current opacity-70" />
      </div>
    </div>
  );
});
