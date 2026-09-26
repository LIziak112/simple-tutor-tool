import { describe, expect, it } from "vitest";
import { publicStemMd } from "./public-stem.ts";

/**
 * 题干公开化单测（T2.4 防泄露核心）：
 * - 填空/判断标记（含等价答案写法）替换为空标记 [[]]，答案文本不再出现；
 * - 数学环境（$…$ / $$…$$）与代码（行内/围栏）内的 [[…]] 是公式记号，原样保留；
 * - 与解析器语义一致：标记只在 text 节点识别；嵌套指令（如 :::tip）内的标记同样脱敏；
 * - 纯函数：无标记时原样返回。
 */
describe("publicStemMd（学生端公开题干）", () => {
  it("填空标记（含等价答案 | 分隔）替换为 [[]]，答案文本不再出现", () => {
    const stem =
      "计算：$(-3)+7=$ [[4]]；$(-2)+(-5)=$ [[-7]]。\n\n写等价形式：$0.5=$ [[0.5|1/2]]（填小数或分数均可）。";
    const pub = publicStemMd(stem);
    expect(pub).toBe(
      "计算：$(-3)+7=$ [[]]；$(-2)+(-5)=$ [[]]。\n\n写等价形式：$0.5=$ [[]]（填小数或分数均可）。",
    );
    for (const secret of ["[[4]]", "[[-7]]", "[[0.5|1/2]]", "0.5|1/2"]) {
      expect(pub).not.toContain(secret);
    }
  });

  it("判断题标记 [[正确]]/[[错误]] 同样脱敏（标记文本即答案）", () => {
    expect(publicStemMd("$0$ 既不是正数，也不是负数。[[正确]]")).toBe(
      "$0$ 既不是正数，也不是负数。[[]]",
    );
    expect(publicStemMd("$0$ 是正数。[[错误]]")).toBe("$0$ 是正数。[[]]");
  });

  it("数学环境内的 [[…]] 是公式记号，不脱敏（行内 / 代码下半标 / 块级）", () => {
    const stem = "观察下标记号：$a_{[[1]]}$ 与 $a_{[[2]]}$ 只是记号。";
    expect(publicStemMd(stem)).toBe(stem);

    const block = "区间表示为\n\n$$x \\in [[1,2]]$$\n\n如上。";
    expect(publicStemMd(block)).toBe(block);
  });

  it("代码（行内/围栏）内的 [[…]] 不脱敏（解析器不把它记为空位）", () => {
    const stem =
      "伪代码 `arr[[i]]` 与：\n\n```\nmatrix[[0, 0]] = 1\n```\n如上。";
    expect(publicStemMd(stem)).toBe(stem);
  });

  it("数学环境保留时，同段内真实空位仍被脱敏（混合场景）", () => {
    const stem = "$a_{[[1]]}$ 只是记号；若 $a_{1}=2$，则 $a_{1}=$ [[2]]。";
    expect(publicStemMd(stem)).toBe(
      "$a_{[[1]]}$ 只是记号；若 $a_{1}=2$，则 $a_{1}=$ [[]]。",
    );
  });

  it("题干内嵌套指令（:::tip 等）的文本同样脱敏；无标记时原样返回", () => {
    const stem = "填空：\n\n:::tip\n提示后作答：答案是 [[四十二]]。\n:::\n";
    expect(publicStemMd(stem)).toContain("[[]]");
    expect(publicStemMd(stem)).not.toContain("四十二");

    const plain = "解方程 $x+1=3$，写出过程。";
    expect(publicStemMd(plain)).toBe(plain);
  });
});
