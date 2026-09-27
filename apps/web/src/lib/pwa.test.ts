import type { PublicConfigData } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeRegisterServiceWorker, registerServiceWorker } from "./pwa";

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
    const register = vi.fn(async () => ({ update }));
    vi.stubGlobal("navigator", {
      serviceWorker: { register, controller: null, addEventListener: vi.fn() },
    });
    await registerServiceWorker();
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("页面已被旧 SW 控制时，新版本接管（controllerchange）刷新一次", async () => {
    const listeners = new Map<string, () => void>();
    const reload = vi.fn();
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn(async () => ({ update: vi.fn(async () => {}) })),
        controller: {}, // 页面已被旧 SW 控制
        addEventListener: (name: string, fn: () => void) =>
          listeners.set(name, fn),
      },
    });
    vi.stubGlobal("window", { location: { reload } });
    await registerServiceWorker();
    const onControllerChange = listeners.get("controllerchange");
    expect(onControllerChange).toBeDefined();
    onControllerChange?.();
    onControllerChange?.(); // 第二次不重复刷新
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
