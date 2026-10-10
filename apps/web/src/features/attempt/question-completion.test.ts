import type { QuestionPublic } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { getQuestionCompletion } from "./question-completion";

const question: QuestionPublic = {
  id: "q",
  type: "fill",
  difficulty: 1,
  knowledge: [],
  stemMd: "甲 [[]]，乙 [[]]，丙 [[]]，丁 [[]]",
  hintCount: 0,
};
describe("题目填写完整度", () => {
  it("一空不能计完整，补齐和清空可来回转换", () => {
    expect(
      getQuestionCompletion(question, { kind: "fill", values: ["1"] }),
    ).toEqual({ state: "partial", filledSlots: 1, expectedSlots: 4 });
    expect(
      getQuestionCompletion(question, {
        kind: "fill",
        values: ["1", "2", "3", "4"],
      }).state,
    ).toBe("filled");
    expect(
      getQuestionCompletion(question, {
        kind: "fill",
        values: ["1", " ", "3", "4"],
      }).state,
    ).toBe("partial");
  });
  it("从实际渲染AST计空，数学与代码中的标记不计空，显式blank计空", () => {
    const q = { ...question, stemMd: "`[[]]` $[[]]$\n\n:blank[] 和 **[[]]**" };
    expect(
      getQuestionCompletion(q, { kind: "fill", values: ["1", "2"] }),
    ).toEqual({ state: "filled", filledSlots: 2, expectedSlots: 2 });
  });
  it("false判断有效，草稿不计答案，只有正式过程显示部分完成", () => {
    expect(
      getQuestionCompletion(
        { ...question, type: "judge" },
        { kind: "judge", value: false },
      ).state,
    ).toBe("filled");
    expect(
      getQuestionCompletion({ ...question, type: "solve" }, undefined, true)
        .state,
    ).toBe("partial");
    expect(
      getQuestionCompletion({ ...question, type: "solve" }, undefined).state,
    ).toBe("empty");
    expect(
      getQuestionCompletion(
        { ...question, type: "solve" },
        { kind: "final", finalAnswer: "0" },
        true,
      ).state,
    ).toBe("filled");
  });
  it("多余答案不能补足空位，无空位的坏题不能虚报完成", () => {
    expect(
      getQuestionCompletion(question, {
        kind: "fill",
        values: ["", "", "", "", "1"],
      }).state,
    ).toBe("empty");
    expect(
      getQuestionCompletion(
        { ...question, stemMd: "无空位" },
        { kind: "fill", values: ["1"] },
      ).state,
    ).toBe("empty");
  });
  it("不匹配题型的最终答案不能使客观题虚报完成", () => {
    expect(
      getQuestionCompletion(
        { ...question, type: "judge" },
        { kind: "final", finalAnswer: "0" },
      ).state,
    ).toBe("empty");
  });
});
