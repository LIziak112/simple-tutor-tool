import { useSyncExternalStore } from "react";

/**
 * 桌面断点（lg: 1024px）的 matchMedia 订阅 hook（2026-10 四角清理收口
 * 单源）：讲义阅读页与讲练页原先各持一份三件套（query 常量/订阅/快照 +
 * useSyncExternalStore），收归于此。jsdom 等环境由测试对 matchMedia 打桩
 * （两页测试均已 stub）。
 */

const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribeDesktop(onChange: () => void): () => void {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getDesktopSnapshot(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/** 是否桌面视口（lg: 断点；SSR/首帧快照 false） */
export function useDesktopViewport(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    getDesktopSnapshot,
    () => false,
  );
}
