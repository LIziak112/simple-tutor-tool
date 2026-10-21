import { useCallback, useEffect, useState } from "react";

/**
 * 滚动容器溢出检测，按需挂载 overscroll-contain。
 *
 * 现代浏览器对声明了 overscroll-behavior: contain 的滚动容器，即使内容未
 * 溢出也拦截向祖先的链式滚动——悬停在内容很短的浮动滚动区上时滚轮会锁死
 * 外层页面。本 hook 在内容溢出（纵向或横向）时输出 overscroll-contain
 * （内部滚到边界不带动页面），未溢出时输出 overscroll-auto（滚轮透传页面）。
 *
 * 回调 ref 设计：目标元素可条件渲染（如 fixedActive && open 才出现的固定
 * 对照栏），元素挂载时自动接线观察器并首查，不依赖宿主首挂载时机。
 *
 * enabled=false 时全部无操作（布局模式不消费滚动类名的场景，避免与外层
 * 容器重复观察同一子树）。
 */
export function useDynamicOverscroll<T extends HTMLElement>(options?: {
  enabled?: boolean;
}) {
  const enabled = options?.enabled ?? true;
  const [node, setNode] = useState<T | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  const checkOverflow = useCallback(() => {
    if (!node || !enabled) return;
    // 横向溢出（长公式、长链接）同样使容器成为滚动边界
    const next =
      node.scrollHeight > node.clientHeight ||
      node.scrollWidth > node.clientWidth;
    setHasOverflow(next);
  }, [node, enabled]);

  useEffect(() => {
    if (!node || !enabled) return;
    checkOverflow();
    // ResizeObserver 只感知观察节点自身盒子变化；flex-1 容器盒高固定时内容
    // 增长不触发——同时观察首个内容子节点（后代撑高会反映在其盒高上）。
    // jsdom 无 ResizeObserver，全局测试桩（test/setup.ts）可创建空实现。
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(checkOverflow);
    ro?.observe(node);
    const first = node.firstElementChild;
    if (first instanceof HTMLElement) ro?.observe(first);
    const mo = new MutationObserver(checkOverflow);
    mo.observe(node, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", checkOverflow);
    return () => {
      ro?.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", checkOverflow);
    };
  }, [node, checkOverflow, enabled]);

  return {
    /** 回调 ref：元素挂载/卸载都驱动首查与观察器接线 */
    ref: setNode,
    overscrollClass:
      enabled && hasOverflow ? "overscroll-contain" : "overscroll-auto",
    checkOverflow,
  } as const;
}
