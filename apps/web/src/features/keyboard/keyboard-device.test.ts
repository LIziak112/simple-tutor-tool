import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isKeyboardDevice,
  resetKeyboardDeviceForTest,
  useKeyboardDevice,
} from "./keyboard-device";

/**
 * jsdom 的 matchMedia 恒不匹配（pointer: fine=false），本文件天然走懒探测
 * 分支；模块单例跨用例共享，每个用例前 reset 回未探测态。
 */
beforeEach(() => {
  resetKeyboardDeviceForTest();
});
afterEach(() => {
  resetKeyboardDeviceForTest();
});

/** 派发 keydown 到 body（window 捕获监听命中；可覆写实例属性模拟 IME 态） */
function pressKey(init: KeyboardEventInit & { keyCodeOverride?: number }) {
  const { keyCodeOverride, ...rest } = init;
  const event = new KeyboardEvent("keydown", { bubbles: true, ...rest });
  if (keyCodeOverride !== undefined) {
    Object.defineProperty(event, "keyCode", { value: keyCodeOverride });
  }
  document.body.dispatchEvent(event);
}

describe("键盘设备探测（懒探测分支）", () => {
  it("未探测时判定为非键盘设备", () => {
    expect(isKeyboardDevice()).toBe(false);
  });

  it("body 上首个合格 keydown 即判定键盘设备，且单向恒真", () => {
    pressKey({ key: "Escape" });
    expect(isKeyboardDevice()).toBe(true);
    pressKey({ key: "a", isComposing: true });
    expect(isKeyboardDevice()).toBe(true);
  });

  it("文本编辑区内按键不合格（软键盘/输入场景不误探测）", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    expect(isKeyboardDevice()).toBe(false);
    input.remove();
  });

  it("IME 合成（isComposing / keyCode 229）与 Unidentified 不合格", () => {
    pressKey({ key: "中", isComposing: true });
    expect(isKeyboardDevice()).toBe(false);
    pressKey({ key: "a", keyCodeOverride: 229 });
    expect(isKeyboardDevice()).toBe(false);
    pressKey({ key: "Unidentified" });
    expect(isKeyboardDevice()).toBe(false);
    pressKey({ key: "a" });
    expect(isKeyboardDevice()).toBe(true);
  });

  it("reset 后可重新探测（监听重新挂载）", () => {
    pressKey({ key: "Enter" });
    expect(isKeyboardDevice()).toBe(true);
    resetKeyboardDeviceForTest();
    expect(isKeyboardDevice()).toBe(false);
    pressKey({ key: "Enter" });
    expect(isKeyboardDevice()).toBe(true);
  });

  it("useKeyboardDevice 订阅探测成功（UI 随之出现）", () => {
    const { result } = renderHook(() => useKeyboardDevice());
    expect(result.current).toBe(false);
    act(() => {
      pressKey({ key: "j" });
    });
    expect(result.current).toBe(true);
  });
});
