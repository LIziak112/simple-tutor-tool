import { expect, it, vi } from "vitest";
import { emptyAtramentDoc } from "../engine";
import { readFeelDraft, writeFeelDraft } from "./feel-storage";
import { DEFAULT_FEEL_PARAMS } from "./feel-surface";

it("按对照组隔离实验稿，保留参数且不使用正式草稿键", () => {
  localStorage.clear();
  writeFeelDraft("freehand", {
    doc: emptyAtramentDoc(),
    params: DEFAULT_FEEL_PARAMS,
    smoothing: 0.3,
  });
  expect(readFeelDraft("freehand")?.params).toEqual(DEFAULT_FEEL_PARAMS);
  expect(readFeelDraft("baseline")).toBeNull();
  expect(localStorage.key(0)).toMatch(/^ownclass:ink-feel:/);
});
it("坏稿明确报告，不能静默宣称已保存", () => {
  localStorage.setItem("ownclass:ink-feel:freehand", "坏稿");
  expect(() => readFeelDraft("freehand")).toThrow();
});
it("浏览器拒绝写入时向调用方报告失败", () => {
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("配额已满", "QuotaExceededError");
  });
  try {
    expect(() =>
      writeFeelDraft("baseline", {
        doc: emptyAtramentDoc(),
        params: DEFAULT_FEEL_PARAMS,
        smoothing: 0.3,
      }),
    ).toThrow("配额已满");
  } finally {
    spy.mockRestore();
  }
});
