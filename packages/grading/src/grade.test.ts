import { describe, expect, it } from "vitest";
import type { Question } from "@tutor/contract";
import { grade } from "./grade";

/**
 * 各题型判分（§5.6 + T2.5 验收清单）：
 * - judge/choice/multi/fill 判 true/false；solve/apply/find-error 手写题无最终答案 → null；
 * - fill 多空全部空对才 true（部分错误判 false）；multi 全对才 true；
 * - 未作答（answer 缺省）→ null，与答错（false）区分；
 * - 题目侧 answers 缺省（解析不完整/手写题未给 :::answer）→ null（不自动判分）。
 */

/** 构造一道题（覆盖 Question 必填字段，answers/options 按用例传入） */
function makeQuestion(partial: {
  type: Question["type"];
  answers?: Question["answers"];
  options?: Question["options"];
}): Question {
  return {
    id: "test-1",
    type: partial.type,
    difficulty: 2,
    knowledge: ["测试考点"],
    stemMd: "测试题干",
    ...(partial.options !== undefined ? { options: partial.options } : {}),
    ...(partial.answers !== undefined ? { answers: partial.answers } : {}),
    hints: [],
    sourceMd: "测试原文",
  };
}

describe("grade：判断题", () => {
  const q = (value: boolean) => makeQuestion({ type: "judge", answers: { kind: "judge", value } });

  it("布尔形态：标准答案 true，学生答 true → true；答 false → false", () => {
    expect(grade(q(true), { kind: "judge", value: true })).toBe(true);
    expect(grade(q(true), { kind: "judge", value: false })).toBe(false);
    expect(grade(q(false), { kind: "judge", value: false })).toBe(true);
  });

  it("验收：判断题各种写法（旧版 §5 全集，两侧任一写法都归一化后比较）", () => {
    for (const text of ["正确", "对", "√", "✔", "T", "TRUE", "是", "true", "Ｔ"]) {
      expect(grade(q(true), { kind: "judge", value: text })).toBe(true);
    }
    for (const text of ["错误", "错", "×", "✘", "F", "FALSE", "否", "false", "ｆ"]) {
      expect(grade(q(false), { kind: "judge", value: text })).toBe(true);
    }
    // 写法与标准答案相反 → false
    expect(grade(q(true), { kind: "judge", value: "错" })).toBe(false);
    expect(grade(q(false), { kind: "judge", value: "√" })).toBe(false);
  });

  it("无法识别的写法 → null（不能判，不冒充答错）", () => {
    expect(grade(q(true), { kind: "judge", value: "随便写" })).toBeNull();
    expect(grade(q(true), { kind: "judge", value: "" })).toBeNull();
  });

  it("未作答（answer 缺省）→ null；题目无 answers → null", () => {
    expect(grade(q(true), undefined)).toBeNull();
    expect(grade(makeQuestion({ type: "judge" }), { kind: "judge", value: true })).toBeNull();
  });
});

describe("grade：单选题", () => {
  const options = [
    { text: "$-5$", correct: false },
    { text: "$5$", correct: true },
    { text: "$\\frac{1}{5}$", correct: false },
  ];
  const q = makeQuestion({ type: "choice", options, answers: { kind: "choice", index: 1 } });

  it("下标相等 → true，不等 → false", () => {
    expect(grade(q, { kind: "choice", index: 1 })).toBe(true);
    expect(grade(q, { kind: "choice", index: 0 })).toBe(false);
    expect(grade(q, { kind: "choice", index: 2 })).toBe(false);
  });

  it("验收：索引越界 → false（不是异常）", () => {
    expect(grade(q, { kind: "choice", index: 3 })).toBe(false);
    expect(grade(q, { kind: "choice", index: 99 })).toBe(false);
  });

  it("未作答 → null；题目无 answers → null", () => {
    expect(grade(q, undefined)).toBeNull();
    expect(
      grade(makeQuestion({ type: "choice", options }), { kind: "choice", index: 1 }),
    ).toBeNull();
  });
});

describe("grade：多选题", () => {
  const options = [
    { text: "$(-3)+7$", correct: true },
    { text: "$(-2)+(-5)$", correct: false },
    { text: "$0+4.8$", correct: true },
    { text: "$|-9|+(-10)$", correct: false },
  ];
  const q = makeQuestion({ type: "multi", options, answers: { kind: "multi", indexes: [0, 2] } });

  it("全对才 true（§5.6；顺序无关）", () => {
    expect(grade(q, { kind: "multi", indexes: [0, 2] })).toBe(true);
    expect(grade(q, { kind: "multi", indexes: [2, 0] })).toBe(true);
  });

  it("验收：部分正确（漏选/多选/选错）→ false", () => {
    expect(grade(q, { kind: "multi", indexes: [0] })).toBe(false); // 漏选
    expect(grade(q, { kind: "multi", indexes: [0, 1, 2] })).toBe(false); // 多选
    expect(grade(q, { kind: "multi", indexes: [1, 3] })).toBe(false); // 全错
    expect(grade(q, { kind: "multi", indexes: [3] })).toBe(false);
  });

  it("任一越界下标 → false；空选（未选任何项）→ null", () => {
    expect(grade(q, { kind: "multi", indexes: [0, 4] })).toBe(false);
    expect(grade(q, { kind: "multi", indexes: [] })).toBeNull();
  });

  it("未作答 → null；题目无 answers → null", () => {
    expect(grade(q, undefined)).toBeNull();
    expect(
      grade(makeQuestion({ type: "multi", options }), { kind: "multi", indexes: [0] }),
    ).toBeNull();
  });
});

describe("grade：填空题", () => {
  it("单空：normalize 全等即对", () => {
    const q = makeQuestion({ type: "fill", answers: { kind: "fill", blanks: [["-7"]] } });
    expect(grade(q, { kind: "fill", values: ["-7"] })).toBe(true);
    expect(grade(q, { kind: "fill", values: ["－7"] })).toBe(true); // 全角负号
    expect(grade(q, { kind: "fill", values: ["$-7$"] })).toBe(true);
    expect(grade(q, { kind: "fill", values: ["7"] })).toBe(false);
  });

  it("验收：数值等价 \\frac{1}{2} = 0.5 = 1/2", () => {
    const q = makeQuestion({ type: "fill", answers: { kind: "fill", blanks: [["0.5"]] } });
    expect(grade(q, { kind: "fill", values: ["\\frac{1}{2}"] })).toBe(true);
    expect(grade(q, { kind: "fill", values: ["1/2"] })).toBe(true);
    expect(grade(q, { kind: "fill", values: ["0.25"] })).toBe(false);
  });

  it("等价答案列表（[[0.5|1/2]] 多候选）任一匹配即对（旧版语义）", () => {
    const q = makeQuestion({
      type: "fill",
      answers: { kind: "fill", blanks: [["0.5", "1/2", "一半"]] },
    });
    expect(grade(q, { kind: "fill", values: ["0.5"] })).toBe(true);
    expect(grade(q, { kind: "fill", values: ["1/2"] })).toBe(true);
    expect(grade(q, { kind: "fill", values: ["一半"] })).toBe(true);
    expect(grade(q, { kind: "fill", values: ["\\frac{1}{2}"] })).toBe(true); // 列表外的数值等价也认可
    expect(grade(q, { kind: "fill", values: ["0.7"] })).toBe(false);
  });

  it("多空全对才 true（验收：部分错误判 false）", () => {
    const q = makeQuestion({
      type: "fill",
      answers: { kind: "fill", blanks: [["4"], ["-7"], ["0.5", "1/2"]] },
    });
    expect(grade(q, { kind: "fill", values: ["4", "-7", "1/2"] })).toBe(true);
    expect(grade(q, { kind: "fill", values: ["4", "7", "0.5"] })).toBe(false); // 第二空错
    expect(grade(q, { kind: "fill", values: ["4", "-7", "0.6"] })).toBe(false); // 第三空错
  });

  it("某空空串或缺失（比 blanks 短）按旧版口径判错 → false", () => {
    const q = makeQuestion({ type: "fill", answers: { kind: "fill", blanks: [["8"]] } });
    expect(grade(q, { kind: "fill", values: [""] })).toBe(false);
    expect(grade(q, { kind: "fill", values: [] })).toBe(false);
    const q2 = makeQuestion({
      type: "fill",
      answers: { kind: "fill", blanks: [["4"], ["-7"]] },
    });
    expect(grade(q2, { kind: "fill", values: ["4"] })).toBe(false); // 缺第二空
  });

  it("未作答 → null；题目无 answers（无填空标记）→ null", () => {
    const q = makeQuestion({ type: "fill", answers: { kind: "fill", blanks: [["8"]] } });
    expect(grade(q, undefined)).toBeNull();
    expect(grade(makeQuestion({ type: "fill" }), { kind: "fill", values: ["8"] })).toBeNull();
  });
});

describe("grade：手写题（solve/apply/find-error）", () => {
  const solveQ = makeQuestion({
    type: "solve",
    answers: { kind: "final", answer: "-3" },
  });
  const applyQ = makeQuestion({
    type: "apply",
    answers: { kind: "final", answer: "1.4" },
  });
  const findErrorQ = makeQuestion({
    type: "find-error",
    answers: {
      kind: "final",
      answer: "第一步开始出错：异号相加应取绝对值较大的加数的符号",
    },
  });

  it("验收：未填最终答案 → null（进待批队列）", () => {
    expect(grade(solveQ, undefined)).toBeNull(); // answer 缺省
    expect(grade(solveQ, { kind: "final", finalAnswer: "" })).toBeNull(); // 空串
    expect(grade(solveQ, { kind: "final", finalAnswer: "   " })).toBeNull(); // 纯空白
  });

  it("填了最终答案且题目给了 :::answer：normalize + 数值等价判分", () => {
    expect(grade(solveQ, { kind: "final", finalAnswer: "-3" })).toBe(true);
    expect(grade(solveQ, { kind: "final", finalAnswer: "$-3$" })).toBe(true);
    expect(grade(solveQ, { kind: "final", finalAnswer: "2" })).toBe(false);
    // 数值等价：7/5 = 1.4（apply 题，水位样例）
    expect(grade(applyQ, { kind: "final", finalAnswer: "1.4" })).toBe(true);
    expect(grade(applyQ, { kind: "final", finalAnswer: "7/5" })).toBe(true);
    expect(grade(applyQ, { kind: "final", finalAnswer: "\\frac{14}{10}" })).toBe(true);
    expect(grade(applyQ, { kind: "final", finalAnswer: "1.5" })).toBe(false);
  });

  it("find-error 长文本：normalize 全等（去空白/全角归一）", () => {
    expect(
      grade(findErrorQ, {
        kind: "final",
        finalAnswer: "第一步开始出错：异号相加应取绝对值较大的加数的符号",
      }),
    ).toBe(true);
    expect(
      grade(findErrorQ, {
        kind: "final",
        finalAnswer: "第一步开始出错： 异号相加应取绝对值较大的加数的符号 ",
      }),
    ).toBe(true); // 空白差异被归一化
    expect(
      grade(findErrorQ, { kind: "final", finalAnswer: "第二步开始出错" }),
    ).toBe(false);
  });

  it("题目未给 :::answer（answers 缺省）：即使填了最终答案也 → null（进待批）", () => {
    const noAnswer = makeQuestion({ type: "solve" });
    expect(grade(noAnswer, { kind: "final", finalAnswer: "-3" })).toBeNull();
    expect(grade(noAnswer, undefined)).toBeNull();
  });
});

describe("grade：形态错位与防御", () => {
  it("学生答案 kind 与题型不符（客户端形态错误）→ null，不抛异常", () => {
    const fillQ = makeQuestion({ type: "fill", answers: { kind: "fill", blanks: [["8"]] } });
    expect(grade(fillQ, { kind: "choice", index: 0 })).toBeNull();
    const choiceQ = makeQuestion({
      type: "choice",
      options: [{ text: "A", correct: true }],
      answers: { kind: "choice", index: 0 },
    });
    expect(grade(choiceQ, { kind: "fill", values: ["A"] })).toBeNull();
    expect(grade(choiceQ, { kind: "final", finalAnswer: "A" })).toBeNull();
  });

  it("题目 answers 的 kind 与题型不符（带错误的解析结果）→ null", () => {
    const mismatched = makeQuestion({
      type: "judge",
      answers: { kind: "fill", blanks: [["正确"]] },
    });
    expect(grade(mismatched, { kind: "judge", value: true })).toBeNull();
  });

  it("choice/multi 题目缺 options（理论不可能）：仍可按 answers 下标比较，不抛异常", () => {
    const choiceNoOptions = makeQuestion({
      type: "choice",
      answers: { kind: "choice", index: 1 },
    });
    expect(grade(choiceNoOptions, { kind: "choice", index: 1 })).toBe(true);
    expect(grade(choiceNoOptions, { kind: "choice", index: 0 })).toBe(false);
    const multiNoOptions = makeQuestion({
      type: "multi",
      answers: { kind: "multi", indexes: [0, 1] },
    });
    expect(grade(multiNoOptions, { kind: "multi", indexes: [1, 0] })).toBe(true);
    expect(grade(multiNoOptions, { kind: "multi", indexes: [0] })).toBe(false);
  });
});
