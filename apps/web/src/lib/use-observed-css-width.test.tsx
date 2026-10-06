import { act, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useObservedCssWidth } from "./use-observed-css-width";

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
