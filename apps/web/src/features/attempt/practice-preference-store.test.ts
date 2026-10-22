import { beforeEach, expect, it, vi } from "vitest";
import {
  bindPracticePreferenceAccount,
  getPracticePreference,
  savePracticePreference,
  subscribePracticePreference,
} from "./practice-preference-store";

/**
 * 做题方式偏好存储（M3-D1）：默认布局 + 快捷键开关；仅枚举与版本号落
 * localStorage，按部署来源 / student 角色 / 账号隔离；损坏或禁用时回默认、
 * 不抛错、不阻断作答（仿 ai-display-preference-store 先例）。
 */

beforeEach(() => {
  localStorage.clear();
  bindPracticePreferenceAccount(null);
  vi.restoreAllMocks();
});

it("默认值为列表布局且快捷键开启", () => {
  bindPracticePreferenceAccount("a");
  expect(getPracticePreference()).toEqual({
    accountId: "a",
    layout: "list",
    keyboardShortcuts: true,
    feedback: "per_question",
  });
});

it("保存写入完整契约形态（版本 + 两枚举 + 快捷键），本人重登可恢复", () => {
  bindPracticePreferenceAccount("a");
  savePracticePreference({ layout: "single", keyboardShortcuts: false });
  const raw = localStorage.getItem(
    `ownclass:practice-pref:${JSON.stringify([location.origin, "student", "a"])}`,
  );
  expect(raw).not.toBeNull();
  expect(JSON.parse(raw ?? "{}")).toEqual({
    version: 1,
    layout: "single",
    feedback: "per_question",
    keyboardShortcuts: false,
  });
  bindPracticePreferenceAccount(null);
  expect(() =>
    savePracticePreference({ layout: "list", keyboardShortcuts: true }),
  ).toThrow(/账号/);
  bindPracticePreferenceAccount("a");
  expect(getPracticePreference().layout).toBe("single");
  expect(getPracticePreference().keyboardShortcuts).toBe(false);
});

it("账号隔离：换账号读默认，旧账号的迟到保存被拒绝", () => {
  bindPracticePreferenceAccount("a");
  savePracticePreference({ layout: "single", keyboardShortcuts: true });
  bindPracticePreferenceAccount("b");
  expect(getPracticePreference().layout).toBe("list");
  expect(getPracticePreference().keyboardShortcuts).toBe(true);
  expect(() =>
    savePracticePreference({ layout: "single", keyboardShortcuts: false }, "a"),
  ).toThrow(/账号/);
});

it("损坏 JSON 与存储不可读时回默认，不抛错", () => {
  localStorage.setItem(
    `ownclass:practice-pref:${JSON.stringify([location.origin, "student", "a"])}`,
    "{broken json",
  );
  bindPracticePreferenceAccount("a");
  expect(getPracticePreference().layout).toBe("list");
  expect(getPracticePreference().keyboardShortcuts).toBe(true);
  bindPracticePreferenceAccount(null);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("存储被禁用");
  });
  expect(() => bindPracticePreferenceAccount("a")).not.toThrow();
  expect(getPracticePreference().layout).toBe("list");
});

it("存储写入失败抛错且不发布，跨标签事件同步当前账号", () => {
  bindPracticePreferenceAccount("a");
  savePracticePreference({ layout: "single", keyboardShortcuts: true });
  const key = localStorage.key(0);
  expect(key).toContain(JSON.stringify([location.origin, "student", "a"]));
  const notify = vi.fn();
  const unsubscribe = subscribePracticePreference(notify);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue:
        '{"version":1,"layout":"list","feedback":"after_attempt","keyboardShortcuts":false}',
      storageArea: localStorage,
    }),
  );
  expect(getPracticePreference().layout).toBe("list");
  expect(getPracticePreference().keyboardShortcuts).toBe(false);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "other",
      newValue: "broken",
      storageArea: localStorage,
    }),
  );
  expect(getPracticePreference().keyboardShortcuts).toBe(false);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: "broken",
      storageArea: localStorage,
    }),
  );
  expect(getPracticePreference().layout).toBe("list");
  expect(getPracticePreference().keyboardShortcuts).toBe(true);
  expect(notify).toHaveBeenCalled();
  unsubscribe();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("空间不足");
  });
  expect(() =>
    savePracticePreference({ layout: "single", keyboardShortcuts: true }, "a"),
  ).toThrow(/空间不足|存储/);
  expect(getPracticePreference().layout).toBe("list");
});
