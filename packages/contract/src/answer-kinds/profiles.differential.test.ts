import { describe, expect, it } from "vitest";
import { lettersOf } from "../content.ts";
import type { StudentAnswer } from "../grading.ts";
import {
  dispatchBehavior,
  dispatchIsAnswered,
  emptyPublicStructure,
  type OptionsPublicStructure,
  optionsPublicStructureOf,
  type PublicStructureByKind,
} from "./index.ts";

/**
 * I15 三口径差分测试：登记表 dispatchBehavior/dispatchIsAnswered vs 迁移前
 * 三个现网实现（副本夹具，逐字转录自 UA-01 迁移前的生产代码；UA-05 清理
 * 重复实现时一并移除本夹具的必要性重估）。对照来源：
 * - display：apps/web/src/features/attempt/answer-format.ts
 *   isAnswered / formatStudentAnswer（迁移前 switch 正文）；
 * - teacher-queue：apps/server/src/services/mark-response.ts
 *   serializeStudentAnswer + optionLabel（迁移前 switch 正文）；
 * - ai-context：apps/server/src/services/ai-companion/student-ai-context.ts
 *   studentAnswerTextOf + optionTextOf（迁移前 switch 正文）。
 *
 * 语料来源：docs/题目模型与练习适配/语料/valid-08-旧七型混合题.md（七型语料
 * 的选项正文/空数转录为夹具常量——contract 不反向依赖 md-dsl 解析器，运行时
 * 解析语料不可行；语料为 TT-01 冻结交付物，内容稳定）。
 *
 * null/undefined 无答案不在登记表口径内（由三兼容入口处理：展示「未作答」、
 * 队列与 AI 保持原 null），差分只覆盖非空 StudentAnswer；空值边界（空字符串、
 * 空数组、空白串）在矩阵内。
 */

// ---------- 旧实现副本（差分夹具；逐字转录，勿改动——改了就失去对照意义） ----------

/** answer-format judgeLabelOf */
function oldJudgeLabelOf(value: boolean | string): string {
  if (typeof value === "boolean") return value ? "对" : "错";
  return value;
}

/** answer-format isAnswered（迁移前） */
function oldIsAnswered(answer: StudentAnswer | undefined): boolean {
  if (answer === undefined) return false;
  switch (answer.kind) {
    case "judge":
    case "choice":
      return true;
    case "multi":
      return answer.indexes.length > 0;
    case "fill":
      return answer.values.some((value) => value.trim() !== "");
    case "final":
      return answer.finalAnswer.trim() !== "";
    default:
      // TT-05a 起联合扩容 response/matching/ordering：旧实现不存在这些分支，
      // 差分矩阵只喂旧五 kind，到达即夹具写错
      throw new Error("旧实现夹具不认识新 kind（差分只覆盖旧五 kind）");
  }
}

/**
 * answer-format formatStudentAnswer（迁移前，display 口径）。
 * 边界（P2-3）：display 的字母算法经共享 lettersOf 活引用而非冻结副本
 * （旧实现同为 lettersOf 透传调用，行为等价）；若 lettersOf 本身变更，新旧
 * 两侧同步变化，差分对字母算法失去锁定力——字母输出的锁定力由专项用例的
 * 字面值断言（"B"/"A、C"/"AA"/"26"）承担，三口径分派逻辑的锁定不受影响。
 */
function oldFormatStudentAnswer(answer: StudentAnswer | null): string {
  if (answer === null) return "未作答";
  switch (answer.kind) {
    case "judge":
      return oldJudgeLabelOf(answer.value);
    case "choice":
      return lettersOf(answer.index);
    case "multi":
      return [...answer.indexes]
        .sort((a, b) => a - b)
        .map((index) => lettersOf(index))
        .join("");
    case "fill":
      return answer.values
        .map((v) => (v.trim() === "" ? "（空）" : v))
        .join("；");
    case "final":
      return answer.finalAnswer.trim() === "" ? "（空）" : answer.finalAnswer;
    default:
      throw new Error("旧实现夹具不认识新 kind（差分只覆盖旧五 kind）");
  }
}

/** mark-response optionLabel（迁移前） */
function oldOptionLabel(index: number): string {
  return index >= 0 && index < 26
    ? String.fromCharCode(65 + index)
    : String(index);
}

/** mark-response serializeStudentAnswer（迁移前，teacher-queue 口径） */
function oldSerializeStudentAnswer(
  answer: StudentAnswer | null,
): string | null {
  if (answer === null) return null;
  switch (answer.kind) {
    case "judge":
      return typeof answer.value === "boolean"
        ? answer.value
          ? "正确"
          : "错误"
        : answer.value;
    case "choice":
      return oldOptionLabel(answer.index);
    case "multi":
      return [...new Set(answer.indexes)]
        .sort((a, b) => a - b)
        .map((index) => oldOptionLabel(index))
        .join("、");
    case "fill":
      return answer.values.join("；");
    case "final":
      return answer.finalAnswer;
    default:
      throw new Error("旧实现夹具不认识新 kind（差分只覆盖旧五 kind）");
  }
}

/** student-ai-context optionTextOf（迁移前；options 即 snapshot.options 的正文数组） */
function oldOptionTextOf(
  options: readonly { text: string }[] | undefined,
  index: number,
): string {
  const option = options?.[index];
  return option === undefined
    ? oldOptionLabel(index)
    : `${oldOptionLabel(index)}（${option.text}）`;
}

/** student-ai-context studentAnswerTextOf（迁移前，ai-context 口径） */
function oldStudentAnswerTextOf(
  options: readonly { text: string }[] | undefined,
  answer: StudentAnswer | null,
): string | null {
  if (answer === null) return null;
  switch (answer.kind) {
    case "judge":
    case "fill":
      return oldSerializeStudentAnswer(answer);
    case "choice":
      return oldOptionTextOf(options, answer.index);
    case "multi":
      return [...new Set(answer.indexes)]
        .sort((a, b) => a - b)
        .map((index) => oldOptionTextOf(options, index))
        .join("、");
    case "final":
      return answer.finalAnswer.trim() === ""
        ? "（答案在笔迹材料中）"
        : answer.finalAnswer;
    default:
      throw new Error("旧实现夹具不认识新 kind（差分只覆盖旧五 kind）");
  }
}

// ---------- 语料夹具（valid-08 旧七型混合题，转录） ----------

/** valid-08 第 2 题（choice，四选项）的选项正文 */
const CORPUS_CHOICE_TEXTS = ["$-5$", "$-1$", "$1$", "$5$"] as const;
/** valid-08 第 3 题（multi，四选项）的选项正文 */
const CORPUS_MULTI_TEXTS = [
  "$3x^2y$",
  "$\\dfrac{5}{x+1}$",
  "$-7$",
  "$\\sqrt{2a}$",
] as const;
/** valid-08 第 4 题（fill）的空数：三空（参考答案 -8 / -9 / 5） */
const CORPUS_FILL_SLOT_COUNT = 3;
/** valid-08 第 6 题（apply）的 final 参考答案原文（作全填样例） */
const CORPUS_FINAL_TEXT = "100 元";

/** 27 个选项（验证 ≥26 时 display 的 AA 进位与 queue 的数字兜底有意不同） */
const WIDE_TEXTS: readonly string[] = Array.from(
  { length: 27 },
  (_, index) => `选项${index + 1}`,
);

// ---------- 差分矩阵 ----------

/** 结构无关口径（display/teacher-queue）用三组结构对照，证明不读结构 */
const structuresFor = (texts: readonly string[]): PublicStructureByKind => ({
  ...emptyPublicStructure,
  choice: optionsPublicStructureOf(texts),
  multi: optionsPublicStructureOf(texts),
  fill: {
    slots: Array.from({ length: CORPUS_FILL_SLOT_COUNT }, (_, order) => ({
      slotId: `slot-${order + 1}`,
      slotKind: "text" as const,
      order,
    })),
  },
});

interface DiffCase {
  /** 用例标签（失败信息定位） */
  readonly label: string;
  readonly answer: StudentAnswer;
  /** ai-context 口径对照时旧实现看到的选项正文（模拟冻结快照 options） */
  readonly aiOptionTexts: readonly string[];
}

/**
 * 七型五 kind × 运行期边界矩阵（§13.1：空字符串、空数组、部分空、全填、
 * 额外空、非法索引、重复索引、不匹配 kind、历史 judge 字符串、false/0 边界）。
 * aiOptionTexts 默认 choice/multi 语料（不匹配 kind 的行也带选项——旧实现
 * 按 answer.kind 分派、不查题型，差分锁定该事实）。
 */
const CASES: readonly DiffCase[] = [
  // judge（valid-08 第 1 题；false 边界 + 历史字符串 + 空字符串）
  {
    label: "judge true",
    answer: { kind: "judge", value: true },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "judge false",
    answer: { kind: "judge", value: false },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "judge 历史 √",
    answer: { kind: "judge", value: "√" },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "judge 历史 F",
    answer: { kind: "judge", value: "F" },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "judge 空字符串",
    answer: { kind: "judge", value: "" },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  // choice（0 边界 + 正常 + 非法索引 + ≥26）
  {
    label: "choice 0",
    answer: { kind: "choice", index: 0 },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "choice 1",
    answer: { kind: "choice", index: 1 },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "choice 非法索引 99",
    answer: { kind: "choice", index: 99 },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "choice 26（宽表）",
    answer: { kind: "choice", index: 26 },
    aiOptionTexts: WIDE_TEXTS,
  },
  // multi（空数组 + 单选 + 重复索引 + 全填 + 重复且 ≥26 + 非法索引）
  {
    label: "multi 空数组",
    answer: { kind: "multi", indexes: [] },
    aiOptionTexts: CORPUS_MULTI_TEXTS,
  },
  {
    label: "multi [0]",
    answer: { kind: "multi", indexes: [0] },
    aiOptionTexts: CORPUS_MULTI_TEXTS,
  },
  {
    label: "multi 重复 [2,0,2]",
    answer: { kind: "multi", indexes: [2, 0, 2] },
    aiOptionTexts: CORPUS_MULTI_TEXTS,
  },
  {
    label: "multi 全填 [0,1,2,3]",
    answer: { kind: "multi", indexes: [0, 1, 2, 3] },
    aiOptionTexts: CORPUS_MULTI_TEXTS,
  },
  {
    label: "multi 重复且≥26 [26,26]",
    answer: { kind: "multi", indexes: [26, 26] },
    aiOptionTexts: WIDE_TEXTS,
  },
  {
    label: "multi 非法 [7]",
    answer: { kind: "multi", indexes: [7] },
    aiOptionTexts: CORPUS_MULTI_TEXTS,
  },
  // fill（空数组 + 全空 + 部分空 + 全填 + 额外空 + 空白串）
  {
    label: "fill 空数组",
    answer: { kind: "fill", values: [] },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "fill 全空串",
    answer: { kind: "fill", values: ["", "", ""] },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "fill 部分空",
    answer: { kind: "fill", values: ["-8", "", "5"] },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "fill 全填",
    answer: { kind: "fill", values: ["-8", "-9", "5"] },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "fill 额外空（历史多余项）",
    answer: { kind: "fill", values: ["x", "", "多余项"] },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "fill 空白串",
    answer: { kind: "fill", values: ["", "  ", "x"] },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  // final（solve/apply/find-error 共用；空串 + 空白 + 原文）
  {
    label: "final 空串",
    answer: { kind: "final", finalAnswer: "" },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "final 空白",
    answer: { kind: "final", finalAnswer: "  " },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "final 原文（apply 语料）",
    answer: { kind: "final", finalAnswer: CORPUS_FINAL_TEXT },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  // 不匹配 kind（答案 kind 与题型不符：旧实现按 answer.kind 分派、不查题型）
  {
    label: "不匹配：fill 型题收 choice 答案",
    answer: { kind: "choice", index: 1 },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "不匹配：solve 型题收 judge 答案",
    answer: { kind: "judge", value: true },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "不匹配：choice 型题收 fill 答案",
    answer: { kind: "fill", values: ["x"] },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
  {
    label: "不匹配：multi 型题收 final 答案",
    answer: { kind: "final", finalAnswer: "42" },
    aiOptionTexts: CORPUS_CHOICE_TEXTS,
  },
];

describe("I15 三口径差分：登记表 vs 迁移前旧实现（valid-08 语料 + 边界矩阵）", () => {
  it.each(CASES)("口径逐字等价：$label", (testCase) => {
    const { answer, aiOptionTexts } = testCase;
    // 旧实现的 ai-context 输入形态：冻结快照 options（位置数组）
    const oldSnapshotOptions = aiOptionTexts.map((text) => ({ text }));

    // display / teacher-queue：结构无关（三组结构对照——空结构/语料结构/宽表结构）
    const structuresVariants: readonly PublicStructureByKind[] = [
      emptyPublicStructure,
      structuresFor(CORPUS_CHOICE_TEXTS),
      structuresFor(WIDE_TEXTS),
    ];
    for (const structures of structuresVariants) {
      expect(
        dispatchBehavior(answer, "display", structures),
        `display × ${structures.choice.options.length} 选项结构`,
      ).toBe(oldFormatStudentAnswer(answer));
      expect(
        dispatchBehavior(answer, "teacher-queue", structures),
        `teacher-queue × ${structures.choice.options.length} 选项结构`,
      ).toBe(oldSerializeStudentAnswer(answer) ?? "");
    }

    // ai-context：旧实现看到的位置 options 与登记表结构由同一语料构造
    expect(
      dispatchBehavior(answer, "ai-context", structuresFor(aiOptionTexts)),
    ).toBe(oldStudentAnswerTextOf(oldSnapshotOptions, answer) ?? "");

    // isAnswered 口径差分
    expect(dispatchIsAnswered(answer)).toBe(oldIsAnswered(answer));
  });

  it("ai-context 无选项结构时回落字母（等价旧实现题面无 options 的兜底分支）", () => {
    // 旧实现：snapshot.options 为 undefined → optionTextOf 回落 optionLabel
    expect(
      oldStudentAnswerTextOf(undefined, { kind: "choice", index: 1 }),
    ).toBe("B");
    expect(
      oldStudentAnswerTextOf(undefined, { kind: "multi", indexes: [0, 2] }),
    ).toBe("A、C");
    // 新登记表：emptyPublicStructure 的空选项集即同一兜底
    expect(
      dispatchBehavior(
        { kind: "choice", index: 1 },
        "ai-context",
        emptyPublicStructure,
      ),
    ).toBe("B");
    expect(
      dispatchBehavior(
        { kind: "multi", indexes: [0, 2] },
        "ai-context",
        emptyPublicStructure,
      ),
    ).toBe("A、C");
  });

  it("ai-context 按 index 字段查找而非数组位置（非稠密结构锁定，UA-02 护栏）", () => {
    // P2-1：生产结构全部经 optionsPublicStructureOf 构造（index=数组下标），
    // 上方矩阵对「按 index 字段查找」与「按数组位置取值」两种实现不可分辨。
    // 本例字面构造 index 与数组位置错开的非稠密结构，显式锁定登记表选定
    // 语义（choice.ts aiOptionTextOf 按 option.index 字段查找）；UA-02 引入
    // 稀疏选项时若实现漂移回按位置取值，此处先行失败，I15 不静默漂移。
    // 旧实现按位置读 snapshot.options[index]，无此形态的对应行为，不参与对照。
    const sparse: OptionsPublicStructure = {
      options: [
        { key: "opt-0", index: 1, text: "甲" },
        { key: "opt-1", index: 3, text: "乙" },
      ],
    };
    // 按 index 字段命中第 0 位选项「乙」；按位置取 options[3] 为 undefined
    // 会回落裸字母 "D"
    expect(
      dispatchBehavior({ kind: "choice", index: 3 }, "ai-context", {
        ...emptyPublicStructure,
        choice: sparse,
      }),
    ).toBe("D（乙）");
    // 去重+升序后逐个按字段命中：1→第 0 位「甲」、3→第 1 位「乙」
    expect(
      dispatchBehavior({ kind: "multi", indexes: [3, 1] }, "ai-context", {
        ...emptyPublicStructure,
        multi: sparse,
      }),
    ).toBe("B（甲）、D（乙）");
  });

  it("display 与 queue 的选项字母在 ≥26 时有意不同（三口径不合并的实例）", () => {
    const wide = structuresFor(WIDE_TEXTS);
    expect(
      dispatchBehavior({ kind: "choice", index: 26 }, "display", wide),
    ).toBe("AA");
    expect(
      dispatchBehavior({ kind: "choice", index: 26 }, "teacher-queue", wide),
    ).toBe("26");
    const wideStructure: OptionsPublicStructure =
      optionsPublicStructureOf(WIDE_TEXTS);
    expect(
      dispatchBehavior({ kind: "choice", index: 26 }, "ai-context", {
        ...emptyPublicStructure,
        choice: wideStructure,
        multi: wideStructure,
      }),
    ).toBe("26（选项27）");
  });
});
