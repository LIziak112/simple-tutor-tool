import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
