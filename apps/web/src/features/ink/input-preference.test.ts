import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSessionInputPreference,
  onSessionInputPreferenceChange,
  resetSessionInputPreference,
  setSessionInputPreference,
} from "./input-preference.ts";

/**
 * 会话级输入偏好（T6R.7，方案 §4.1）：模块级状态，多个画布共享、跨题/
 * 重挂载保持——不是 localStorage 设备级偏好（刷新回默认 pen），也不是
 * 身份数据。默认 pen（T6R.0 决策 4：新草稿缺省「笔写／手指滚动」）。
 */

describe("input-preference：会话共享偏好 store", () => {
  afterEach(() => {
    resetSessionInputPreference();
  });

  it("默认 pen（笔写／手指滚动）", () => {
    expect(getSessionInputPreference()).toBe("pen");
  });

  it("切换到 finger 后跨读取保持（跨题/重挂载不重新探测）", () => {
    setSessionInputPreference("finger");
    expect(getSessionInputPreference()).toBe("finger");
    expect(getSessionInputPreference()).toBe("finger");
  });

  it("订阅者在切换时收到新值；取消订阅后不再收到", () => {
    const cb = vi.fn();
    const off = onSessionInputPreferenceChange(cb);
    setSessionInputPreference("finger");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith("finger");
    off();
    setSessionInputPreference("pen");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("同值重复设置不通知（幂等）", () => {
    const cb = vi.fn();
    const off = onSessionInputPreferenceChange(cb);
    setSessionInputPreference("pen");
    expect(cb).not.toHaveBeenCalled();
    off();
  });

  it("reset 恢复默认并通知（测试隔离用）", () => {
    setSessionInputPreference("finger");
    const cb = vi.fn();
    const off = onSessionInputPreferenceChange(cb);
    resetSessionInputPreference();
    expect(getSessionInputPreference()).toBe("pen");
    expect(cb).toHaveBeenCalledWith("pen");
    off();
  });
});
