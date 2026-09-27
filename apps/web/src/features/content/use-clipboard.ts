import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 剪贴板复制 hook（T2A.3）：批量导入页「复制全部错误给 AI」使用；
 * ErrorPanel 有自己的完整实现（含降级弹层回焦），此 hook 提供同样的两段式：
 * - copy(text)：优先 navigator.clipboard.writeText；成功 → copied=true（3 秒轻提示）；
 * - 剪贴板不可用（http 非安全上下文/被拒绝）→ fallbackText 置值，调用方渲染
 *   手动复制弹层（全选 + Ctrl+C），closeFallback 关闭并把焦点还给按钮。
 */
export function useClipboardCopy() {
  const [copied, setCopied] = useState(false);
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // 复制成功的轻提示自动消失
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async (text: string): Promise<void> => {
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setFallbackText(text);
    }
  }, []);

  const closeFallback = useCallback((): void => {
    setFallbackText(null);
    buttonRef.current?.focus();
  }, []);

  return { copied, fallbackText, buttonRef, copy, closeFallback };
}
