import type { PublicConfigData } from "@tutor/contract";

/**
 * Service Worker 条件注册（T2.12，架构 §5.10）：
 * 纯 HTTP（公网 IP 部署、备案前）不注册 SW、功能完整；只有服务端
 * /api/public/config 判定 pwaEnabled（PUBLIC_URL 为 https）时才注册。
 * 前端不自行猜测协议（location.protocol 不可信：反代/内网穿透下会误判），
 * 一律以服务端配置为准。
 *
 * 注册实现说明：不使用 vite-plugin-pwa 的 virtual:pwa-register 胶水层
 * （其内部 import workbox-window——插件是 devDependency，pnpm 严格布局下
 * rolldown 无法从应用代码解析，会直接构建失败；AGENTS.md 也禁止为此新增
 * 直接依赖）。改用浏览器原生 navigator.serviceWorker.register，行为等价：
 * sw.js 由插件在构建期生成（generateSW，自带 workbox 运行时，无 CDN），
 * 注册 + autoUpdate（新版本激活接管时刷新一次页面）。
 */

/**
 * 条件注册入口。流程：浏览器不支持 SW → 跳过；取配置失败 → 跳过（HTTP 环境
 * 的正常路径，也可能有极短暂的服务端未启动窗口）；pwaEnabled=false → 跳过；
 * 否则注册 /sw.js。任何一步失败都不抛出——SW 是增强能力，绝不阻塞应用启动。
 * 通过依赖注入（fetchConfig/register 参数）保持可单测。
 * @returns 是否实际发起了注册（pwaEnabled 且浏览器支持）
 */
export async function maybeRegisterServiceWorker(
  fetchConfig: () => Promise<PublicConfigData | null>,
  register: () => Promise<void>,
): Promise<boolean> {
  // 浏览器不支持 SW（jsdom、旧浏览器）或非安全上下文：直接跳过
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }
  let config: PublicConfigData | null = null;
  try {
    config = await fetchConfig();
  } catch {
    // 服务端不可达：无法证明是 https 部署，保守跳过
    return false;
  }
  if (config === null || !config.pwaEnabled) {
    return false;
  }
  try {
    await register();
    return true;
  } catch (err) {
    // 注册失败（如老 SW 残留/作用域冲突）：记录但不当错误打断用户
    console.warn("Service Worker 注册失败（不影响在线使用）", err);
    return false;
  }
}

/**
 * 默认注册器：原生 API 注册构建期生成的 /sw.js（scope=/）。
 * autoUpdate 语义：页面已被旧 SW 控制时，新版本激活接管（controllerchange）
 * 刷新一次页面拿到新版本；首次安装（页面无 controller）不刷新，避免装完
 * 立刻 reload 打断用户。注册后主动 update() 一次，导航间隔短也能及时升级。
 */
export function registerServiceWorker(): Promise<void> {
  const container = navigator.serviceWorker;
  return container.register("/sw.js", { scope: "/" }).then((registration) => {
    if (container.controller !== null) {
      let reloaded = false;
      container.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    }
    void registration.update().catch(() => {
      // 更新检查失败不致命：浏览器在后续导航还会自动检查
    });
  });
}
