/**
 * 数值等价（§5.6 在旧版 normalize 全等之上新增的能力）：
 * 把整数 / 有限小数 / 分数（1/2）/ LaTeX 分数（\frac{1}{2}、\dfrac{1}{2}）解析为
 * bigint 精确有理数后比较，使 0.5 = 1/2 = \frac{1}{2} 成立。
 *
 * 边界约定（均有测试锁定）：
 * - 分母为 0（1/0、\frac{1}{0}）不是有效有理数，返回 null（不抛异常）；
 * - 只做精确比较：1/3 ≠ 0.333…（有限位小数不等于无限循环小数），超长数字串靠 bigint 不失真；
 * - 不支持科学计数法（1e3）、百分数（50%）、表达式（1+2）、嵌套 \frac、带单位（8米）——
 *   旧版没有这些等价规则，本包不发明（见任务报告「待决问题」）；
 * - parseRational 只接受已 normalize 的字符串（去空白/负号统一后），调用方负责先归一化。
 */

import { normalize } from "./normalize.ts";

/** 有理数：denom 恒为正，符号归入 num，已约分（比较可直接判等） */
export interface Rational {
  readonly num: bigint;
  readonly denom: bigint;
}

/** 整数或分数：`[+-]?\d+` / `[+-]?\d+\/[+-]?\d+`（分数限定整数比整数） */
const PLAIN_RE = /^([+-]?)(\d+)(?:\/([+-]?)(\d+))?$/;

/** 有限小数：`[+-]?\d+\.\d+` 或 `[+-]?\.\d+`（小数点后必须有数位，"5." 不支持） */
const DECIMAL_RE = /^([+-]?)(\d+)\.(\d+)$|^([+-]?)\.(\d+)$/;

/** LaTeX 分数：\frac 或 \dfrac，分子/分母各为一个 {带符号整数} 或单数字字符（\frac12 省略花括号） */
const LATEX_FRAC_RE = /^([+-]?)\\d?frac(\{([+-]?\d+)\}|\d)(\{([+-]?\d+)\}|\d)$/;

/** bigint 最大公约数（绝对值），入参非零由调用方保证 */
function gcdAbs(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y > 0n) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x;
}

/** 组装并约分：符号归入 num、denom 归正；denom 为 0 返回 null（分母非法） */
function makeRational(rawNum: bigint, rawDenom: bigint): Rational | null {
  if (rawDenom === 0n) return null;
  const negative = rawNum < 0n !== rawDenom < 0n; // 异号为负
  const numAbs = rawNum < 0n ? -rawNum : rawNum;
  const denomAbs = rawDenom < 0n ? -rawDenom : rawDenom;
  const g = gcdAbs(numAbs, denomAbs);
  return {
    num: (negative ? -1n : 1n) * (numAbs / g),
    denom: denomAbs / g,
  };
}

/** 符号字符转 bigint 乘子（"+" 或 "" → 1，"-" → -1） */
function signOf(sign: string | undefined): bigint {
  return sign === "-" ? -1n : 1n;
}

/** 省略花括号形式的 token（如 \frac12 的 "1"/"2"）必须是单个数字字符，否则非法 */
function singleDigit(token: string | undefined): string | null {
  if (token !== undefined && /^\d$/.test(token)) return token;
  return null;
}

/**
 * 解析已 normalize 的简单有理数字符串：
 * 整数（8、-3、08）、有限小数（0.5、.5、-2.25）、分数（1/2、4/-8）、
 * LaTeX 分数（\frac{1}{2}、\dfrac{1}{2}、\frac12、-\frac{1}{2}）。
 * 非上述形态（含空串、表达式、科学计数法、嵌套、带单位）返回 null。
 */
export function parseRational(input: string): Rational | null {
  // 分支一：整数或整数分数
  const plain = PLAIN_RE.exec(input);
  if (plain) {
    const [, numSign, numText, denomSign, denomText] = plain;
    if (numText === undefined) return null; // 正则保证必填组，防御不可达
    const num = signOf(numSign) * BigInt(numText);
    const denom =
      denomText === undefined ? 1n : signOf(denomSign) * BigInt(denomText);
    return makeRational(num, denom);
  }

  // 分支二：有限小数（两种书写形态分开捕获）
  const decimal = DECIMAL_RE.exec(input);
  if (decimal) {
    if (decimal[2] !== undefined) {
      // 形如 d+.d+（如 0.50）
      const frac = decimal[3] ?? "";
      const num = signOf(decimal[1]) * BigInt(`${decimal[2]}${frac}`);
      return makeRational(num, 10n ** BigInt(frac.length));
    }
    // 形如 .d+（如 .5）
    const frac = decimal[5] ?? "";
    const num = signOf(decimal[4]) * BigInt(frac);
    return makeRational(num, 10n ** BigInt(frac.length));
  }

  // 分支三：LaTeX 分数（\frac/\dfrac，分子/分母为 {整数} 或单数字字符）
  const latex = LATEX_FRAC_RE.exec(input);
  if (latex) {
    const [, sign, numTokenRaw, numDigits, denomTokenRaw, denomDigits] = latex;
    const numText = numDigits ?? singleDigit(numTokenRaw);
    const denomText = denomDigits ?? singleDigit(denomTokenRaw);
    if (numText === null || denomText === null) return null; // 防御不可达
    return makeRational(signOf(sign) * BigInt(numText), BigInt(denomText));
  }

  return null;
}

/**
 * 答案等价比较（判分的单空比较基础）：
 * 1. 快路径：normalize 后文本全等（非数值答案的唯一判等途径）；
 * 2. 数值等价：双方都可解析为简单有理数时，比较约分结果（0.5 = 1/2 = \frac{1}{2}）。
 */
export function equivalent(
  studentAnswer: string,
  expectedAnswer: string,
): boolean {
  const s = normalize(studentAnswer);
  const e = normalize(expectedAnswer);
  if (s === e) return true;
  const rs = parseRational(s);
  const re = parseRational(e);
  return (
    rs !== null && re !== null && rs.num === re.num && rs.denom === re.denom
  );
}
