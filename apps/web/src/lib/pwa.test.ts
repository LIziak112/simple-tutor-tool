import type { PublicConfigData } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPwaUpdater,
  maybeRegisterServiceWorker,
  registerServiceWorker,
} from "./pwa";
import type { PreparedPwaUpdate } from "./pwa-update-safety";

/**
 * SW 条件注册逻辑单测（T2.12 验收项「HTTP 不注册、HTTPS 才注册」的前端侧）：
 * 通过依赖注入隔离 navigator 与注册器；默认注册器（原生 API）单独测。
 * jsdom 默认无 navigator.serviceWorker——用 stubGlobal 模拟存在/缺失两种浏览器。
 */

/** 预置的 /api/public/config 返回值 */
function config(pwaEnabled: boolean): PublicConfigData {
  return {
    pwaEnabled,
    publicUrl: pwaEnabled
      ? "https://tutor.example.com"
      : "http://203.0.113.10:8787",
  };
}

beforeEach(() => {
  // 默认模拟「支持 SW 的浏览器」（Chrome/Safari 均如此）
  vi.stubGlobal("navigator", { serviceWorker: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("maybeRegisterServiceWorker", () => {
  it("pwaEnabled=true（https 部署）时调用注册器", async () => {
    const register = vi.fn(async () => {});
    const registered = await maybeRegisterServiceWorker(
      async () => config(true),
      register,
    );
    expect(registered).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("pwaEnabled=false（HTTP 部署，含公网 IP/localhost）时不注册", async () => {
    const register = vi.fn(async () => {});
    const registered = await maybeRegisterServiceWorker(
      async () => config(false),
      register,
    );
    expect(registered).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("配置接口不可达（服务端未启动/网络异常）时不注册、不抛错", async () => {
    const register = vi.fn(async () => {});
    const registered = await maybeRegisterServiceWorker(async () => {
      throw new Error("网络异常");
    }, register);
    expect(registered).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("配置返回 null 时同样不注册", async () => {
    const register = vi.fn(async () => {});
    const registered = await maybeRegisterServiceWorker(
      async () => null,
      register,
    );
    expect(registered).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("浏览器不支持 Service Worker 时直接跳过（不请求配置）", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", {});
    const fetchConfig = vi.fn(async () => config(true));
    const register = vi.fn(async () => {});
    const registered = await maybeRegisterServiceWorker(fetchConfig, register);
    expect(registered).toBe(false);
    expect(fetchConfig).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("注册器抛错时吞掉异常并返回 false（SW 不阻塞应用）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registered = await maybeRegisterServiceWorker(
      async () => config(true),
      async () => {
        throw new Error("注册失败");
      },
    );
    expect(registered).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("registerServiceWorker（默认注册器，原生 API）", () => {
  it("注册 /sw.js（scope=/）并主动触发一次更新检查", async () => {
    const update = vi.fn(async () => {});
    const register = vi.fn(async () =>
      Object.assign(new EventTarget(), {
        update,
        waiting: null,
        installing: null,
      }),
    );
    vi.stubGlobal("navigator", {
      serviceWorker: Object.assign(new EventTarget(), {
        register,
        controller: null,
      }),
    });
    await registerServiceWorker();
    expect(register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    expect(update).toHaveBeenCalledTimes(1);
  });
});

function worker(state: ServiceWorkerState = "installed") {
  return Object.assign(new EventTarget(), { state, postMessage: vi.fn() });
}
function fixture() {
  const previous = worker("activated");
  const next = worker();
  const registration = Object.assign(new EventTarget(), {
    active: previous as ReturnType<typeof worker> | null,
    waiting: next as ReturnType<typeof worker> | null,
    installing: null as ReturnType<typeof worker> | null,
    update: vi.fn(async () => {}),
  });
  const container = Object.assign(new EventTarget(), {
    controller: previous as ReturnType<typeof worker> | null,
  });
  const release = vi.fn();
  const assertReady = vi.fn();
  const prepare = vi.fn(
    async (_signal: AbortSignal): Promise<PreparedPwaUpdate> => ({
      release,
      assertReady,
    }),
  );
  const activate = vi.fn(async () => {
    container.controller = next;
    container.dispatchEvent(new Event("controllerchange"));
  });
  const reload = vi.fn();
  const updater = createPwaUpdater(registration, container, {
    prepare,
    activate,
    reload,
  });
  return {
    previous,
    next,
    registration,
    container,
    release,
    assertReady,
    prepare,
    activate,
    reload,
    updater,
  };
}

describe("安全版本更新", () => {
  it("已有等待版本立即提供提示，但不自动激活", () => {
    const f = fixture();
    expect(f.updater.getSnapshot().available).toBe(true);
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
    f.updater.dispose();
  });
  it("运行中安装新版本后提示，首次安装不提示或刷新", () => {
    const f = fixture();
    f.updater.dispose();
    f.registration.waiting = null;
    f.registration.installing = f.next;
    f.next.state = "installing";
    const updater = createPwaUpdater(f.registration, f.container, {
      prepare: f.prepare,
      activate: f.activate,
      reload: f.reload,
    });
    expect(updater.getSnapshot().available).toBe(false);
    f.registration.dispatchEvent(new Event("updatefound"));
    f.registration.waiting = f.next;
    f.next.state = "installed";
    f.next.dispatchEvent(new Event("statechange"));
    expect(updater.getSnapshot().available).toBe(true);
    updater.dispose();
    f.container.controller = null;
    f.registration.active = null;
    f.registration.waiting = null;
    const first = createPwaUpdater(f.registration, f.container, {
      prepare: f.prepare,
      activate: f.activate,
      reload: f.reload,
    });
    f.container.controller = f.next;
    f.container.dispatchEvent(new Event("controllerchange"));
    expect(first.getSnapshot().available).toBe(false);
    expect(f.reload).not.toHaveBeenCalled();
    first.dispose();
  });
  it("保存尚未完成时不激活，成功后才更新重载；重复点击只保存一次", async () => {
    const f = fixture();
    let finish:
      | ((value: { release: () => void; assertReady: () => void }) => void)
      | undefined;
    f.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const applying = f.updater.apply();
    const duplicate = f.updater.apply();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.activate).not.toHaveBeenCalled();
    finish?.({ release: f.release, assertReady: f.assertReady });
    await Promise.all([applying, duplicate]);
    expect(f.activate).toHaveBeenCalledTimes(1);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(f.assertReady).toHaveBeenCalled();
    f.updater.dispose();
  });

  it("未受控页面也能等待目标 worker 激活后安全重载", async () => {
    const f = fixture();
    f.updater.dispose();
    f.container.controller = null;
    f.activate.mockImplementation(async () => {
      f.next.state = "activated";
      f.registration.waiting = null;
      f.registration.active = f.next;
      f.next.dispatchEvent(new Event("statechange"));
    });
    const updater = createPwaUpdater(f.registration, f.container, {
      prepare: f.prepare,
      activate: f.activate,
      reload: f.reload,
    });
    await updater.apply();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.reload).toHaveBeenCalledTimes(1);
    updater.dispose();
  });

  it("其它标签被关闭后等待版本自然激活，未受控页面再次保存可重载", async () => {
    const f = fixture();
    f.updater.dispose();
    f.container.controller = null;
    f.activate.mockRejectedValue(new Error("请先保存并关闭其它 OwnClass 页面"));
    const updater = createPwaUpdater(f.registration, f.container, {
      prepare: f.prepare,
      activate: f.activate,
      reload: f.reload,
    });
    await updater.apply();
    expect(f.reload).not.toHaveBeenCalled();
    f.registration.waiting = null;
    f.registration.active = f.next;
    f.next.state = "activated";
    f.next.dispatchEvent(new Event("statechange"));
    expect(f.reload).not.toHaveBeenCalled();
    await updater.apply();
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.activate).toHaveBeenCalledTimes(1);
    expect(f.reload).toHaveBeenCalledTimes(1);
    updater.dispose();
  });

  it("未受控页面按旧 active worker 识别后续安装更新", () => {
    const f = fixture();
    f.updater.dispose();
    f.container.controller = null;
    f.registration.waiting = null;
    f.registration.installing = f.next;
    f.next.state = "installing";
    const updater = createPwaUpdater(f.registration, f.container, {
      prepare: f.prepare,
      activate: f.activate,
      reload: f.reload,
    });
    expect(updater.getSnapshot().available).toBe(false);
    f.next.state = "installed";
    f.registration.waiting = f.next;
    f.next.dispatchEvent(new Event("statechange"));
    expect(updater.getSnapshot().available).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
    updater.dispose();
  });
  it("保存失败不激活或刷新，并显示原原因以便重试", async () => {
    const f = fixture();
    f.prepare.mockRejectedValue(new Error("笔迹本机保存失败"));
    await f.updater.apply();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.updater.getSnapshot()).toMatchObject({
      busy: false,
      error: "笔迹本机保存失败",
    });
    f.updater.dispose();
  });
  it("其它页面触发接管时仍不自动刷新，用户保存后才重载", async () => {
    const f = fixture();
    f.container.controller = f.next;
    f.container.dispatchEvent(new Event("controllerchange"));
    expect(f.reload).not.toHaveBeenCalled();
    await f.updater.apply();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.reload).toHaveBeenCalledTimes(1);
    f.updater.dispose();
  });
  it("其它标签阻止激活时释放保存锁并保留当前页面", async () => {
    const f = fixture();
    f.activate.mockRejectedValue(new Error("请先保存并关闭其它 OwnClass 页面"));
    await f.updater.apply();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.updater.getSnapshot().error).toContain("其它 OwnClass 页面");
    f.updater.dispose();
  });

  it("长时间保存未响应时取消准备，不激活、不重载", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.prepare.mockImplementation(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new Error("保存超时，稿件保留")),
            );
          }),
      );
      const applying = f.updater.apply();
      await vi.advanceTimersByTimeAsync(30_000);
      await applying;
      expect(f.activate).not.toHaveBeenCalled();
      expect(f.reload).not.toHaveBeenCalled();
      expect(f.updater.getSnapshot()).toMatchObject({
        busy: false,
        error: "保存超时，稿件保留",
      });
    } finally {
      f.updater.dispose();
      vi.useRealTimers();
    }
  });

  it("保存和激活分别计时，保存已完成后不被旧的保存超时取消", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let cancelled = false;
    try {
      f.prepare.mockImplementation(
        (signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              cancelled = true;
            });
            setTimeout(
              () => resolve({ release: f.release, assertReady: f.assertReady }),
              25_000,
            );
          }),
      );
      f.assertReady.mockImplementation(() => {
        if (cancelled) throw new Error("准备已取消");
      });
      f.activate.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              f.container.controller = f.next;
              f.container.dispatchEvent(new Event("controllerchange"));
              resolve();
            }, 6_000);
          }),
      );
      const applying = f.updater.apply();
      await vi.advanceTimersByTimeAsync(31_000);
      await applying;
      expect(f.reload).toHaveBeenCalledTimes(1);
      expect(cancelled).toBe(false);
    } finally {
      f.updater.dispose();
      vi.useRealTimers();
    }
  });

  it("回到页面时重查版本，稍后的提示可重新发现", () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const f = fixture();
    f.updater.dismiss();
    expect(f.updater.getSnapshot().dismissed).toBe(true);
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event("focus"));
    expect(f.registration.update).toHaveBeenCalledTimes(1);
    expect(f.updater.getSnapshot().dismissed).toBe(false);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    expect(f.registration.update).toHaveBeenCalledTimes(1);
    f.updater.dispose();
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event("focus"));
    expect(f.registration.update).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
    vi.useRealTimers();
  });
});
