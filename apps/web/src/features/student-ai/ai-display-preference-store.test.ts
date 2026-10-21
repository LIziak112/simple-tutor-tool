import { beforeEach, expect, it, vi } from "vitest";
import {
  bindAiDisplayAccount,
  getAiDisplayPreference,
  saveAiDisplayPreference,
  subscribeAiDisplayPreference,
} from "./ai-display-preference-store";

beforeEach(() => {
  localStorage.clear();
  bindAiDisplayAccount(null);
  vi.restoreAllMocks();
});

it("布局按学生账号隔离，重新登录本人可恢复", () => {
  bindAiDisplayAccount("a");
  saveAiDisplayPreference("side");
  bindAiDisplayAccount("b");
  expect(getAiDisplayPreference().layout).toBe("inline");
  saveAiDisplayPreference("dialog");
  bindAiDisplayAccount(null);
  expect(() => saveAiDisplayPreference("side")).toThrow();
  bindAiDisplayAccount("a");
  expect(getAiDisplayPreference().layout).toBe("side");
});

it("存储失败不发布成功，旧账号的迟到保存被拒绝", () => {
  bindAiDisplayAccount("a");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("空间不足");
  });
  expect(() => saveAiDisplayPreference("side", "a")).toThrow();
  expect(getAiDisplayPreference().layout).toBe("inline");
  bindAiDisplayAccount("b");
  expect(() => saveAiDisplayPreference("side", "a")).toThrow(/账号/);
});

it("跨标签同步当前账号，损坏数据回退，其他账号事件不影响当前值", () => {
  bindAiDisplayAccount("a");
  saveAiDisplayPreference("side");
  const key = localStorage.key(0);
  const notify = vi.fn();
  const unsubscribe = subscribeAiDisplayPreference(notify);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: '{"version":1,"layout":"dialog"}',
      storageArea: localStorage,
    }),
  );
  expect(getAiDisplayPreference().layout).toBe("dialog");
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "other",
      newValue: "broken",
      storageArea: localStorage,
    }),
  );
  expect(getAiDisplayPreference().layout).toBe("dialog");
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: "broken",
      storageArea: localStorage,
    }),
  );
  expect(getAiDisplayPreference().layout).toBe("inline");
  expect(notify).toHaveBeenCalled();
  unsubscribe();
});
