/**
 * 开发调试：URL 带 ?debug=1 时加载 Eruda 页内控制台。
 * 背景：iPad Safari 无法从 Windows 远程调试，Eruda 是真机上的唯一控制台（§2.2）。
 *
 * - eruda 走 npm 本地安装 + 动态 import，绝不使用 CDN；
 * - 只在 import.meta.env.DEV 为真时执行：生产构建中该常量被替换为 false，
 *   整段分支连同动态 import 一起被摇树移除，eruda 不会进入生产产物。
 */
export async function setupEruda(): Promise<void> {
  if (!import.meta.env.DEV) return;
  if (new URLSearchParams(window.location.search).get("debug") !== "1") return;
  const eruda = (await import("eruda")).default;
  eruda.init();
}
