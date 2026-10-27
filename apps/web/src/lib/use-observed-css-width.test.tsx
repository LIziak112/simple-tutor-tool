import { act, render, screen } from "@testing-library/react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeResizeObserverStub } from "@/features/notes/note-test-utils";
import {
  useObservedCssValue,
  useObservedCssWidth,
} from "./use-observed-css-width";

/** 宽度观察原语测试（自 note-layout.test 上移 lib，T6R.9 复审⑩） */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useObservedCssWidth", () => {
  it("jsdom 无 ResizeObserver：挂载回退 offsetWidth 读数（0），不抛错", () => {
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    function Probe() {
      const width = useObservedCssWidth(ref);
      return <div data-testid="probe">{width}</div>;
    }
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("0");
  });

  it("ResizeObserver 存在：观察容器并在回调时更新宽度", () => {
    const stub = makeResizeObserverStub();
    vi.stubGlobal("ResizeObserver", stub.cls);
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    function Probe() {
      const width = useObservedCssWidth(ref);
      return (
        <div ref={ref} data-testid="probe">
          {width}
        </div>
      );
    }
    render(<Probe />);
    act(() => stub.push(1024));
    expect(screen.getByTestId("probe").textContent).toBe("1024");
    act(() => stub.push(700));
    expect(screen.getByTestId("probe").textContent).toBe("700");
  });
});

describe("useObservedCssValue（投影与量化）", () => {
  it("project 结论翻转才更新；enabled=false 不观察", () => {
    const stub = makeResizeObserverStub();
    vi.stubGlobal("ResizeObserver", stub.cls);
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    let enabled = true;
    function Probe() {
      const usable = useObservedCssValue(ref, (w) => w >= 900, { enabled });
      return (
        <div ref={ref} data-testid="v">
          {String(usable)}
        </div>
      );
    }
    const { rerender } = render(<Probe />);
    act(() => stub.push(1000));
    expect(screen.getByTestId("v").textContent).toBe("true");
    act(() => stub.push(1100)); // 同侧：值不变
    expect(screen.getByTestId("v").textContent).toBe("true");
    act(() => stub.push(500)); // 翻回
    expect(screen.getByTestId("v").textContent).toBe("false");
    enabled = false;
    rerender(<Probe />); // 观察停用（effect 清理）
    act(() => stub.push(2000));
    expect(screen.getByTestId("v").textContent).toBe("false");
  });
});

describe("useObservedCssValue：ref 晚挂重试（弹层延后提交）", () => {
  /**
   * 弹层（Portal）内容可比宿主组件晚一拍提交：ref 首帧为空时逐帧重试、
   * 挂上即观察——此前空 ref 静默早退会让观察永不建立（订正工作台实测：
   * Dialog 内首帧挂 ref，宽度观察恒停初始值）。
   */

  /** observe() 即刻按元素 offsetWidth 回调一次的可控桩（宽度经 offsetWidth 桩驱动） */
  class FiringResizeObserver {
    static readonly instances: FiringResizeObserver[] = [];
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      FiringResizeObserver.instances.push(this);
    }
    observe(target: Element): void {
      this.callback(
        [
          {
            target,
            contentRect: { width: (target as HTMLElement).offsetWidth },
          },
        ] as unknown as ResizeObserverEntry[],
        this as unknown as ResizeObserver,
      );
    }
    disconnect(): void {}
    unobserve(): void {}
  }

  beforeEach(() => {
    FiringResizeObserver.instances.length = 0;
  });

  /** 宿主先挂、被观察 div 在下一拍才渲染（模拟 Portal 延后提交） */
  function DeferredProbe() {
    const ref = useRef<HTMLDivElement>(null);
    const [attached, setAttached] = useState(false);
    const wide = useObservedCssValue(ref, (w) => w > 0, {});
    useEffect(() => {
      const t = setTimeout(() => setAttached(true), 0);
      return () => clearTimeout(t);
    }, []);
    return (
      <>
        <p data-testid="probe">{String(wide)}</p>
        {attached && <div ref={ref} data-testid="target" />}
      </>
    );
  }

  it("ref 首帧为空 → 逐帧重试,挂上后观察读数生效", async () => {
    vi.stubGlobal("ResizeObserver", FiringResizeObserver);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(640);
    render(<DeferredProbe />);
    expect(screen.getByTestId("probe").textContent).toBe("false"); // 初始投影(0)
    await vi.waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toBe("true"); // 挂上后读数
    });
    // 观察器建立在元素上（不是空引用早退后从未建立）
    expect(FiringResizeObserver.instances.length).toBeGreaterThanOrEqual(1);
  });

  it("ref 一直不挂：重试静默终止于卸载（不抛错、值停初始投影、不建观察器）", () => {
    vi.stubGlobal("ResizeObserver", FiringResizeObserver);
    function NeverProbe() {
      const ref = useRef<HTMLDivElement>(null);
      const wide = useObservedCssValue(ref, (w) => w > 0, {});
      return <p data-testid="probe">{String(wide)}</p>;
    }
    expect(() => render(<NeverProbe />)).not.toThrow();
    expect(screen.getByTestId("probe").textContent).toBe("false");
    expect(FiringResizeObserver.instances).toHaveLength(0);
  });
});
