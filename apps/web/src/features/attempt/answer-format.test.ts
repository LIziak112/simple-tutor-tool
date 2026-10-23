import { describe, expect, it } from "vitest";
import {
  attemptRoundLabel,
  attemptSourceLabel,
  formatReferenceAnswers,
  formatStudentAnswer,
  HANDWRITTEN_TYPES,
  isAnswered,
  letterOf,
  mathifyAnswerText,
  withBlankValue,
} from "./answer-format";

/** 作答展示纯函数测试（T2.6）：题型徽章口径见组件测试，这里锁文本化行为。 */

describe("HANDWRITTEN_TYPES（UA-01 起由契约 paperRole 派生）", () => {
  it("旧七型资格逐字不变：solve/apply/find-error", () => {
    expect([...HANDWRITTEN_TYPES].sort()).toEqual([
      "apply",
      "find-error",
      "solve",
    ]);
  });
});

describe("attemptRoundLabel（轮次标注按来源）", () => {
  it("course/wrong/assignment 既有文案 + lesson=第 n 次讲练（2026-10 讲练一体）", () => {
    expect(attemptRoundLabel("course", 2)).toBe("第 2 次课程练习");
    expect(attemptRoundLabel("wrong", 3)).toBe("错题重练 · 第 3 次组卷");
    expect(attemptRoundLabel("assignment", 1)).toBe("本次作业");
    // lesson：attemptNo 是该讲练页的开卷次数（restart 递增）
    expect(attemptRoundLabel("lesson", 2)).toBe("第 2 次讲练");
  });
});

describe("attemptSourceLabel（学生端来源行文案，2026-10 收口单源）", () => {
  const base = { attempt: { sourceType: "course", attemptNo: 2 } } as const;
  it("course 带课程名与次数；lesson 带讲义标题；wrong 带次数", () => {
    expect(
      attemptSourceLabel({ ...base, courseName: "初一上", title: "有理数" }),
    ).toBe("课程：初一上 · 第 2 次");
    expect(
      attemptSourceLabel({
        attempt: { sourceType: "lesson", attemptNo: 3 },
        courseName: null,
        title: "第1讲 有理数·讲练",
      }),
    ).toBe("讲练：第1讲 有理数·讲练 · 第 3 次");
    expect(
      attemptSourceLabel({
        attempt: { sourceType: "wrong", attemptNo: 5 },
        courseName: null,
        title: "错题组",
      }),
    ).toBe("错题重练 · 第 5 次");
  });
  it("assignment：挂课程「作业 · 课程名」，未挂只显示「作业」", () => {
    expect(
      attemptSourceLabel({
        attempt: { sourceType: "assignment", attemptNo: 1 },
        courseName: "初一上",
        title: "周末加练",
      }),
    ).toBe("作业 · 初一上");
    expect(
      attemptSourceLabel({
        attempt: { sourceType: "assignment", attemptNo: 1 },
        courseName: null,
        title: "周末加练",
      }),
    ).toBe("作业");
  });
});

describe("letterOf", () => {
  it("下标转字母（0→A、2→C）", () => {
    expect(letterOf(0)).toBe("A");
    expect(letterOf(2)).toBe("C");
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
