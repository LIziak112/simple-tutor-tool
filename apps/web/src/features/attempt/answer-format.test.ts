import { describe, expect, it } from "vitest";
import {
  formatReferenceAnswers,
  formatStudentAnswer,
  isAnswered,
  judgeLabelOf,
  letterOf,
  mathifyAnswerText,
  stemWithoutOptionList,
  withBlankValue,
} from "./answer-format";

/** 作答展示纯函数测试（T2.6）：题型徽章口径见组件测试，这里锁文本化行为。 */

describe("letterOf / judgeLabelOf", () => {
  it("下标转字母（0→A、2→C）", () => {
    expect(letterOf(0)).toBe("A");
    expect(letterOf(2)).toBe("C");
  });

  it("判断题布尔 → 对/错；字符串写法原样", () => {
    expect(judgeLabelOf(true)).toBe("对");
    expect(judgeLabelOf(false)).toBe("错");
    expect(judgeLabelOf("√")).toBe("√");
  });
});

describe("isAnswered（已答 n/m 与交卷确认共用口径）", () => {
  it("judge/choice 有答案即已答", () => {
    expect(isAnswered({ kind: "judge", value: true })).toBe(true);
    expect(isAnswered({ kind: "choice", index: 0 })).toBe(true);
  });

  it("multi 空选未答、有选已答", () => {
    expect(isAnswered({ kind: "multi", indexes: [] })).toBe(false);
    expect(isAnswered({ kind: "multi", indexes: [1] })).toBe(true);
  });

  it("fill 至少一空非空才算已答", () => {
    expect(isAnswered({ kind: "fill", values: ["", ""] })).toBe(false);
    expect(isAnswered({ kind: "fill", values: ["", "4"] })).toBe(true);
  });

  it("final 空串未答、非空已答；undefined 未答", () => {
    expect(isAnswered({ kind: "final", finalAnswer: "  " })).toBe(false);
    expect(isAnswered({ kind: "final", finalAnswer: "-3" })).toBe(true);
    expect(isAnswered(undefined)).toBe(false);
  });
});

describe("formatStudentAnswer", () => {
  it("null → 未作答", () => {
    expect(formatStudentAnswer(null)).toBe("未作答");
  });

  it("各题型文本化：对/B/AC/逐空/最终答案", () => {
    expect(formatStudentAnswer({ kind: "judge", value: false })).toBe("错");
    expect(formatStudentAnswer({ kind: "choice", index: 1 })).toBe("B");
    expect(formatStudentAnswer({ kind: "multi", indexes: [2, 0] })).toBe("AC");
    expect(
      formatStudentAnswer({ kind: "fill", values: ["4", "", "1/2"] }),
    ).toBe("4；（空）；1/2");
    expect(formatStudentAnswer({ kind: "final", finalAnswer: "-3" })).toBe(
      "-3",
    );
    expect(formatStudentAnswer({ kind: "final", finalAnswer: "" })).toBe(
      "（空）",
    );
  });
});

describe("mathifyAnswerText（参考答案显示侧 LaTeX 启发式）", () => {
  it("含 LaTeX 命令形态 → 整段包 $…$（\\frac、\\pm、\\sqrt 等）", () => {
    expect(mathifyAnswerText("-\\frac{5}{4}")).toBe("$-\\frac{5}{4}$");
    expect(mathifyAnswerText("\\pm 1")).toBe("$\\pm 1$");
    expect(mathifyAnswerText("\\sqrt{2}+1")).toBe("$\\sqrt{2}+1$");
  });

  it("普通文本原样返回（不含命令不包 $）", () => {
    expect(mathifyAnswerText("-5/4")).toBe("-5/4");
    expect(mathifyAnswerText("8")).toBe("8");
    expect(mathifyAnswerText("x>0 且 x≠2")).toBe("x>0 且 x≠2");
  });

  it("已含 $ 的文本不二次包裹（T2.13 旧写法原样走管线，避免拆错定界符）", () => {
    expect(mathifyAnswerText("$\\frac{1}{2}$")).toBe("$\\frac{1}{2}$");
    expect(mathifyAnswerText("$x$ 与 $y$")).toBe("$x$ 与 $y$");
  });
});

describe("formatReferenceAnswers", () => {
  it("各题型参考答案文本化（填空等价答案用「或」连接）", () => {
    expect(formatReferenceAnswers({ kind: "judge", value: true })).toBe("对");
    expect(formatReferenceAnswers({ kind: "choice", index: 1 })).toBe("B");
    expect(formatReferenceAnswers({ kind: "multi", indexes: [2, 0] })).toBe(
      "AC",
    );
    expect(
      formatReferenceAnswers({
        kind: "fill",
        blanks: [["4"], ["0.5", "1/2"]],
      }),
    ).toBe("4；0.5 或 1/2");
    expect(formatReferenceAnswers({ kind: "final", answer: "-3" })).toBe("-3");
  });

  it("fill 逐个等价答案显示侧包 $：裸 LaTeX 包裹、普通写法原样，再 join「或/；」", () => {
    expect(
      formatReferenceAnswers({
        kind: "fill",
        blanks: [["-\\frac{5}{4}", "-5/4"], ["\\sqrt{2}"]],
      }),
    ).toBe("$-\\frac{5}{4}$ 或 -5/4；$\\sqrt{2}$");
    // T2.13 旧写法（答案里已写 $…$）不二次包裹，保持原样走管线
    expect(
      formatReferenceAnswers({
        kind: "fill",
        blanks: [["$\\frac{1}{2}$", "1/2"], ["8"]],
      }),
    ).toBe("$\\frac{1}{2}$ 或 1/2；8");
  });

  it("final 答案含裸 LaTeX 同样包 $；普通文本原样", () => {
    expect(formatReferenceAnswers({ kind: "final", answer: "x=\\pm 1" })).toBe(
      "$x=\\pm 1$",
    );
    expect(formatReferenceAnswers({ kind: "final", answer: "-3" })).toBe("-3");
  });
});

describe("withBlankValue", () => {
  it("稀疏数组扩容并写入指定空", () => {
    expect(withBlankValue([], 2, "7")).toEqual(["", "", "7"]);
    expect(withBlankValue(["4"], 0, "5")).toEqual(["5"]);
    expect(withBlankValue(["4", "-7"], 1, "-6")).toEqual(["4", "-6"]);
  });
});

describe("stemWithoutOptionList（选择题题干去掉选项任务列表）", () => {
  it("剥掉 - [ ] / - [x] / 1. [ ] 选项行，保留其余题干", () => {
    expect(
      stemWithoutOptionList(
        "$-5$ 的相反数是（　）\n\n- [ ] $-5$\n- [x] $5$\n* [X] 0",
      ),
    ).toBe("$-5$ 的相反数是（　）");
    expect(stemWithoutOptionList("下列正确的是\n1. [ ] 甲\n2) [x] 乙")).toBe(
      "下列正确的是",
    );
  });

  it("无任务列表的题干原样返回（普通列表与方括号不受影响）", () => {
    expect(stemWithoutOptionList("计算 $[1,2]$ 的长度")).toBe(
      "计算 $[1,2]$ 的长度",
    );
    expect(stemWithoutOptionList("已知：\n- 甲\n- 乙")).toBe(
      "已知：\n- 甲\n- 乙",
    );
  });
});
