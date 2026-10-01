import { describe, expect, it } from "vitest";
import { analyzeLectureStructure } from "./lecture-structure";

/**
 * 讲义结构分析测试（T4.0b，方案 §4.4.2 前提 2「分母来自服务端解析」）：
 * 每节字数（expectedSec 的输入）、可折叠指令归属节（hostHeadingIndex）、
 * steps 容器总步数、文档全局指令序号 docIndex——与前端 remarkDirectiveHost
 * 的 dindex 同一规则（全部块级指令按文档顺序预序计数、行内指令不计），
 * 供 directive_interact 的 (name, index) 定位回具体指令。
 */

const MD = [
  "# 第1讲 有理数",
  "",
  "引入文字：相反意义的量。",
  "",
  "## 一、正数与负数",
  "",
  "收入 $500$ 元与支出 $300$ 元。",
  "",
  "$$",
  "a + b = c",
  "$$",
  "",
  ":::fold{title=\"拓展\"}",
  "折叠内容甲。",
  ":::",
  "",
  "### 1.1 相反数",
  "",
  '::::example{title="例 1"}',
  "指出正数。",
  "",
  ":::solution",
  "正数：$+7$。",
  ":::",
  "::::",
  "",
  "## 二、有理数的分类",
  "",
  "整数与分数。",
  "",
  "::::steps",
  ":::step{title=\"第 1 步\"}",
  "先处理乘方。",
  ":::",
  ":::step",
  "再算乘除。",
  ":::",
  ":::step",
  "最后合并。",
  ":::",
  "::::",
  "",
  ":::hint",
  "讲义提示内容。",
  ":::",
].join("\n");

describe("analyzeLectureStructure", () => {
  const structure = analyzeLectureStructure(MD);

  it("标题序列与 hostHeadingIndex（H2/H3 文档序，0 起）", () => {
    expect(
      structure.sections.map((s) => [s.headingIndex, s.level, s.text]),
    ).toEqual([
      [0, 2, "一、正数与负数"],
      [1, 3, "1.1 相反数"],
      [2, 2, "二、有理数的分类"],
    ]);
  });

  it("可折叠指令（fold/solution/hint）各一行，docIndex 为文档全局指令序号", () => {
    // 全局序（块级预序）：fold=1、example=2、solution=3、steps=4、step=5/6/7、hint=8
    expect(
      structure.folds.map((f) => [f.docIndex, f.name, f.hostHeadingIndex]),
    ).toEqual([
      [1, "fold", 0],
      [3, "solution", 1], // example 内的 solution 同样计入（§4.4.2(b)）
      [8, "hint", 2],
    ]);
  });

  it("steps 容器：docIndex 与总步数（total 来自服务端解析）", () => {
    expect(structure.steps).toEqual([
      { docIndex: 4, hostHeadingIndex: 2, totalSteps: 3 },
    ]);
  });

  it("每节字数：普通文字计满、公式段打折、标题行不计", () => {
    const [s0, s1, s2] = structure.sections;
    // 第 0 节正文：中文文字（收入元与支出元。+ 折叠内容甲。）+ 行内公式 500/300 + 公式块 a+b=c
    expect(s0?.charCount).toBeGreaterThan(10);
    expect(s1?.charCount).toBeGreaterThan(0);
    expect(s2?.charCount).toBeGreaterThan(0);
    // 公式占比高的节 charCount 低于其原文非空白字符数（打折生效的粗校验）
    const section0Raw = MD.split("## 一、正数与负数")[1]?.split("### 1.1")[0] ?? "";
    const rawNonWs = section0Raw.replace(/\s/g, "").length;
    expect(s0?.charCount).toBeLessThanOrEqual(rawNonWs);
  });

  it("无标题/无指令的讲义：空结构不抛错", () => {
    const empty = analyzeLectureStructure("# 标题\n\n正文一段。");
    expect(empty.sections).toEqual([]);
    expect(empty.folds).toEqual([]);
    expect(empty.steps).toEqual([]);
  });

  it("标题前出现指令：hostHeadingIndex 收敛到 0（首节）", () => {
    const s = analyzeLectureStructure(
      ["# 第1讲", "", ":::fold", "开头折叠", ":::", "", "## 第一节", "", "正文"].join("\n"),
    );
    expect(s.folds).toEqual([
      { docIndex: 1, name: "fold", hostHeadingIndex: 0, innerCharCount: expect.any(Number) },
    ]);
  });
});
