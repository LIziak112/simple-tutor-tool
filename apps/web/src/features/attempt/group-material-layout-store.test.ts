import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetGroupMaterialLayoutStoreForTest,
  bindGroupMaterialLayoutAccount,
  getGroupMaterialLayout,
  setGroupMaterialLayout,
} from "./group-material-layout-store";

const keyOf = (id: string) =>
  `ownclass:group-material-layout:${JSON.stringify([location.origin, "student", id])}`;

describe("group-material-layout-store", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetGroupMaterialLayoutStoreForTest();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("默认 split；按账号隔离持久化与读取", () => {
    bindGroupMaterialLayoutAccount("s-1");
    expect(getGroupMaterialLayout()).toBe("split");

    setGroupMaterialLayout("stack");
    expect(localStorage.getItem(keyOf("s-1"))).toBe("stack");
    expect(getGroupMaterialLayout()).toBe("stack");

    // 公用设备换账号：不继承上一账号的偏好
    bindGroupMaterialLayoutAccount("s-2");
    expect(getGroupMaterialLayout()).toBe("split");

    // 各账号各自持久化，离线写入后（重）绑定读到自己的值
    localStorage.setItem(keyOf("s-2"), "stack");
    bindGroupMaterialLayoutAccount("s-1");
    bindGroupMaterialLayoutAccount("s-2");
    expect(getGroupMaterialLayout()).toBe("stack");
    bindGroupMaterialLayoutAccount("s-1");
    expect(getGroupMaterialLayout()).toBe("stack");
  });

  it("未绑定账号时切换仅在会话内生效，不落盘", () => {
    setGroupMaterialLayout("stack");
    expect(getGroupMaterialLayout()).toBe("stack");
    expect(localStorage.length).toBe(0);
  });

  it("跨窗口 storage 事件只同步当前账号的键", () => {
    bindGroupMaterialLayoutAccount("s-1");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: keyOf("s-1"),
        newValue: "stack",
        storageArea: localStorage,
      }),
    );
    expect(getGroupMaterialLayout()).toBe("stack");

    // 其他账号的键变化不影响当前账号
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: keyOf("s-other"),
        newValue: "stack",
        storageArea: localStorage,
      }),
    );
    expect(getGroupMaterialLayout()).toBe("stack");

    // 清空存储（key=null）回默认
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: null,
        newValue: null,
        storageArea: localStorage,
      }),
    );
    expect(getGroupMaterialLayout()).toBe("split");
  });
});
