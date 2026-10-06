import { act, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  effectiveNoteLayout,
  getNoteLayoutPreference,
  NOTE_LAYOUT_STORAGE_KEY,
  noteSideUsable,
  onNoteLayoutPreferenceChange,
  resetNoteLayoutForTest,
  setNoteLayoutPreference,
} from "./note-layout";

/**
 * 草稿层布局工具测试（T6R.9）：分栏阈值计算（纯函数）、设备偏好存储的
 * 防御式读写（localStorage 抛错/值损坏不白屏——任务清单失败测试之一）、
 * 偏好订阅与宽度观察 hook（jsdom 无 ResizeObserver 时的回退）。
 */

function freshModule(): Promise<typeof import("./note-layout")> {
  vi.resetModules();
  return import("./note-layout");
}

/** 把 window.localStorage 换成抛错实现（隐私模式/配额损坏形态），返回还原函数 */
function throwableLocalStorage(): () => void {
  const desc = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("Access to localStorage is denied");
    },
  });
  return () => {
    if (desc !== undefined) Object.defineProperty(window, "localStorage", desc);
    else delete (window as { localStorage?: unknown }).localStorage;
  };
}

afterEach(() => {
  resetNoteLayoutForTest();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("noteSideUsable：两列最低可用宽度阈值（暂定值，真机定标后修订）", () => {
  it("iPad 横屏题卡宽度（1024）两列均达标 → side", () => {
    expect(noteSideUsable(1024)).toBe(true);
  });

  it("iPad 竖屏宽度（768）纸列不足 400px → 不可 side", () => {
    expect(noteSideUsable(768)).toBe(false);
  });

  it("零宽/负宽（容器未布局）不判 side", () => {
    expect(noteSideUsable(0)).toBe(false);
    expect(noteSideUsable(-10)).toBe(false);
  });
});

describe("effectiveNoteLayout：偏好 × 容器宽度", () => {
  it("auto：宽容器 side、窄容器 below（窄容器从侧栏回退——任务清单失败测试）", () => {
    expect(effectiveNoteLayout("auto", 1024)).toBe("side");
    expect(effectiveNoteLayout("auto", 768)).toBe("below");
  });

  it("below：显式偏好恒 below", () => {
    expect(effectiveNoteLayout("below", 1400)).toBe("below");
  });

  it("side：显式偏好恒 side（用户强制分栏，窄屏自担）", () => {
    expect(effectiveNoteLayout("side", 500)).toBe("side");
  });
});

describe("设备偏好存储（防御式）", () => {
  it("默认 auto；set 持久化到 localStorage 且可读回", () => {
    expect(getNoteLayoutPreference()).toBe("auto");
    act(() => {
      setNoteLayoutPreference("below");
    });
    expect(getNoteLayoutPreference()).toBe("below");
    expect(window.localStorage.getItem(NOTE_LAYOUT_STORAGE_KEY)).toBe("below");
  });

  it("损坏值回退 auto（不抛错）", async () => {
    window.localStorage.setItem(NOTE_LAYOUT_STORAGE_KEY, "garbage");
    const mod = await freshModule();
    expect(mod.getNoteLayoutPreference()).toBe("auto");
  });

  it("localStorage 抛错不白屏：读取回退 auto、写入静默保留内存值（任务清单失败测试）", async () => {
    const restore = throwableLocalStorage();
    try {
      const mod = await freshModule();
      expect(mod.getNoteLayoutPreference()).toBe("auto");
      expect(() => mod.setNoteLayoutPreference("side")).not.toThrow();
      expect(mod.getNoteLayoutPreference()).toBe("side");
    } finally {
      restore();
    }
  });

  it("订阅通知：变化通知订阅者，同值不通知", () => {
    const cb = vi.fn();
    const off = onNoteLayoutPreferenceChange(cb);
    act(() => {
      setNoteLayoutPreference("side");
    });
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => {
      setNoteLayoutPreference("side");
    });
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    act(() => {
      setNoteLayoutPreference("auto");
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("useObservedCssWidth：宽度观察（ResizeObserver 缺席回退）", () => {
  it("jsdom 无 ResizeObserver：挂载回退 offsetWidth 读数（0），不抛错", async () => {
    const mod = await freshModule();
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    function Probe() {
      const width = mod.useObservedCssWidth(ref);
      return <div data-testid="probe">{width}</div>;
    }
    render(
      <Probe />,
      // 换新 document 保证 offsetWidth 初始 0 的读数稳定
    );
    expect(screen.getByTestId("probe").textContent).toBe("0");
  });

  it("ResizeObserver 存在：观察容器并在回调时更新宽度（侧栏→below 回退的驱动源）", async () => {
    type Cb = (entries: { contentRect: { width: number } }[]) => void;
    const observers: { cb: Cb }[] = [];
    class StubRO {
      constructor(cb: Cb) {
        observers.push({ cb });
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", StubRO);
    const mod = await freshModule();
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    function Probe() {
      const width = mod.useObservedCssWidth(ref);
      return <div ref={ref} data-testid="probe">{width}</div>;
    }
    render(<Probe />);
    expect(observers.length).toBe(1);
    act(() => {
      observers[0]?.cb([{ contentRect: { width: 1024 } }]);
    });
    expect(screen.getByTestId("probe").textContent).toBe("1024");
    act(() => {
      observers[0]?.cb([{ contentRect: { width: 700 } }]);
    });
    expect(screen.getByTestId("probe").textContent).toBe("700");
  });
});
