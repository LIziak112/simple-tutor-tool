import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getGroupMaterialLayout,
  setGroupMaterialLayout,
} from "./group-material-layout-store";

describe("group-material-layout-store", () => {
  beforeEach(() => {
    localStorage.clear();
    setGroupMaterialLayout("split");
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("默认采用 split（左右分栏）", () => {
    expect(getGroupMaterialLayout()).toBe("split");
  });

  it("支持切换为 stack（列表形式）并持久化到 localStorage", () => {
    setGroupMaterialLayout("stack");
    expect(getGroupMaterialLayout()).toBe("stack");
    expect(localStorage.getItem("ownclass:group-material-layout")).toBe(
      "stack",
    );

    setGroupMaterialLayout("split");
    expect(getGroupMaterialLayout()).toBe("split");
    expect(localStorage.getItem("ownclass:group-material-layout")).toBe(
      "split",
    );
  });

  it("响应跨窗口 storage 事件", () => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "ownclass:group-material-layout",
        newValue: "stack",
      }),
    );
    expect(getGroupMaterialLayout()).toBe("stack");
  });
});
