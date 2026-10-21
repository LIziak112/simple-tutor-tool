import { useCallback, useLayoutEffect, useState } from "react";

/**
 * 滚动容器溢出检测，按需挂载 overscroll-contain。
 *
 * 现代浏览器对声明了 overscroll-behavior: contain 的滚动容器，即使内容未
 * 溢出也拦截向祖先的链式滚动——悬停在内容很短的浮动滚动区上时滚轮会锁死
 * 外层页面。本 hook 在内容溢出（纵向或横向）时输出 overscroll-contain
 * （内部滚到边界不带动页面），未溢出时输出 overscroll-auto（滚轮透传页面）。
 *
 * 回调 ref 设计：目标元素可条件渲染（如 fixedActive && open 才出现的固定
 * 对照栏），元素挂载时自动接线观察器并首查，不依赖宿主首挂载时机；首查在
 * useLayoutEffect 中绘制前完成，避免重挂载首帧带上次会话的过期类名。
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

  useLayoutEffect(() => {
    if (!node || !enabled) return;
    checkOverflow();
    // ResizeObserver 只感知被观察节点的盒子变化；flex-1/max-h 容器盒被钳住
    // 时内容增长不触发——观察节点自身与全部直接子元素（后代撑高必然反映在
    // 某个直接子元素盒高上），并在 childList 变更后重新对账：占位 <p> ↔ 会
    // 话内容互换后旧目标已脱离 DOM，新子树必须接管，否则仅布局驱动的尺寸变
    // 化（字体/KaTeX 加载、类切换高度）永久失检。jsdom 无 ResizeObserver，
    // 全局测试桩（test/setup.ts）可创建空实现。
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(checkOverflow);
    const observedChildren = new Set<Element>();
    const syncObservedChildren = () => {
      if (!ro) return;
      for (const child of node.children) {
        if (!observedChildren.has(child)) {
          ro.observe(child);
          observedChildren.add(child);
        }
      }
      for (const child of observedChildren) {
        if (!child.isConnected) {
          ro.unobserve(child);
          observedChildren.delete(child);
        }
      }
    };
    if (ro) {
      ro.observe(node);
      syncObservedChildren();
    }
    const mo = new MutationObserver(() => {
      syncObservedChildren();
      checkOverflow();
    });
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
