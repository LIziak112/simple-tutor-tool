import { describe, expect, it } from "vitest";
import { equivalent, parseRational } from "./rational";

/**
 * 数值等价（§5.6 新增，旧版只有 normalize 全等）：
 * 简单有理数（整数/有限小数/分数/\frac）解析为 bigint 精确比较，0.5 = 1/2 = \frac{1}{2}。
 * 旧版没有的行为（科学计数法、百分数、表达式求值、循环小数）一律不支持，用测试锁定。
 */

describe("parseRational：简单有理数解析", () => {
  it("整数（含前导零）解析为分母 1 的有理数", () => {
    expect(parseRational("8")).toEqual({ num: 8n, denom: 1n });
    expect(parseRational("-3")).toEqual({ num: -3n, denom: 1n });
    expect(parseRational("08")).toEqual({ num: 8n, denom: 1n });
    expect(parseRational("+7")).toEqual({ num: 7n, denom: 1n });
  });

  it("有限小数（含 .5 与尾随零）解析为精确分数", () => {
    expect(parseRational("0.5")).toEqual({ num: 1n, denom: 2n });
    expect(parseRational(".5")).toEqual({ num: 1n, denom: 2n });
    expect(parseRational("-2.25")).toEqual({ num: -9n, denom: 4n });
    expect(parseRational("5.0")).toEqual({ num: 5n, denom: 1n });
    expect(parseRational("0.50")).toEqual({ num: 1n, denom: 2n });
  });

  it("分数 a/b（符号在分子、分母归正）", () => {
    expect(parseRational("1/2")).toEqual({ num: 1n, denom: 2n });
    expect(parseRational("-3/4")).toEqual({ num: -3n, denom: 4n });
    expect(parseRational("4/-8")).toEqual({ num: -1n, denom: 2n });
    expect(parseRational("6/3")).toEqual({ num: 2n, denom: 1n });
  });

  it("\\frac / \\dfrac（含分子带负号、整体带符号、省略花括号）", () => {
    expect(parseRational("\\frac{1}{2}")).toEqual({ num: 1n, denom: 2n });
    expect(parseRational("\\dfrac{1}{2}")).toEqual({ num: 1n, denom: 2n });
    expect(parseRational("\\frac{-1}{2}")).toEqual({ num: -1n, denom: 2n });
    expect(parseRational("-\\frac{1}{2}")).toEqual({ num: -1n, denom: 2n });
    expect(parseRational("\\frac12")).toEqual({ num: 1n, denom: 2n });
  });

  it("分母为 0（含 \\frac{1}{0}）返回 null，不抛异常", () => {
    expect(parseRational("1/0")).toBeNull();
    expect(parseRational("0/0")).toBeNull();
    expect(parseRational("\\frac{1}{0}")).toBeNull();
  });

  it("非简单有理数形态返回 null", () => {
    expect(parseRational("")).toBeNull();
    expect(parseRational("abc")).toBeNull();
    expect(parseRational("1e3")).toBeNull(); // 科学计数法不支持
    expect(parseRational("50%")).toBeNull(); // 百分数不支持（旧版无此规则）
    expect(parseRational("1+2")).toBeNull(); // 表达式不求值
    expect(parseRational("\\frac{\\frac{1}{2}}{3}")).toBeNull(); // 嵌套不支持
    expect(parseRational("\\frac{1}{2}米")).toBeNull(); // 带单位不是纯数值
    expect(parseRational("5.")).toBeNull(); // "5." 小数点后无数位不支持
    expect(parseRational("1 2")).toBeNull(); // 内嵌空白（未经 normalize 的原始输入）
  });

  it("超长数字串用 bigint 精确解析（浮点会失精度的量级）", () => {
    expect(parseRational("1000000000000000000000000")).toEqual({
      num: 1000000000000000000000000n,
      denom: 1n,
    });
    expect(parseRational("1000000000000000000000000/2")).toEqual({
      num: 500000000000000000000000n,
      denom: 1n,
    });
  });
});

describe("equivalent：答案等价比较（normalize 全等 → 数值等价）", () => {
  it("快路径：normalize 全等即等价（非数值文本的唯一路径）", () => {
    expect(equivalent("x = 1", "x=1")).toBe(true);
    expect(equivalent("$(-3)+7$", "\\left(-3\\right)+7")).toBe(true);
    expect(equivalent("x=1", "x=2")).toBe(false);
  });

  it("验收：\\frac{1}{2} = 0.5 = 1/2 = \\dfrac{1}{2} = .5（两两等价）", () => {
    const forms = ["0.5", "1/2", "\\frac{1}{2}", "\\dfrac{1}{2}", ".5", "0.50"];
    for (const a of forms) {
      for (const b of forms) {
        expect(equivalent(a, b)).toBe(true);
      }
    }
  });

  it("负数形态与全角/负号变体经 normalize 后数值等价", () => {
    expect(equivalent("－0.5", "-1/2")).toBe(true);
    expect(equivalent("−\\frac{1}{2}", "-0.5")).toBe(true);
    expect(equivalent("-\\dfrac{2}{4}", "0.5")).toBe(false); // -1/2 ≠ +0.5
  });

  it("大数与分数的 bigint 精确等价（浮点比较会失真）", () => {
    expect(equivalent("1000000000000000000000000/2", "500000000000000000000000")).toBe(true);
    expect(equivalent("1000000000000000000000001/2", "500000000000000000000000")).toBe(false);
  });

  it("有限小数与分数只在精确相等时等价（1/3 ≠ 0.333，含超长小数）", () => {
    expect(equivalent("1/3", "0.333")).toBe(false);
    expect(equivalent("1/3", "0.333333333333333333333333")).toBe(false);
    expect(equivalent("2/4", "0.5")).toBe(true); // 约分后相等
  });

  it("分母为 0 的两份写法：同文本全等成立、跨写法不构成数值等价", () => {
    expect(equivalent("1/0", "1/0")).toBe(true); // 全等路径
    expect(equivalent("1/0", "2/0")).toBe(false); // 双方 parse null，无数值等价
    expect(equivalent("\\frac{1}{0}", "1/0")).toBe(false);
  });

  it("一侧数值一侧非数值：仅当 normalize 全等", () => {
    expect(equivalent("8", "8米")).toBe(false);
    expect(equivalent("0.5", "1/2米")).toBe(false);
    expect(equivalent("1e3", "1e3")).toBe(true); // 都不支持 parse，但文本全等
  });
});
