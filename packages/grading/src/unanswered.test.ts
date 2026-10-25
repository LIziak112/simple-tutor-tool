import { describe, expect, it } from "vitest";
import { isUnanswered } from "./unanswered";

describe("isUnanswered（#6980-3 未做判定）", () => {
  it("缺省/null 答案 = 未做", () => {
    expect(isUnanswered(undefined)).toBe(true);
    expect(isUnanswered(null)).toBe(true);
  });

  it("多选空选 = 未做；任一选择 = 已作答", () => {
    expect(isUnanswered({ kind: "multi", indexes: [] })).toBe(true);
    expect(isUnanswered({ kind: "multi", indexes: [0, 2] })).toBe(false);
  });

  it("填空全空（含空数组与纯空白）= 未做；任一空有内容 = 已作答", () => {
    expect(isUnanswered({ kind: "fill", values: [] })).toBe(true);
    expect(isUnanswered({ kind: "fill", values: ["", "  "] })).toBe(true);
    expect(isUnanswered({ kind: "fill", values: ["", " 3"] })).toBe(false);
  });

  it("手写题未填最终答案（空串/纯空白）= 未做；有内容 = 已作答", () => {
    expect(isUnanswered({ kind: "final", finalAnswer: "" })).toBe(true);
    expect(isUnanswered({ kind: "final", finalAnswer: "  " })).toBe(true);
    expect(isUnanswered({ kind: "final", finalAnswer: "x=1" })).toBe(false);
  });

  it("判断/单选存在答案对象即已作答（空形态不存在；旧版空串判断写法算未做）", () => {
    expect(isUnanswered({ kind: "judge", value: true })).toBe(false);
    expect(isUnanswered({ kind: "judge", value: "对" })).toBe(false);
    expect(isUnanswered({ kind: "judge", value: "" })).toBe(true);
    expect(isUnanswered({ kind: "choice", index: 0 })).toBe(false);
  });
});
