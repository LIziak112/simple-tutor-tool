import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDynamicOverscroll } from "./use-dynamic-overscroll";

/** jsdom 无布局：手工定义元素读数来模拟溢出状态 */
function makeElement(
  scrollHeight: number,
  clientHeight: number,
): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  return el;
}

describe("useDynamicOverscroll", () => {
  it("未溢出输出 overscroll-auto，溢出后切换 overscroll-contain，回落再恢复", () => {
    const { result } = renderHook(() => useDynamicOverscroll<HTMLElement>());
    expect(result.current.overscrollClass).toBe("overscroll-auto");

    const el = makeElement(300, 500);
    act(() => {
      result.current.ref(el);
    });
    expect(result.current.overscrollClass).toBe("overscroll-auto");

    Object.defineProperty(el, "scrollHeight", {
      value: 800,
      configurable: true,
    });
    act(() => {
      result.current.checkOverflow();
    });
    expect(result.current.overscrollClass).toBe("overscroll-contain");

    Object.defineProperty(el, "scrollHeight", {
      value: 100,
      configurable: true,
    });
    act(() => {
      result.current.checkOverflow();
    });
    expect(result.current.overscrollClass).toBe("overscroll-auto");
  });

  it("回调 ref 在元素挂载时立即检查（条件渲染后挂载也生效）", () => {
    const { result } = renderHook(() => useDynamicOverscroll<HTMLElement>());
    // 宿主先渲染、元素后出现（对应 fixedActive && open 的固定对照栏条件挂载）
    const el = makeElement(800, 300);
    act(() => {
      result.current.ref(el);
    });
    expect(result.current.overscrollClass).toBe("overscroll-contain");
  });

  it("水平溢出（长公式/长链接）同样视为滚动边界", () => {
    const { result } = renderHook(() => useDynamicOverscroll<HTMLElement>());
    const el = makeElement(100, 500);
    Object.defineProperty(el, "scrollWidth", {
      value: 900,
      configurable: true,
    });
    Object.defineProperty(el, "clientWidth", {
      value: 300,
      configurable: true,
    });
    act(() => {
      result.current.ref(el);
    });
    expect(result.current.overscrollClass).toBe("overscroll-contain");
  });

  it("元素卸载（ref 置 null）不抛错，检查变为无操作", () => {
    const { result } = renderHook(() => useDynamicOverscroll<HTMLElement>());
    const el = makeElement(800, 300);
    act(() => {
      result.current.ref(el);
    });
    act(() => {
      result.current.ref(null);
    });
    expect(result.current.overscrollClass).toBe("overscroll-contain");
    expect(() => {
      act(() => {
        result.current.checkOverflow();
      });
    }).not.toThrow();
  });

  it("enabled=false 时无操作：溢出也不翻转（布局模式无滚动类名消费）", () => {
    const { result } = renderHook(() =>
      useDynamicOverscroll<HTMLElement>({ enabled: false }),
    );
    const el = makeElement(800, 300);
    act(() => {
      result.current.ref(el);
    });
    expect(result.current.overscrollClass).toBe("overscroll-auto");
    act(() => {
      result.current.checkOverflow();
    });
    expect(result.current.overscrollClass).toBe("overscroll-auto");
  });

  it("首子元素被替换后重新对账 RO 观察目标（占位 ↔ 内容互换不丢检测）", async () => {
    const observed = new Set<Element>();
    class RecordingRO {
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    }
    vi.stubGlobal("ResizeObserver", RecordingRO);
    const { result } = renderHook(() => useDynamicOverscroll<HTMLElement>());
    const el = makeElement(300, 500);
    // 对账按 isConnected 清理脱离文档的目标：容器须真实挂载（同生产）
    document.body.appendChild(el);
    const placeholder = document.createElement("p");
    el.appendChild(placeholder);
    act(() => {
      result.current.ref(el);
    });
    expect(observed.has(el)).toBe(true);
    expect(observed.has(placeholder)).toBe(true);

    // 占位被会话内容根节点替换（真实路径：conversation ?? <p>占位）
    const content = document.createElement("div");
    act(() => {
      el.replaceChildren(content);
    });
    // MutationObserver 回调经微任务送达，等对账跑完
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    try {
      expect(observed.has(placeholder)).toBe(false);
      expect(observed.has(content)).toBe(true);
    } finally {
      el.remove();
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
