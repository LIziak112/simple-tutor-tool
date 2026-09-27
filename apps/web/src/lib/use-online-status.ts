import { useEffect, useState } from "react";

/**
 * 浏览器在线状态（T2.12 离线交互）：
 * 判定口径与 T2.9 的 use-draft-sync 完全一致——navigator.onLine 初值 +
 * window 的 online/offline 事件实时翻转。抽成共享 hook 供答题页
 * （离线时禁用交卷）等视图复用，不再各写一套监听。
 * 注意：onLine 只反映「连着网络设备」，不代表服务器可达；服务器可达性
 * 由草稿同步/TanStack Query 的失败路径表达（T2.9 顶栏三态）。
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}
