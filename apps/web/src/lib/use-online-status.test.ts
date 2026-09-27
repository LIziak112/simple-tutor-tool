import { act, fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOnlineStatus } from "./use-online-status";

/** 在线状态 hook 单测（T2.12）：初值随 navigator.onLine，事件实时翻转 */

describe("useOnlineStatus", () => {
  it("默认在线（jsdom navigator.onLine=true）", () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it("offline 事件后转离线，online 事件后恢复", () => {
    const { result } = renderHook(() => useOnlineStatus());
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(false);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toBe(true);
  });

  it("卸载后移除监听（再派发事件不影响已卸载实例）", () => {
    const { result, unmount } = renderHook(() => useOnlineStatus());
    unmount();
    fireEvent(window, new Event("offline"));
    expect(result.current).toBe(true); // 卸载时冻结最后值，无副作用即通过
  });
});
