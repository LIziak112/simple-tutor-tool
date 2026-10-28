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
  it("false判断有效，草稿不计答案；QM-09：仅正式手写即已作答（旧题型不强制再填单行最终答案）", () => {
    expect(
      getQuestionCompletion(
        { ...question, type: "judge" },
        { kind: "judge", value: false },
      ).state,
    ).toBe("filled");
    // QM-09 细项2：solve/apply/find-error 有正式笔迹未填最终答案 = filled
    //（决策记录 §5.7.3 response 行「或正式笔迹」口径对称放宽，I06 旧注随
    // 本单作废——见 TT-08b 决策小节）
    expect(
      getQuestionCompletion({ ...question, type: "solve" }, undefined, true)
        .state,
    ).toBe("filled");
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

  it("response 完整度：正文非空白或正式笔迹任一即 filled（QM-09；仅手写合法）", () => {
    const resp = { ...question, type: "response" as const };
    // 正文非空白（无笔迹）
    expect(
      getQuestionCompletion(resp, { kind: "response", body: "概括主要特点。" }),
    ).toEqual({ state: "filled", filledSlots: 1, expectedSlots: 1 });
    // 仅手写：body 空串 + 正式笔迹（决策记录 §5.7.3「或正式笔迹」口径）
    expect(
      getQuestionCompletion(resp, { kind: "response", body: "" }, true).state,
    ).toBe("filled");
    // 混合：正文 + 笔迹
    expect(
      getQuestionCompletion(resp, { kind: "response", body: "草稿" }, true)
        .state,
    ).toBe("filled");
    // 空白正文不计（纯空白字符等同未写）
    expect(
      getQuestionCompletion(resp, { kind: "response", body: "  \n " }).state,
    ).toBe("empty");
    // 什么都没有
    expect(getQuestionCompletion(resp, undefined).state).toBe("empty");
    // I02 错配答案按未作答
    expect(
      getQuestionCompletion(resp, { kind: "final", finalAnswer: "0" }).state,
    ).toBe("empty");
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
