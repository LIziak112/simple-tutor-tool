import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  bindKeyboardBindingsAccount,
  getResolvedKeyboardBindings,
  saveKeyboardBindings,
  subscribeKeyboardBindings,
  useKeyboardBindings,
} from "./keyboard-binding-store";

/**
 * 键位绑定本设备偏好存储：默认空覆盖表（= 全默认键位）、保存整组替换、
 * 损坏与未来 version 整体回默认、账号隔离拒绝迟到保存、跨标签事件同步、
 * 写入失败抛错不发布。仅契约 v1 形态落 localStorage，按账号隔离。
 */

const storageKeyOf = (id: string) =>
  `ownclass:keyboard-bindings:${JSON.stringify([location.origin, "student", id])}`;

beforeEach(() => {
  localStorage.clear();
  bindKeyboardBindingsAccount(null);
  vi.restoreAllMocks();
});

it("未保存时生效键位 = 注册表默认（Enter/←→/? 与固定 1–9）", () => {
  bindKeyboardBindingsAccount("a");
  expect(localStorage.getItem(storageKeyOf("a"))).toBeNull();
  expect(getResolvedKeyboardBindings()["practice.submit-or-next"]).toEqual([
    "Enter",
    "Shift+Enter",
  ]);
  expect(getResolvedKeyboardBindings()["practice.next-question"]).toEqual([
    "ArrowRight",
    "Shift+ArrowRight",
  ]);
  expect(getResolvedKeyboardBindings()["practice.select-option"]).toHaveLength(
    9,
  );
});

it("保存覆盖表整组替换并落契约 v1 形态；重登读回；未知命令读侧丢弃", () => {
  bindKeyboardBindingsAccount("a");
  saveKeyboardBindings({ "practice.next-question": ["j"] });
  const raw = localStorage.getItem(storageKeyOf("a"));
  expect(JSON.parse(raw ?? "{}")).toEqual({
    version: 1,
    bindings: { "practice.next-question": ["j"] },
  });
  expect(getResolvedKeyboardBindings()["practice.next-question"]).toEqual([
    "j",
  ]);
  bindKeyboardBindingsAccount(null);
  bindKeyboardBindingsAccount("a");
  expect(getResolvedKeyboardBindings()["practice.next-question"]).toEqual([
    "j",
  ]);
  // 手写未知命令（注册表演进后的存量数据）：形状合法但读侧丢弃，回落默认
  localStorage.setItem(
    storageKeyOf("a"),
    JSON.stringify({
      version: 1,
      bindings: {
        "practice.next-question": ["j"],
        "lesson.prev-question": ["k"],
      },
    }),
  );
  bindKeyboardBindingsAccount(null);
  bindKeyboardBindingsAccount("a");
  expect(getResolvedKeyboardBindings()["practice.next-question"]).toEqual([
    "j",
  ]);
  expect("lesson.prev-question" in getResolvedKeyboardBindings()).toBe(false);
});

it("恢复默认 = 保存空覆盖表（storage 留痕，下次读回默认）", () => {
  bindKeyboardBindingsAccount("a");
  saveKeyboardBindings({ "practice.open-help": ["h"] });
  saveKeyboardBindings({});
  expect(localStorage.getItem(storageKeyOf("a"))).toBe(
    '{"version":1,"bindings":{}}',
  );
  expect(getResolvedKeyboardBindings()["practice.open-help"]).toEqual(["?"]);
});

it("账号隔离：换账号读默认，旧账号的迟到保存被拒绝", () => {
  bindKeyboardBindingsAccount("a");
  saveKeyboardBindings({ "practice.next-question": ["j"] });
  bindKeyboardBindingsAccount("b");
  expect(getResolvedKeyboardBindings()["practice.next-question"]).toEqual([
    "ArrowRight",
    "Shift+ArrowRight",
  ]);
  expect(() => saveKeyboardBindings({}, "a")).toThrow(/账号/);
});

it("损坏 JSON / 未来 version / 存储不可读整体回默认，不抛错", () => {
  localStorage.setItem(storageKeyOf("a"), "{broken json");
  bindKeyboardBindingsAccount("a");
  expect(getResolvedKeyboardBindings()["practice.next-question"]).toEqual([
    "ArrowRight",
    "Shift+ArrowRight",
  ]);
  bindKeyboardBindingsAccount(null);
  localStorage.setItem(
    storageKeyOf("a"),
    JSON.stringify({
      version: 2,
      bindings: { "practice.next-question": ["j"] },
    }),
  );
  bindKeyboardBindingsAccount("a");
  expect(getResolvedKeyboardBindings()["practice.next-question"]).toEqual([
    "ArrowRight",
    "Shift+ArrowRight",
  ]);
  bindKeyboardBindingsAccount(null);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("存储被禁用");
  });
  expect(() => bindKeyboardBindingsAccount("a")).not.toThrow();
  expect(getResolvedKeyboardBindings()["practice.next-question"]).toEqual([
    "ArrowRight",
    "Shift+ArrowRight",
  ]);
});

it("非法键位（Ctrl 组合 / 3 键）保存时被契约兜底拒绝", () => {
  bindKeyboardBindingsAccount("a");
  expect(() =>
    saveKeyboardBindings({ "practice.next-question": ["Ctrl+X"] }),
  ).toThrow();
  expect(() =>
    saveKeyboardBindings({ "practice.next-question": ["j", "k", "l"] }),
  ).toThrow();
  expect(getResolvedKeyboardBindings()["practice.next-question"]).toEqual([
    "ArrowRight",
    "Shift+ArrowRight",
  ]);
});

it("跨标签事件同步当前账号；写入失败抛错且不发布", () => {
  bindKeyboardBindingsAccount("a");
  saveKeyboardBindings({ "practice.next-question": ["j"] });
  const key = storageKeyOf("a");
  const notify = vi.fn();
  const unsubscribe = subscribeKeyboardBindings(notify);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: '{"version":1,"bindings":{"practice.open-help":["h"]}}',
      storageArea: localStorage,
    }),
  );
  expect(getResolvedKeyboardBindings()["practice.open-help"]).toEqual(["h"]);
  expect(getResolvedKeyboardBindings()["practice.next-question"]).toEqual([
    "ArrowRight",
    "Shift+ArrowRight",
  ]);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "other",
      newValue: "x",
      storageArea: localStorage,
    }),
  );
  expect(getResolvedKeyboardBindings()["practice.open-help"]).toEqual(["h"]);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: "broken",
      storageArea: localStorage,
    }),
  );
  expect(getResolvedKeyboardBindings()["practice.open-help"]).toEqual(["?"]);
  expect(notify).toHaveBeenCalled();
  unsubscribe();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("空间不足");
  });
  expect(() => saveKeyboardBindings({ "practice.open-help": ["h"] })).toThrow(
    /空间不足|存储/,
  );
  expect(getResolvedKeyboardBindings()["practice.open-help"]).toEqual(["?"]);
});

it("存储清空事件（key null）→ 回默认键位", () => {
  bindKeyboardBindingsAccount("a");
  saveKeyboardBindings({ "practice.next-question": ["j"] });
  window.dispatchEvent(
    new StorageEvent("storage", { key: null, storageArea: localStorage }),
  );
  expect(getResolvedKeyboardBindings()["practice.next-question"]).toEqual([
    "ArrowRight",
    "Shift+ArrowRight",
  ]);
});

it("跨标签保存后 useKeyboardBindings 订阅方当场拿到新键位（缓存先于通知换新）", () => {
  bindKeyboardBindingsAccount("a");
  const { result } = renderHook(() => useKeyboardBindings());
  expect(result.current["practice.open-help"]).toEqual(["?"]);
  // React 订阅回调在 store.set 通知当场读快照比对——若 resolvedCache 在通知
  // 之后才换新，会被判「无变化」而漏掉这次键位更新（作答页/帮助弹层不刷新）
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKeyOf("a"),
        newValue: '{"version":1,"bindings":{"practice.open-help":["h"]}}',
        storageArea: localStorage,
      }),
    );
  });
  expect(result.current["practice.open-help"]).toEqual(["h"]);
});
