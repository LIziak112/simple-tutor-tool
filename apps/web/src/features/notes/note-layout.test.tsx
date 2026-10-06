import { act, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  effectiveNoteLayout,
  getNoteLayoutPreference,
  NOTE_LAYOUT_GAP_CSS_PX,
  NOTE_LAYOUT_STORAGE_KEY,
  NOTE_MIN_PAPER_CSS_PX,
  NOTE_MIN_QUESTION_CSS_PX,
  NOTE_PAPER_SHARE,
  NOTE_QUESTION_COLUMN_STYLE,
  NOTE_QUESTION_SHARE,
  noteSideUsable,
  onNoteLayoutPreferenceChange,
  resetNoteLayoutForTest,
  setNoteLayoutPreference,
  useNoteLayoutPreference,
  useNoteSideUsable,
} from "./note-layout";

/**
 * 草稿层布局工具测试（T6R.9）：分栏阈值计算（纯函数，量化布尔口径）、
 * 设备偏好存储的防御式读写（localStorage 抛错/值损坏不白屏——任务清单
 * 失败测试之一）、偏好订阅、量化分栏观察 hook（复审④）、渲染常量与阈值的
 * 配对锁定（复审⑨）。宽度观察原语（useObservedCssWidth）测试在
 * lib/use-observed-css-width.test。
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

  it("阈值与常量配对锁定（复审⑨）：翻转点=常量反解，改值只改一处", () => {
    const halfGap = NOTE_LAYOUT_GAP_CSS_PX / 2;
    const byPaper = (NOTE_MIN_PAPER_CSS_PX + halfGap) / NOTE_PAPER_SHARE;
    const byQuestion =
      (NOTE_MIN_QUESTION_CSS_PX + halfGap) / NOTE_QUESTION_SHARE;
    const threshold = Math.ceil(Math.max(byPaper, byQuestion));
    expect(noteSideUsable(threshold - 1)).toBe(false);
    expect(noteSideUsable(threshold)).toBe(true);
  });
});

describe("effectiveNoteLayout：偏好 × 量化布尔（复审④）", () => {
  it("auto：宽容器（usable）side、窄容器 below（窄容器从侧栏回退——任务清单失败测试）", () => {
    expect(effectiveNoteLayout("auto", true)).toBe("side");
    expect(effectiveNoteLayout("auto", false)).toBe("below");
  });

  it("below：显式偏好恒 below", () => {
    expect(effectiveNoteLayout("below", true)).toBe("below");
  });

  it("side：显式偏好恒 side（用户强制分栏，窄屏自担）", () => {
    expect(effectiveNoteLayout("side", false)).toBe("side");
  });
});

describe("渲染常量（复审⑨：阈值与渲染同源）", () => {
  it("题干列宽由占比常量派生", () => {
    expect(NOTE_QUESTION_COLUMN_STYLE.width).toBe(
      `${NOTE_QUESTION_SHARE * 100}%`,
    );
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

  it("useNoteLayoutPreference 经 useSyncExternalStore 订阅（切换即时同步）", () => {
    function Probe() {
      const pref = useNoteLayoutPreference();
      return <p data-testid="pref">{pref}</p>;
    }
    render(<Probe />);
    expect(screen.getByTestId("pref").textContent).toBe("auto");
    act(() => {
      setNoteLayoutPreference("side");
    });
    expect(screen.getByTestId("pref").textContent).toBe("side");
  });
});

describe("useNoteSideUsable：量化分栏观察（复审④）", () => {
  function probeHook(enabled: boolean) {
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    const observers: ((w: number) => void)[] = [];
    class StubRO {
      constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
        observers.push((width: number) => cb([{ contentRect: { width } }]));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", StubRO);
    function Probe() {
      const usable = useNoteSideUsable(ref, enabled);
      return (
        <div ref={ref} data-testid="usable">
          {String(usable)}
        </div>
      );
    }
    render(<Probe />);
    return {
      push: (w: number) =>
        act(() => {
          for (const cb of [...observers]) cb(w);
        }),
    };
  }

  it("跨阈值翻转才更新（同侧宽度连续变化不重渲染）", () => {
    const probe = probeHook(true);
    expect(screen.getByTestId("usable").textContent).toBe("false");
    probe.push(700); // below 侧内的变化（初始即 false）
    expect(screen.getByTestId("usable").textContent).toBe("false");
    probe.push(1024); // 跨阈值 → true
    expect(screen.getByTestId("usable").textContent).toBe("true");
    probe.push(1100); // side 侧内的变化
    expect(screen.getByTestId("usable").textContent).toBe("true");
    probe.push(700); // 回落 → false（窄容器从侧栏回退 below）
    expect(screen.getByTestId("usable").textContent).toBe("false");
  });

  it("enabled=false（显式偏好）不订阅观察", () => {
    const probe = probeHook(false);
    probe.push(1024);
    expect(screen.getByTestId("usable").textContent).toBe("false");
  });
});
