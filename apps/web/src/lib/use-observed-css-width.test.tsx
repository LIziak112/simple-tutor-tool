import { act, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
