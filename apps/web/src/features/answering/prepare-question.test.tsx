import { render } from "@testing-library/react";
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
const VALID08_FILL_STEM =
  "计算：$(-2)^3=$ [[]]；$-3^2=$ [[]]；$|-4|+(-1)^{10}=$ [[]]。";

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

  // React rerender 级调用计数（审查 P2-1）：函数级「同对象重复调用」之上，
  // 补组件 rerender 不重复解析的断言——模拟 UA-03 呈现层消费形态：
  // 组件体内经 slotsOfQuestion 取槽位，作答（values）变化引发 rerender
  // 而题对象身份不变。渲染计数证 rerender 非空转（组件体确实重新执行）。
  it("作答态变化引发组件 rerender：同一题对象不重复解析（I13）", () => {
    const parse = vi.spyOn(processor, "parse");
    const question = { ...baseQuestion, stemMd: "甲 [[]]，乙 [[]]" };
    let renders = 0;
    function SlotsProbe({ values }: { values: readonly string[] }) {
      renders += 1;
      const slots = slotsOfQuestion(question);
      return (
        <output
          data-testid="slots"
          data-count={slots.length}
          data-filled={values.filter((v) => v.trim() !== "").length}
        />
      );
    }
    const view = render(<SlotsProbe values={["1"]} />);
    expect(parse).toHaveBeenCalledTimes(1);
    view.rerender(<SlotsProbe values={["1", "2"]} />);
    view.rerender(<SlotsProbe values={[]} />);
    expect(renders).toBe(3); // 3 次渲染均执行组件体，非 React 空转跳过
    expect(view.getByTestId("slots").getAttribute("data-count")).toBe("2");
    expect(view.getByTestId("slots").getAttribute("data-filled")).toBe("0");
    expect(parse).toHaveBeenCalledTimes(1); // 同一题对象：rerender 不重解析
  });
});

describe("expectedSlotCountOf（旧 countSlots 口径逐字一致）", () => {
  it("空列表为 0；正常连续编号等于槽位个数", () => {
    expect(expectedSlotCountOf([])).toBe(0);
    expect(expectedSlotCountOf(analyzeSlots(VALID08_FILL_STEM))).toBe(3);
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
    if (noOptionsPrepared.kind !== "choice")
      throw new Error("应为 choice 模型");
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

  it("response：开放作答模型携带字数提示（QM-09，白名单只挑公开字段）", () => {
    const withHints = prepareQuestion(
      {
        ...baseQuestion,
        type: "response",
        wordMin: 150,
        wordMax: 250,
        stemMd: "根据给定资料，概括主要特点。",
      },
      "s-resp",
    );
    expect(withHints).toEqual({
      kind: "response",
      scopeId: "s-resp",
      stemMd: "根据给定资料，概括主要特点。",
      wordMin: 150,
      wordMax: 250,
    });
    // 无字数提示的题：两键缺省不携带（旧键集不变）
    const bare = prepareQuestion(
      { ...baseQuestion, type: "response" },
      "s-resp-2",
    );
    expect(bare).toEqual({
      kind: "response",
      scopeId: "s-resp-2",
      stemMd: baseQuestion.stemMd,
    });
  });

  it("matching/ordering 真实构造（QM-13 转正）：选项池+展开槽位/排序项进模型；结构缺失走空结构防御形态", () => {
    const matching = prepareQuestion(
      {
        ...baseQuestion,
        type: "matching",
        matchingOptions: {
          allowRepeat: false,
          options: [
            { id: "opt-1", text: "甲" },
            { id: "opt-2", text: "乙" },
          ],
        },
        matchingSlots: ["slot-1", "slot-2"],
      },
      "s-m",
    );
    expect(matching).toEqual({
      kind: "matching",
      scopeId: "s-m",
      stemMd: baseQuestion.stemMd,
      options: [
        { key: "opt-1", text: "甲" },
        { key: "opt-2", text: "乙" },
      ],
      slotIds: ["slot-1", "slot-2"],
      allowRepeat: false,
    });
    const ordering = prepareQuestion(
      {
        ...baseQuestion,
        type: "ordering",
        orderingItems: [
          { id: "it-1", text: "甲", fixedPosition: null },
          { id: "it-2", text: "乙", fixedPosition: 1 },
        ],
        sortableCount: 1,
      },
      "s-o",
    );
    expect(ordering).toEqual({
      kind: "ordering",
      scopeId: "s-o",
      stemMd: baseQuestion.stemMd,
      items: [
        { key: "it-1", text: "甲", fixedPosition: null },
        { key: "it-2", text: "乙", fixedPosition: 1 },
      ],
      sortableCount: 1,
    });
    // 结构缺失（服务端投影防御形态）：空池空槽，视图显式报错不静默降级
    expect(
      prepareQuestion({ ...baseQuestion, type: "matching" }, "s-m2"),
    ).toEqual({
      kind: "matching",
      scopeId: "s-m2",
      stemMd: baseQuestion.stemMd,
      options: [],
      slotIds: [],
      allowRepeat: false,
    });
    expect(
      prepareQuestion({ ...baseQuestion, type: "ordering" }, "s-o2"),
    ).toEqual({
      kind: "ordering",
      scopeId: "s-o2",
      stemMd: baseQuestion.stemMd,
      items: [],
      sortableCount: 0,
    });
    // sortableCount 缺失（半结构态）= 结构不可用，同走防御形态（审查 P1：
    // 学生面无逐项干扰标记，缺计数则板行数/完成度无从派生）
    expect(
      prepareQuestion(
        {
          ...baseQuestion,
          type: "ordering",
          orderingItems: [{ id: "it-1", text: "甲", fixedPosition: null }],
        },
        "s-o3",
      ),
    ).toEqual({
      kind: "ordering",
      scopeId: "s-o3",
      stemMd: baseQuestion.stemMd,
      items: [],
      sortableCount: 0,
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
      [
        { ...full, type: "response", wordMin: 10, wordMax: 20 },
        ["kind", "scopeId", "stemMd", "wordMin", "wordMax"],
      ],
      [
        {
          ...full,
          type: "matching",
          matchingOptions: {
            allowRepeat: false,
            options: [{ id: "opt-1", text: "甲" }],
          },
          matchingSlots: ["slot-1"],
        },
        ["kind", "scopeId", "stemMd", "options", "slotIds", "allowRepeat"],
      ],
      [
        {
          ...full,
          type: "ordering",
          orderingItems: [{ id: "it-1", text: "甲", fixedPosition: null }],
          sortableCount: 1,
        },
        ["kind", "scopeId", "stemMd", "items", "sortableCount"],
      ],
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
