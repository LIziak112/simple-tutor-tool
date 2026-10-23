import { beforeEach, expect, it, vi } from "vitest";
import {
  bindPracticePreferenceAccount,
  getPracticePreference,
  savePracticePreference,
  subscribePracticePreference,
} from "./practice-preference-store";

/**
 * 做题方式偏好存储（M3-D1 / M5-D2）：默认布局 + 快捷键开关 + 反馈节奏
 * （M5-D2 起 feedback 可「未设置」= null = 键缺省——未设置时建卷请求不带
 * feedbackMode，文档推荐才能生效；保存布局不得补写伪造的 feedback）。
 * 仅契约 v1 形态落 localStorage，按部署来源 / student 角色 / 账号隔离；
 * 损坏或禁用时回默认、不抛错、不阻断作答（仿 ai-display-preference-store 先例）。
 */

const storageKeyOf = (id: string) =>
  `ownclass:practice-pref:${JSON.stringify([location.origin, "student", id])}`;

beforeEach(() => {
  localStorage.clear();
  bindPracticePreferenceAccount(null);
  vi.restoreAllMocks();
});

it("默认值为列表布局且快捷键开启，反馈节奏未设置（null）", () => {
  bindPracticePreferenceAccount("a");
  expect(getPracticePreference()).toEqual({
    accountId: "a",
    layout: "list",
    keyboardShortcuts: true,
    feedback: null,
  });
});

it("保存布局后 storage 无 feedback 键（未设置不补写，推荐不被挡死）；本人重登仍未设置", () => {
  bindPracticePreferenceAccount("a");
  savePracticePreference({ layout: "single", keyboardShortcuts: false });
  const raw = localStorage.getItem(storageKeyOf("a"));
  expect(raw).not.toBeNull();
  expect(JSON.parse(raw ?? "{}")).toEqual({
    version: 1,
    layout: "single",
    keyboardShortcuts: false,
  });
  expect("feedback" in JSON.parse(raw ?? "{}")).toBe(false);
  bindPracticePreferenceAccount(null);
  expect(() =>
    savePracticePreference({ layout: "list", keyboardShortcuts: true }),
  ).toThrow(/账号/);
  bindPracticePreferenceAccount("a");
  expect(getPracticePreference().layout).toBe("single");
  expect(getPracticePreference().keyboardShortcuts).toBe(false);
  expect(getPracticePreference().feedback).toBeNull();
});

it("M3 存量全量形态（带 feedback）视作已设置，重登读回", () => {
  localStorage.setItem(
    storageKeyOf("a"),
    JSON.stringify({
      version: 1,
      layout: "list",
      feedback: "after_attempt",
      keyboardShortcuts: true,
    }),
  );
  bindPracticePreferenceAccount("a");
  expect(getPracticePreference().feedback).toBe("after_attempt");
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
  localStorage.setItem(storageKeyOf("a"), "{broken json");
  bindPracticePreferenceAccount("a");
  expect(getPracticePreference().layout).toBe("list");
  expect(getPracticePreference().keyboardShortcuts).toBe(true);
  expect(getPracticePreference().feedback).toBeNull();
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
  expect(getPracticePreference().feedback).toBe("after_attempt");
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

it("M5-D2：跨标签事件 newValue 缺 feedback 键 → 未设置（另一标签保存布局后同步）", () => {
  bindPracticePreferenceAccount("a");
  const key = storageKeyOf("a");
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: '{"version":1,"layout":"single","keyboardShortcuts":false}',
      storageArea: localStorage,
    }),
  );
  expect(getPracticePreference().layout).toBe("single");
  expect(getPracticePreference().keyboardShortcuts).toBe(false);
  expect(getPracticePreference().feedback).toBeNull();
});

it("M5-D2：存储清空事件（key null）→ 回默认且 feedback 未设置", () => {
  bindPracticePreferenceAccount("a");
  savePracticePreference({ layout: "single", keyboardShortcuts: false });
  window.dispatchEvent(
    new StorageEvent("storage", { key: null, storageArea: localStorage }),
  );
  expect(getPracticePreference()).toEqual({
    accountId: "a",
    layout: "list",
    keyboardShortcuts: true,
    feedback: null,
  });
});
