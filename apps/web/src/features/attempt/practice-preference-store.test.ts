import { beforeEach, expect, it, vi } from "vitest";
import {
  bindPracticePreferenceAccount,
  currentLayout,
  getPracticePreference,
  savePracticePreference,
  subscribePracticePreference,
} from "./practice-preference-store";

/**
 * 做题方式偏好存储（M3-D1 / M5-D2 / M5-D3）：默认布局 + 快捷键开关 + 反馈节奏
 * （M5-D2 起 feedback 可「未设置」= null = 键缺省——未设置时建卷请求不带
 * feedbackMode，文档推荐才能生效；保存布局不得补写伪造的 feedback。
 * M5-D3 起 layout 同款可选——未设置 = 键缺省，开始页可用单元推荐预选；
 * currentLayout() 供只关心现值的消费面回落缺省列表）。
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

it("默认布局与反馈节奏均未设置（null），currentLayout() 回落列表布局", () => {
  bindPracticePreferenceAccount("a");
  expect(getPracticePreference()).toEqual({
    accountId: "a",
    layout: null,
    keyboardShortcuts: true,
    feedback: null,
  });
  expect(currentLayout()).toBe("list");
});

it("保存布局后 storage 无 feedback 键（未设置不补写，推荐不被挡死）；本人重登仍未设置", () => {
  bindPracticePreferenceAccount("a");
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: false,
    feedback: null,
  });
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
    savePracticePreference({
      layout: "list",
      keyboardShortcuts: true,
      feedback: null,
    }),
  ).toThrow(/账号/);
  bindPracticePreferenceAccount("a");
  expect(getPracticePreference().layout).toBe("single");
  expect(getPracticePreference().keyboardShortcuts).toBe(false);
  expect(getPracticePreference().feedback).toBeNull();
});

it("M5-D3：保存 layout null → storage 无 layout 键；feedback 保存与清除键缺省", () => {
  bindPracticePreferenceAccount("a");
  savePracticePreference({
    layout: null,
    keyboardShortcuts: true,
    feedback: "per_question",
  });
  const raw1 = JSON.parse(localStorage.getItem(storageKeyOf("a")) ?? "{}");
  expect("layout" in raw1).toBe(false);
  expect(raw1.feedback).toBe("per_question");
  expect(getPracticePreference().layout).toBeNull();
  expect(getPracticePreference().feedback).toBe("per_question");
  // 反馈节奏改回未设置：键缺省（文档推荐重新生效），布局写入
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: true,
    feedback: null,
  });
  const raw2 = JSON.parse(localStorage.getItem(storageKeyOf("a")) ?? "{}");
  expect(raw2.layout).toBe("single");
  expect("feedback" in raw2).toBe(false);
  expect(getPracticePreference().layout).toBe("single");
  expect(getPracticePreference().feedback).toBeNull();
  expect(currentLayout()).toBe("single");
});

it("M5-D3：M3 存量全量形态（layout+feedback 双带）读回，两字段均视作已设置", () => {
  localStorage.setItem(
    storageKeyOf("a"),
    JSON.stringify({
      version: 1,
      layout: "single",
      feedback: "after_attempt",
      keyboardShortcuts: false,
    }),
  );
  bindPracticePreferenceAccount("a");
  expect(getPracticePreference().layout).toBe("single");
  expect(getPracticePreference().feedback).toBe("after_attempt");
  expect(currentLayout()).toBe("single");
});

it("M3 存量全量形态（带 feedback）视作已设置，重登读回（feedback 侧回归）", () => {
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
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: true,
    feedback: null,
  });
  bindPracticePreferenceAccount("b");
  expect(getPracticePreference().layout).toBeNull();
  expect(getPracticePreference().keyboardShortcuts).toBe(true);
  expect(() =>
    savePracticePreference(
      { layout: "single", keyboardShortcuts: false, feedback: null },
      "a",
    ),
  ).toThrow(/账号/);
});

it("损坏 JSON 与存储不可读时回默认，不抛错", () => {
  localStorage.setItem(storageKeyOf("a"), "{broken json");
  bindPracticePreferenceAccount("a");
  expect(getPracticePreference().layout).toBeNull();
  expect(getPracticePreference().keyboardShortcuts).toBe(true);
  expect(getPracticePreference().feedback).toBeNull();
  expect(currentLayout()).toBe("list");
  bindPracticePreferenceAccount(null);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("存储被禁用");
  });
  expect(() => bindPracticePreferenceAccount("a")).not.toThrow();
  expect(getPracticePreference().layout).toBeNull();
});

it("存储写入失败抛错且不发布，跨标签事件同步当前账号", () => {
  bindPracticePreferenceAccount("a");
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: true,
    feedback: null,
  });
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
  expect(getPracticePreference().layout).toBeNull();
  expect(getPracticePreference().keyboardShortcuts).toBe(true);
  expect(notify).toHaveBeenCalled();
  unsubscribe();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("空间不足");
  });
  expect(() =>
    savePracticePreference(
      { layout: "single", keyboardShortcuts: true, feedback: null },
      "a",
    ),
  ).toThrow(/空间不足|存储/);
  expect(getPracticePreference().layout).toBeNull();
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

it("M5-D3：跨标签事件 newValue 缺 layout 键 → 未设置（currentLayout 回列表）", () => {
  bindPracticePreferenceAccount("a");
  const key = storageKeyOf("a");
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue:
        '{"version":1,"feedback":"per_question","keyboardShortcuts":false}',
      storageArea: localStorage,
    }),
  );
  expect(getPracticePreference().layout).toBeNull();
  expect(getPracticePreference().keyboardShortcuts).toBe(false);
  expect(getPracticePreference().feedback).toBe("per_question");
  expect(currentLayout()).toBe("list");
});

it("M5-D2：存储清空事件（key null）→ 回默认且 layout/feedback 均未设置", () => {
  bindPracticePreferenceAccount("a");
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: false,
    feedback: "per_question",
  });
  window.dispatchEvent(
    new StorageEvent("storage", { key: null, storageArea: localStorage }),
  );
  expect(getPracticePreference()).toEqual({
    accountId: "a",
    layout: null,
    keyboardShortcuts: true,
    feedback: null,
  });
});
