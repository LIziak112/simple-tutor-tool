import type { QuestionPublic } from "@tutor/contract";
import { processor } from "@tutor/md-dsl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getQuestionCompletion } from "../attempt/question-completion";
import {
  analyzeSlots,
  expectedSlotCountOf,
  prepareQuestion,
  slotsOfQuestion,
} from "./prepare-question";

/**
 * 槽位结构分析与公开题目派生模型测试（方案 §4.2/§8.1，UA-02）：
 * - analyzeSlots 复用渲染管线节点语义（processor + remarkBlank +
 *   remarkDirectiveHost）：数学/代码环境不识别、显式 :blank[] 与 [[…]] 同计、
 *   跨段落编号连续（I07 语料变体——槽位计数与顺序不漂移）；
 * - WeakMap 对象身份缓存：同一题目对象答案变化不重复解析（I13）；
 * - prepareQuestion 字段白名单：只挑公开内容，禁 {...fullQuestion} 展开；
 * - expectedSlotCountOf 与旧 countSlots 口径逐字一致（空位编号最大值）。
 *
 * 语料来源（TT-01 冻结交付物，stemMd 为服务端 studentStemMd 脱敏投影形态）：
 * - 语料/valid-08-旧七型混合题.md fill 题（3 空，公式段间空位）；
 * - 语料/valid-01-资料分析五题.md zl-4（1 空）；
 * - 既有 question-completion 测试语料（数学/代码/显式 blank）。
 */

/** 语料 valid-08 fill 题：studentStemMd 投影把 [[-8]] 等脱敏成 [[]] */
const VALID08_FILL_STEM = "计算：$(-2)^3=$ [[]]；$-3^2=$ [[]]；$|-4|+(-1)^{10}=$ [[]]。";

/** 语料 valid-01 zl-4：[[60.0|60]] 脱敏后单空 */
const VALID01_ZL4_STEM =
  "2021—2025 年五年间，该省粮食总产量平均每年约增产 [[]] 万吨（保留一位小数）。";

/** 既有 question-completion 测试语料：行内代码与数学环境不识别，显式 blank 计入 */
const CODE_MATH_STEM = "`[[]]` $[[]]$\n\n:blank[] 和 **[[]]**";

const baseQuestion: QuestionPublic = {
  id: "q",
  type: "fill",
  difficulty: 1,
  knowledge: [],
  stemMd: "甲 [[]]，乙 [[]]",
  hintCount: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analyzeSlots（§8.1 槽位结构分析）", () => {
  it("语料 valid-08 fill 题：3 空有序（公式段间空位照常计数）", () => {
    expect(analyzeSlots(VALID08_FILL_STEM)).toEqual([
      { slotId: "slot-1", slotKind: "text", order: 0 },
      { slotId: "slot-2", slotKind: "text", order: 1 },
      { slotId: "slot-3", slotKind: "text", order: 2 },
    ]);
  });

  it("语料 valid-01 zl-4：单空", () => {
    expect(analyzeSlots(VALID01_ZL4_STEM)).toEqual([
      { slotId: "slot-1", slotKind: "text", order: 0 },
    ]);
  });

  it("数学与代码中的标记不计，显式 blank 计入且按文档顺序编号（I07）", () => {
    // :blank[] 在 **[[]]** 之前 → order 0；行内代码与 $…$ 内的 [[]] 不产生槽位
    expect(analyzeSlots(CODE_MATH_STEM)).toEqual([
      { slotId: "slot-1", slotKind: "text", order: 0 },
      { slotId: "slot-2", slotKind: "text", order: 1 },
    ]);
  });

  it("跨段编号保留：多段落空位连续编号、顺序不漂移（计数器上传修复的口径）", () => {
    expect(
      analyzeSlots("甲 [[a]]。\n\n乙 [[b]]，丙 [[c]]。").map((s) => s.order),
    ).toEqual([0, 1, 2]);
    expect(analyzeSlots("无空位题干")).toEqual([]);
  });
});

describe("slotsOfQuestion（WeakMap 对象身份缓存，I13）", () => {
  it("同一题目对象重复查询只解析一次；答案变化不重准备", () => {
    const parse = vi.spyOn(processor, "parse");
    const question = { ...baseQuestion, stemMd: VALID08_FILL_STEM };
    const first = slotsOfQuestion(question);
    const second = slotsOfQuestion(question);
    expect(second).toBe(first); // 缓存命中（对象身份）
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("不同对象即使同文也按对象身份重新解析（缓存不按内容哈希）", () => {
    const parse = vi.spyOn(processor, "parse");
    slotsOfQuestion({ ...baseQuestion, stemMd: "甲 [[]]" });
    slotsOfQuestion({ ...baseQuestion, stemMd: "甲 [[]]" });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("经 getQuestionCompletion 调用同源：同对象不同答案只解析一次", () => {
    const parse = vi.spyOn(processor, "parse");
    const question = { ...baseQuestion, stemMd: "甲 [[]]，乙 [[]]，丙 [[]]" };
    getQuestionCompletion(question, { kind: "fill", values: ["1"] });
    getQuestionCompletion(question, { kind: "fill", values: ["1", "2", "3"] });
    getQuestionCompletion(question, undefined);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

describe("expectedSlotCountOf（旧 countSlots 口径逐字一致）", () => {
  it("空列表为 0；正常连续编号等于槽位个数", () => {
    expect(expectedSlotCountOf([])).toBe(0);
    expect(
      expectedSlotCountOf(analyzeSlots(VALID08_FILL_STEM)),
    ).toBe(3);
  });

  it("病理性重复编号取编号最大值（不按个数虚报）", () => {
    // 嵌套 question 指令重置空位计数的历史内容：两空都编号 1 → 预期空位 1
    expect(
      expectedSlotCountOf([
        { slotId: "slot-1", slotKind: "text", order: 0 },
        { slotId: "slot-1", slotKind: "text", order: 0 },
      ]),
    ).toBe(1);
  });
});

describe("prepareQuestion（公开内容→PreparedQuestion，§4.2）", () => {
  it("judge：题干 + 尾部空标记展示方式", () => {
    const prepared = prepareQuestion(
      { ...baseQuestion, type: "judge", stemMd: "命题。[[正确]]" },
      "s-judge",
    );
    // stemMd 是服务端投影后的公开题干；本函数不感知脱敏，只检测尾部 [[]]
    const desensitized = prepareQuestion(
      { ...baseQuestion, type: "judge", stemMd: "命题。[[]]" },
      "s-judge",
    );
    expect(prepared).toEqual({
      kind: "judge",
      scopeId: "s-judge",
      stemMd: "命题。[[正确]]",
      tailMarker: "none",
    });
    expect(desensitized).toEqual({
      kind: "judge",
      scopeId: "s-judge",
      stemMd: "命题。[[]]",
      tailMarker: "paren",
    });
    // 尾部带空白仍识别（与 QuestionSurface judgeStemOf 的替换正则同口径）
    const padded = prepareQuestion(
      { ...baseQuestion, type: "judge", stemMd: "命题。[[]]  " },
      "s",
    );
    if (padded.kind !== "judge") throw new Error("应为 judge 模型");
    expect(padded.tailMarker).toBe("paren");
  });

  it("choice/multi：选项项 {key,index,text}，key 由序号派生（重复文本不冲突）", () => {
    const withOptions = {
      ...baseQuestion,
      type: "choice" as const,
      options: ["相同选项文本", "相同选项文本"],
    };
    const prepared = prepareQuestion(withOptions, "s-choice");
    if (prepared.kind !== "choice") throw new Error("应为 choice 模型");
    expect(prepared).toEqual({
      kind: "choice",
      scopeId: "s-choice",
      stemMd: withOptions.stemMd,
      options: [
        { key: "opt-0", index: 0, text: "相同选项文本" },
        { key: "opt-1", index: 1, text: "相同选项文本" },
      ],
    });
    expect(
      prepareQuestion({ ...withOptions, type: "multi" }, "s-multi"),
    ).toEqual({
      kind: "multi",
      scopeId: "s-multi",
      stemMd: withOptions.stemMd,
      options: prepared.options,
    });
    // 无 options 字段的旧题：空选项集
    const { options: _omitted, ...noOptions } = {
      ...baseQuestion,
      type: "choice" as const,
    };
    void _omitted;
    const noOptionsPrepared = prepareQuestion(noOptions, "s");
    if (noOptionsPrepared.kind !== "choice") throw new Error("应为 choice 模型");
    expect(noOptionsPrepared.options).toEqual([]);
  });

  it("fill：槽位与 slotsOfQuestion 同源（缓存数组身份复用，I13 不重准备）", () => {
    const question = { ...baseQuestion, stemMd: VALID08_FILL_STEM };
    const first = prepareQuestion(question, "s-fill");
    const second = prepareQuestion(question, "s-fill-2");
    expect(first.kind).toBe("fill");
    if (first.kind !== "fill" || second.kind !== "fill") {
      throw new Error("fill 准备模型应保持 kind=fill");
    }
    expect(first.slots).toEqual(analyzeSlots(VALID08_FILL_STEM));
    expect(second.slots).toBe(first.slots); // WeakMap 缓存身份复用
    // 带 options 的题面不把 options 带入 fill 模型（白名单）
    expect("options" in first).toBe(false);
  });

  it("final：既有最终答案输入描述", () => {
    expect(
      prepareQuestion({ ...baseQuestion, type: "solve" }, "s-final"),
    ).toEqual({
      kind: "final",
      scopeId: "s-final",
      stemMd: baseQuestion.stemMd,
      finalInput: { label: "最终答案" },
    });
  });

  it("字段白名单：键集恰为各形态挑选的公开字段，禁 {...fullQuestion} 展开", () => {
    const full: QuestionPublic = {
      ...baseQuestion,
      type: "choice",
      options: ["甲", "乙"],
      stemMd: "题干",
    };
    const cases: readonly [QuestionPublic, readonly string[]][] = [
      [{ ...full, type: "judge" }, ["kind", "scopeId", "stemMd", "tailMarker"]],
      [full, ["kind", "scopeId", "stemMd", "options"]],
      [{ ...full, type: "multi" }, ["kind", "scopeId", "stemMd", "options"]],
      [{ ...full, type: "fill" }, ["kind", "scopeId", "stemMd", "slots"]],
      [{ ...full, type: "solve" }, ["kind", "scopeId", "stemMd", "finalInput"]],
    ];
    for (const [question, keys] of cases) {
      expect(Object.keys(prepareQuestion(question, "s")).sort()).toEqual(
        [...keys].sort(),
      );
    }
  });

  it("context 引用：不传不设键；传入只增 context 键（只存引用不复制内容）", () => {
    const without = prepareQuestion(full1(), "s");
    expect("context" in without).toBe(false);
    const withCtx = prepareQuestion(full1(), "s", { materialIds: ["mat-1"] });
    expect(withCtx).toMatchObject({
      kind: "choice",
      context: { materialIds: ["mat-1"] },
    });
    expect(Object.keys(withCtx).sort()).toEqual(
      ["context", "kind", "options", "scopeId", "stemMd"].sort(),
    );
  });

  it("scopeId 由宿主提供，不在准备过程生成或覆盖", () => {
    expect(prepareQuestion(full1(), "host-scope").scopeId).toBe("host-scope");
    expect(prepareQuestion(full1(), "another").scopeId).toBe("another");
  });
});

function full1(): QuestionPublic {
  return { ...baseQuestion, type: "choice", options: ["甲", "乙"] };
}
