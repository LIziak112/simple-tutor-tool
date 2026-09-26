import { describe, expect, it } from "vitest";
import { judgeOf, normalize } from "./normalize";

/**
 * 行为基线：旧版契约 docs/01_任务安排与契约.md §5 与旧版前端实现
 * （public/js/app.js normalize/judgeOf，b4ee184），逐条规则正反例对齐。
 */

describe("normalize：归一化规则（旧版 §5 逐条）", () => {
  describe("NFKC 规格化", () => {
    it("全角字母数字转半角", () => {
      expect(normalize("ＡＢ１２３")).toBe("AB123");
    });
    it("全角等号/括号/句号等兼容字符转半角形式", () => {
      expect(normalize("（１）")).toBe("(1)");
      expect(normalize("１．５")).toBe("1.5");
      expect(normalize("甲＝乙")).toBe("甲=乙");
    });
    it("全角空格经 NFKC 转半角后被去空白规则移除", () => {
      expect(normalize("1　000")).toBe("1000");
    });
    it("反例：NFKC 不改动的字符（汉字、×、原文半角）原样保留", () => {
      expect(normalize("甲乙")).toBe("甲乙");
      expect(normalize("a-b")).toBe("a-b");
    });
  });

  describe("去掉全部空白", () => {
    it("空格/制表/换行/回车全去", () => {
      expect(normalize("1 2\t3\n4\r5")).toBe("12345");
    });
    it("去空白发生在 NFKC 之后（全角空格先转半角再删）", () => {
      expect(normalize(" x = 1 ")).toBe("x=1");
    });
    it("纯空白输入得到空串", () => {
      expect(normalize("  \t \n ")).toBe("");
    });
    it("反例：去空白不吞非空白字符，剩余字符原样拼接", () => {
      expect(normalize("x = 1")).toBe("x=1");
      expect(normalize("a b")).toBe("ab");
    });
  });

  describe("形近负号统一为半角 -（验收：负号变体）", () => {
    // ﹣ U+FE63 / － U+FF0D / – U+2013 / — U+2014 / − U+2212
    it.each(["﹣5", "－5", "–5", "—5", "−5"])("%s 统一为 -5", (input) => {
      expect(normalize(input)).toBe("-5");
    });
    it("负号变体出现在公式中间同样替换", () => {
      expect(normalize("(-3)+(−7)")).toBe("(-3)+(-7)");
    });
    it("反例：半角负号本身不变，其他运算符（+×÷）不受影响", () => {
      expect(normalize("-5")).toBe("-5");
      expect(normalize("3×4")).toBe("3×4");
    });
  });

  describe("去掉 $ 与 \\left \\right", () => {
    it("首尾 $ 定界符移除", () => {
      expect(normalize("$\\frac{1}{2}$")).toBe("\\frac{1}{2}");
    });
    it("行内多个 $ 全部移除", () => {
      expect(normalize("$a$ 和 $b$")).toBe("a和b");
    });
    it("\\left \\right 移除但括号保留", () => {
      expect(normalize("\\left(1+2\\right)\\times 3")).toBe("(1+2)\\times3");
    });
    it("反例：不含这些标记的字符串不动", () => {
      expect(normalize("(1+2)")).toBe("(1+2)");
    });
  });

  describe("首尾 trim", () => {
    it("首尾空白移除（此时已无空白，规则保留以与旧版一致）", () => {
      expect(normalize(" 8 ")).toBe("8");
    });
  });

  describe("组合场景", () => {
    it("旧版样例：$ 5−(−3)=$ __ 等混合输入", () => {
      expect(normalize("$ 5−(−3) $")).toBe("5-(-3)");
    });
    it("\\left \\right 与 $ 混合", () => {
      expect(normalize("$\\left(-3\\right)+7$")).toBe("(-3)+7");
    });
    it("空串/undefined 入参得到空串（防御，与旧版 String(s==null?'':s) 一致）", () => {
      expect(normalize("")).toBe("");
      expect(normalize(undefined)).toBe("");
    });
  });
});

describe("judgeOf：判断题写法归一化（旧版 §5 全集）", () => {
  it("正确集：{正确,对,√,✔,T,TRUE,是} → '正确'", () => {
    for (const text of ["正确", "对", "√", "✔", "T", "TRUE", "是"]) {
      expect(judgeOf(text)).toBe("正确");
    }
  });

  it("错误集：{错误,错,×,✘,F,FALSE,否} → '错误'", () => {
    for (const text of ["错误", "错", "×", "✘", "F", "FALSE", "否"]) {
      expect(judgeOf(text)).toBe("错误");
    }
  });

  it("大小写与全角变体：小写 true/false、全角 Ｔ 同样识别", () => {
    expect(judgeOf("true")).toBe("正确");
    expect(judgeOf("false")).toBe("错误");
    expect(judgeOf("Ｔ")).toBe("正确");
    expect(judgeOf("ｆ")).toBe("错误");
  });

  it("写法两侧的空白与 $ 定界被归一化忽略", () => {
    expect(judgeOf(" 对 ")).toBe("正确");
    expect(judgeOf("$√$")).toBe("正确");
  });

  it("空串或无法识别的写法返回 null", () => {
    expect(judgeOf("")).toBeNull();
    expect(judgeOf("   ")).toBeNull();
    expect(judgeOf("对错")).toBeNull();
    expect(judgeOf("maybe")).toBeNull();
    expect(judgeOf("正确。")).toBeNull();
  });
});
