import type { PublicConfigData } from "@tutor/contract";
import { type PreparedPwaUpdate, preparePwaUpdate } from "./pwa-update-safety";

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
 * 发现新版本后提示，先确认稿件保存，再请求安全激活。
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

interface UpdateWorker extends EventTarget {
  state: ServiceWorkerState;
  postMessage(message: unknown, transfer: Transferable[]): void;
}
interface UpdateRegistration extends EventTarget {
  active?: UpdateWorker | null;
  waiting: UpdateWorker | null;
  installing: UpdateWorker | null;
  update(): Promise<unknown>;
}
interface UpdateContainer extends EventTarget {
  controller: UpdateWorker | null;
}
export interface PwaUpdateSnapshot {
  available: boolean;
  busy: boolean;
  dismissed: boolean;
  error: string | null;
}
const initialSnapshot: PwaUpdateSnapshot = {
  available: false,
  busy: false,
  dismissed: false,
  error: null,
};

/** 保稿凭据只在当前页面仍被冻结且会话未变时有效。 */
export function createPwaUpdater(
  registration: UpdateRegistration,
  container: UpdateContainer,
  options: {
    prepare(signal: AbortSignal): Promise<PreparedPwaUpdate>;
    activate(worker: UpdateWorker): Promise<void>;
    reload(): void;
  },
) {
  let snapshot = { ...initialSnapshot };
  const listeners = new Set<() => void>();
  const publish = (change: Partial<PwaUpdateSnapshot>) => {
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  };
  let previousController = container.controller;
  let controllerChanged = false;
  let offeredWorker: UpdateWorker | null = null;
  let offeredActivated = false;
  let changed: (() => void) | undefined;
  let disposed = false;
  let running: Promise<void> | null = null;
  let prepared: PreparedPwaUpdate | null = null;
  let preparation: AbortController | null = null;
  const watched = new Map<UpdateWorker, () => void>();
  const offer = () => publish({ available: true, dismissed: false });
  const watchWorker = (worker: UpdateWorker | null, isUpdate: boolean) => {
    if (!worker || watched.has(worker)) return;
    if (isUpdate && offeredWorker !== worker) {
      offeredWorker = worker;
      offeredActivated = worker.state === "activated";
    }
    const check = () => {
      if (isUpdate && worker.state === "installed") {
        if (offeredWorker !== worker) {
          offeredWorker = worker;
          offeredActivated = false;
        }
        offer();
      }
      if (offeredWorker === worker && worker.state === "activated") {
        offeredActivated = true;
        offer();
        changed?.();
      }
    };
    watched.set(worker, check);
    worker.addEventListener("statechange", check);
    check();
  };
  const watchInstalling = () => {
    const worker = registration.installing;
    watchWorker(
      worker,
      !!container.controller ||
        (!!registration.active && registration.active !== worker),
    );
  };
  const onControllerChange = () => {
    if (!container.controller || container.controller === previousController)
      return;
    if (previousController === null) {
      previousController = container.controller;
      return;
    }
    controllerChanged = true;
    offer();
    changed?.();
  };
  registration.addEventListener("updatefound", watchInstalling);
  container.addEventListener("controllerchange", onControllerChange);
  if (registration.waiting) watchWorker(registration.waiting, true);
  watchInstalling();
  let lastUpdateCheck = Date.now();
  const checkForUpdate = () => {
    if (!navigator.onLine || document.visibilityState === "hidden") return;
    if (registration.waiting && !snapshot.busy) {
      watchWorker(registration.waiting, true);
      offer();
    }
    if (Date.now() - lastUpdateCheck < 60_000) return;
    lastUpdateCheck = Date.now();
    void registration.update().catch(() => {});
  };
  window.addEventListener("focus", checkForUpdate);
  window.addEventListener("online", checkForUpdate);
  document.addEventListener("visibilitychange", checkForUpdate);

  const apply = (): Promise<void> => {
    if (running) return running;
    if (disposed || snapshot.busy) return Promise.resolve();
    publish({ busy: true, error: null, dismissed: false });
    running = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      preparation = new AbortController();
      const saveTimeout = setTimeout(() => preparation?.abort(), 30_000);
      try {
        prepared = await options.prepare(preparation.signal);
        clearTimeout(saveTimeout);
        if (disposed) throw new Error("当前页面已关闭，更新已取消");
        prepared.assertReady();
        if (!controllerChanged && !offeredActivated) {
          const worker = registration.waiting;
          if (!worker) throw new Error("新版本尚未准备完成，请稍后重试");
          const activated = new Promise<void>((resolve, reject) => {
            changed = resolve;
            timer = setTimeout(
              () => reject(new Error("更新未完成，请保持页面打开并重试")),
              15_000,
            );
          });
          await options.activate(worker);
          if (!controllerChanged && !offeredActivated) await activated;
        }
        prepared.assertReady();
        options.reload();
      } catch (error) {
        prepared?.release();
        prepared = null;
        publish({
          busy: false,
          error:
            error instanceof Error
              ? error.message
              : "更新失败，稿件仍保留在当前页面",
        });
      } finally {
        clearTimeout(saveTimeout);
        clearTimeout(timer);
        changed = undefined;
        running = null;
      }
    })();
    return running;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    apply,
    dismiss() {
      if (!snapshot.busy) publish({ dismissed: true });
    },
    dispose() {
      disposed = true;
      preparation?.abort();
      prepared?.release();
      registration.removeEventListener("updatefound", watchInstalling);
      container.removeEventListener("controllerchange", onControllerChange);
      window.removeEventListener("focus", checkForUpdate);
      window.removeEventListener("online", checkForUpdate);
      document.removeEventListener("visibilitychange", checkForUpdate);
      for (const [worker, check] of watched)
        worker.removeEventListener("statechange", check);
      listeners.clear();
    },
  };
}

/** waiting worker 必须核实只有当前窗口，才允许替换旧版。 */
export function requestPwaActivation(worker: UpdateWorker): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const requestId = crypto.randomUUID();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("版本切换未响应，请稍后重试；稿件仍保留")),
      10_000,
    );
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (
        !value ||
        typeof value !== "object" ||
        !("requestId" in value) ||
        value.requestId !== requestId
      )
        return;
      if ("ok" in value && value.ok === true) finish();
      else
        finish(
          new Error(
            "reason" in value && typeof value.reason === "string"
              ? value.reason
              : "更新未获准，请保持页面打开",
          ),
        );
    };
    try {
      worker.postMessage({ type: "OWNCLASS_ACTIVATE_UPDATE", requestId }, [
        channel.port2,
      ]);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("无法请求版本切换"));
    }
  });
}

let updater: ReturnType<typeof createPwaUpdater> | null = null;
const updateListeners = new Set<() => void>();
export const getPwaUpdateSnapshot = () =>
  updater?.getSnapshot() ?? initialSnapshot;
export const subscribePwaUpdate = (listener: () => void) => {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
};
export const applyPwaUpdate = () => updater?.apply() ?? Promise.resolve();
export const dismissPwaUpdate = () => updater?.dismiss();

/** 注册与更新检查不打断使用；新控制器接管也必须等待用户触发保稿。 */
export async function registerServiceWorker(): Promise<void> {
  const container = navigator.serviceWorker;
  const registration = await container.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  });
  updater?.dispose();
  updater = createPwaUpdater(registration, container, {
    prepare: preparePwaUpdate,
    activate: requestPwaActivation,
    reload: () => window.location.reload(),
  });
  updater.subscribe(() => {
    for (const listener of updateListeners) listener();
  });
  for (const listener of updateListeners) listener();
  void registration.update().catch(() => {});
}
