import { describe, expect, it } from "vitest";
import type {
  AnswerKindBehavior,
  AnswerKindBehaviorTable,
  AnswerOf,
  OptionsPublicStructure,
  PublicStructureByKind,
  ReferenceOf,
  ShapeIssue,
} from "./answer-kinds/index.ts";
import {
  answerKindBehaviors,
  choiceMultiBehavior,
  dispatchBehavior,
  fillBehavior,
  judgeBehavior,
} from "./answer-kinds/index.ts";
import type { QuestionAnswers } from "./content.ts";
import type { StudentAnswer } from "./grading.ts";

/**
 * TT-02（UA-00）纯行为登记表接口原型——UA-01 起生产类型与五 kind 行为已
 * 收归 src/answer-kinds/（本文件改为从生产模块导入，§6.1「原型工程性记录」
 * 的收编落地）；本文件继续承载：接口编译期负例、三口径字面值锁定、
 * 扩展演练（§11.3 fake-ordering / fake-matching，UA-05 重跑）。
 * vitest node project 运行 + `pnpm typecheck` 编译期双覆盖，不进线上契约。
 *
 * 本文件验证的接口约束（方案 §4.3 定稿形态）：
 * 1. AnswerKind/AnswerOf/ReferenceOf 全部由既有判别联合推导，不手抄成员；
 * 2. AnswerKindBehaviorTable 以 satisfies 强制穷尽登记（漏 kind 编译失败）；
 * 3. 三种文本口径（display/teacher-queue/ai-context）在同一登记表内逐字
 *    复刻既有实现的输出（I15 目标形态；逐字差分对照旧实现副本另见
 *    answer-kinds/profiles.differential.test.ts）；
 * 4. 扩展演练（§11.3）：fake-ordering / fake-matching 经扩展联合 + 结构映射
 *    接入同一张表，不改生产类型、不加 any。
 */

// ---------- 公开结构（生产五 kind 从 answer-kinds 导入；演练假结构在下方局部声明） ----------

// ---------- 三口径的字面值口径说明（行为正文已收归生产 answer-kinds/*.ts） ----------
//
// display：apps/web/src/features/attempt/answer-format.ts formatStudentAnswer
//   - judge：布尔→对/错；历史字符串原样（judgeLabelOf）；
//   - choice：letterOf=lettersOf（26→AA 进位）；
//   - multi：升序**不去重**、字母直接拼接（"AB"）；
//   - fill：空值渲染「（空）」、「；」连接（含历史多余项）；
//   - final：空文本→「（空）」，否则原文。
// teacher-queue：apps/server/src/services/mark-response.ts serializeStudentAnswer
//   - judge：布尔→正确/错误；字符串原样；
//   - choice：optionLabel（≥26 用数字本身，**与 display 的 AA 进位不同**）；
//   - multi：去重+升序、「、」连接；空选=空串；
//   - fill：values 原样「；」连接（**空值不渲染「（空）」**）；
//   - final：原文（空串就是空串）。
// ai-context：apps/server/src/services/ai-companion/student-ai-context.ts
//   studentAnswerTextOf
//   - judge/fill：复用 teacher-queue 序列化；
//   - choice/multi：字母后附选项正文（选项缺失回落字母）；
//   - final：空文本→「（答案在笔迹材料中）」。
// 三函数现为登记表兼容代理（UA-01），字面值锁定断言继续指向生产
// dispatchBehavior / answerKindBehaviors。

// ---------- 编译期负例（@ts-expect-error 全部带原因；tsc 消费） ----------

// 漏登记一个 kind：登记表不再满足 AnswerKindBehaviorTable（穷尽性）
// @ts-expect-error: 少 final 键——satisfies 必须报缺键
const _missingKind: AnswerKindBehaviorTable<
  StudentAnswer,
  PublicStructureByKind
> = {
  judge: judgeBehavior,
  choice: choiceMultiBehavior,
  multi: choiceMultiBehavior,
  fill: fillBehavior,
};
void _missingKind;

// 错配结构：fill 行为不接受选项结构（结构形态与 kind 相关）
// @ts-expect-error: fill 行为要求 SlotsPublicStructure，传入 OptionsPublicStructure
const _wrongStructure: AnswerKindBehavior<
  AnswerOf<"fill">,
  OptionsPublicStructure
> = fillBehavior;
// 答案形态错配：judge 行为不接受 choice 答案签名
// @ts-expect-error: AnswerOf<"judge"> 与 AnswerOf<"choice"> 无重叠
const _wrongAnswer: AnswerKindBehavior<
  AnswerOf<"judge">,
  null
> = choiceMultiBehavior;
void _wrongStructure;
void _wrongAnswer;

// ReferenceOf 不手抄成员：fill 的参考只可能是 blanks 形态
const _fillReference: ReferenceOf<"fill"> = { kind: "fill", blanks: [["1"]] };
const _choiceReference: ReferenceOf<"choice"> = { kind: "choice", index: 0 };
// @ts-expect-error: choice 的参考（index 形态）不能当 fill 的参考用——kind 判别无重叠
const _badFillReference: ReferenceOf<"fill"> = _choiceReference;
void _fillReference;
void _choiceReference;
void _badFillReference;

// ---------- 扩展演练（§11.3）：fake-ordering / fake-matching ----------

/** 演练用排序答案：itemId 顺序（固定项也出现在序列中，见语料 valid-05 参考行式）。字段名 itemKeys 仅为演练代号，TT-01 定稿字段名为 sequence（决策记录 5.3） */
interface FakeOrderingAnswer {
  kind: "fake-ordering";
  itemKeys: string[];
}

/** 演练用排序参考：完整序列（含固定项；可发布校验=非干扰项恰一次、固定项在位） */
interface FakeOrderingReference {
  kind: "fake-ordering";
  sequence: string[];
}

/**
 * 排序公开结构（§4.3「ordering 提供 itemId→正文、合法项集合与固定位置」）。
 * fixedPosition 是演练暴露的必要字段：语料 valid-05 证明固定项的锁定位置
 * 来自参考序列（it-3 声明第 3、参考首序），对学生是可见的既定位置提示，
 * 属公开结构而非答案秘密（决策记录「TT-02 接口调整」第 3 条）。
 */
interface OrderingPublicStructure {
  readonly items: readonly {
    readonly itemId: string;
    readonly text: string;
    /** 固定项：已锁定在 fixedPosition（0 起）；非固定项为 null */
    readonly fixed: boolean;
    readonly fixedPosition: number | null;
    /** 干扰项：不属于应放序列，进入序列报 ShapeIssue（5.3.1） */
    readonly distractor: boolean;
  }[];
}

/** 演练用配对答案：slotId → optionId（部分配对=草稿，合法） */
interface FakeMatchingAnswer {
  kind: "fake-matching";
  pairs: Record<string, string>;
}

/** 演练用配对参考：同形映射（提供时全覆盖槽位） */
interface FakeMatchingReference {
  kind: "fake-matching";
  pairs: Record<string, string>;
}

/**
 * 配对公开结构（§4.3「matching 提供槽位、合法目标及是否允许重复」）。
 * 干扰选项**在选项池内**（七选五：学生可以选它——选错是答案错误，不是
 * 形状错误），与排序干扰项不得入序不对称（决策记录记录该演练发现）。
 */
interface MatchingPublicStructure {
  readonly slots: readonly { readonly slotId: string; readonly text: string }[];
  readonly optionPool: readonly {
    readonly optionId: string;
    readonly text: string;
  }[];
  readonly allowRepeat: boolean;
}

/** 演练扩展联合：生产五 kind + 两个假 kind；生产联合保持封闭不受影响 */
type DrillAnswer = StudentAnswer | FakeOrderingAnswer | FakeMatchingAnswer;
type DrillReference =
  | QuestionAnswers
  | FakeOrderingReference
  | FakeMatchingReference;
type DrillStructures = PublicStructureByKind & {
  "fake-ordering": OrderingPublicStructure;
  "fake-matching": MatchingPublicStructure;
};

const orderingBehavior: AnswerKindBehavior<
  FakeOrderingAnswer,
  OrderingPublicStructure
> = {
  isAnswered: (answer) => answer.itemKeys.length > 0,
  formatStudent: (answer, profile, structure) => {
    const textOf = (itemId: string): string => {
      const item = structure.items.find((entry) => entry.itemId === itemId);
      return item === undefined ? itemId : item.text;
    };
    if (profile === "display" || profile === "teacher-queue") {
      return answer.itemKeys.map(textOf).join(" → ");
    }
    // ai-context：附 itemId 便于 AI 定位（演练口径，不必对应任何现行实现）
    return answer.itemKeys
      .map((itemId) => `${textOf(itemId)}（${itemId}）`)
      .join("、");
  },
  inspectShape: (answer, structure) => {
    const issues: ShapeIssue[] = [];
    const seen = new Set<string>();
    for (const [position, itemId] of answer.itemKeys.entries()) {
      const item = structure.items.find((entry) => entry.itemId === itemId);
      if (item === undefined) {
        issues.push({
          code: "UNKNOWN_ITEM",
          message: `未知排序项 ${itemId}（不在题目声明项集合内）`,
        });
        continue;
      }
      if (seen.has(itemId)) {
        issues.push({
          code: "DUPLICATE_ITEM",
          message: `排序项 ${itemId} 重复出现`,
        });
      }
      seen.add(itemId);
      if (item.distractor) {
        issues.push({
          code: "DISTRACTOR_IN_SEQUENCE",
          message: `干扰项 ${itemId} 不得进入序列`,
        });
      }
      if (item.fixed && item.fixedPosition !== position) {
        issues.push({
          code: "FIXED_ITEM_MISPLACED",
          message: `固定项 ${itemId} 必须在位置 ${(item.fixedPosition ?? 0) + 1}（当前第 ${position + 1} 位）`,
        });
      }
    }
    return issues;
  },
};

const matchingBehavior: AnswerKindBehavior<
  FakeMatchingAnswer,
  MatchingPublicStructure
> = {
  isAnswered: (answer) => Object.keys(answer.pairs).length > 0,
  formatStudent: (answer, profile, structure) => {
    const slotTextOf = (slotId: string): string => {
      const slot = structure.slots.find((entry) => entry.slotId === slotId);
      return slot === undefined ? slotId : slot.text;
    };
    const optionTextOf = (optionId: string): string => {
      const option = structure.optionPool.find(
        (entry) => entry.optionId === optionId,
      );
      return option === undefined ? optionId : option.text;
    };
    const pairText = (slotId: string): string =>
      `${slotTextOf(slotId)} = ${optionTextOf(answer.pairs[slotId] ?? "")}`;
    const entries = Object.keys(answer.pairs);
    if (profile === "display") {
      return entries.map(pairText).join("；");
    }
    if (profile === "teacher-queue") {
      return entries
        .map((slotId) => `${slotId}=${answer.pairs[slotId] ?? ""}`)
        .join("；");
    }
    return entries.map(pairText).join("；");
  },
  inspectShape: (answer, structure) => {
    const issues: ShapeIssue[] = [];
    const optionIdCount = new Map<string, number>();
    for (const [slotId, optionId] of Object.entries(answer.pairs)) {
      if (!structure.slots.some((slot) => slot.slotId === slotId)) {
        issues.push({
          code: "UNKNOWN_SLOT",
          message: `未知配对槽位 ${slotId}（不在题目声明的槽位集合内）`,
        });
        continue;
      }
      if (
        !structure.optionPool.some((option) => option.optionId === optionId)
      ) {
        issues.push({
          code: "UNKNOWN_OPTION",
          message: `未知配对选项 ${optionId}（不在选项池内）`,
        });
        continue;
      }
      optionIdCount.set(optionId, (optionIdCount.get(optionId) ?? 0) + 1);
    }
    if (!structure.allowRepeat) {
      for (const [optionId, count] of optionIdCount) {
        if (count > 1) {
          issues.push({
            code: "OPTION_REPEATED",
            message: `选项 ${optionId} 被 ${count} 个槽位占用（题目不允许重复配对）`,
          });
        }
      }
    }
    return issues;
  },
};

/** 演练登记表：扩展联合 7 个 kind 全配（生产 5 项原样复用，证明不改旧项） */
const drillBehaviors = {
  ...answerKindBehaviors,
  "fake-ordering": orderingBehavior,
  "fake-matching": matchingBehavior,
} satisfies AnswerKindBehaviorTable<DrillAnswer, DrillStructures>;

// 演练联合的负例：漏配假 kind 同样编译失败
// @ts-expect-error: 演练联合漏 fake-matching 键
const _drillMissing: AnswerKindBehaviorTable<DrillAnswer, DrillStructures> = {
  ...answerKindBehaviors,
  "fake-ordering": orderingBehavior,
};
void _drillMissing;

// ---------- 运行期断言 ----------

/** 生产 choice 结构样例（旧题 key 由序号派生，§4.2） */
const lettersStructure: OptionsPublicStructure = {
  options: [
    { key: "opt-0", index: 0, text: "设问开篇" },
    { key: "opt-1", index: 1, text: "承上启下" },
    { key: "opt-2", index: 2, text: "总结收束" },
  ],
};

const productionStructures: PublicStructureByKind = {
  judge: null,
  choice: lettersStructure,
  multi: lettersStructure,
  fill: {
    slots: [
      { slotId: "slot-1", slotKind: "text", order: 0 },
      { slotId: "slot-2", slotKind: "text", order: 1 },
    ],
  },
  final: null,
  // TT-05a 域②扩容键：演练不消费新 kind 结构，空形态占位（穷尽映射编译期强制）
  response: null,
  matching: { options: [], slotIds: [], allowRepeat: false },
  ordering: { items: [] },
};

describe("纯层接口原型（TT-02）", () => {
  it("三口径对生产五 kind 逐字复刻既有输出（I15 目标形态）", () => {
    // judge：display 对/错；queue 正确/错误；历史字符串三口径原样
    expect(
      dispatchBehavior(
        { kind: "judge", value: true },
        "display",
        productionStructures,
      ),
    ).toBe("对");
    expect(
      dispatchBehavior(
        { kind: "judge", value: false },
        "teacher-queue",
        productionStructures,
      ),
    ).toBe("错误");
    expect(
      dispatchBehavior(
        { kind: "judge", value: "√" },
        "ai-context",
        productionStructures,
      ),
    ).toBe("√");

    // choice：display 字母（lettersOf）；queue 字母；ai-context 附选项正文
    expect(
      dispatchBehavior(
        { kind: "choice", index: 1 },
        "display",
        productionStructures,
      ),
    ).toBe("B");
    expect(
      dispatchBehavior(
        { kind: "choice", index: 1 },
        "teacher-queue",
        productionStructures,
      ),
    ).toBe("B");
    expect(
      dispatchBehavior(
        { kind: "choice", index: 1 },
        "ai-context",
        productionStructures,
      ),
    ).toBe("B（承上启下）");

    // multi：display 升序不去重拼接；queue/ai-context 去重、「、」连接
    expect(
      dispatchBehavior(
        { kind: "multi", indexes: [2, 0, 2] },
        "display",
        productionStructures,
      ),
    ).toBe("ACC");
    expect(
      dispatchBehavior(
        { kind: "multi", indexes: [2, 0, 2] },
        "teacher-queue",
        productionStructures,
      ),
    ).toBe("A、C");
    expect(
      dispatchBehavior(
        { kind: "multi", indexes: [2, 0] },
        "ai-context",
        productionStructures,
      ),
    ).toBe("A（设问开篇）、C（总结收束）");

    // fill：display 空值「（空）」；queue 原样（空值不渲染占位）；含历史多余项
    expect(
      dispatchBehavior(
        { kind: "fill", values: ["x", "", "多余项"] },
        "display",
        productionStructures,
      ),
    ).toBe("x；（空）；多余项");
    expect(
      dispatchBehavior(
        { kind: "fill", values: ["x", "", "多余项"] },
        "teacher-queue",
        productionStructures,
      ),
    ).toBe("x；；多余项");
    expect(
      dispatchBehavior(
        { kind: "fill", values: ["x"] },
        "ai-context",
        productionStructures,
      ),
    ).toBe("x");

    // final：display 空文本「（空）」；queue 空文本按「未做」序列化 null
    // （#6980-3）；ai-context 标注笔迹材料
    expect(
      dispatchBehavior(
        { kind: "final", finalAnswer: "42" },
        "display",
        productionStructures,
      ),
    ).toBe("42");
    expect(
      dispatchBehavior(
        { kind: "final", finalAnswer: "" },
        "display",
        productionStructures,
      ),
    ).toBe("（空）");
    expect(
      dispatchBehavior(
        { kind: "final", finalAnswer: "" },
        "teacher-queue",
        productionStructures,
      ),
    ).toBeNull();
    expect(
      dispatchBehavior(
        { kind: "final", finalAnswer: "" },
        "ai-context",
        productionStructures,
      ),
    ).toBe("（答案在笔迹材料中）");
  });

  it("display 与 server 口径的选项字母在 ≥26 时有意不同（三口径不合并的实例）", () => {
    const wideStructure: OptionsPublicStructure = {
      options: Array.from({ length: 27 }, (_, index) => ({
        key: `opt-${index}`,
        index,
        text: `选项${index + 1}`,
      })),
    };
    const structures: PublicStructureByKind = {
      ...productionStructures,
      choice: wideStructure,
      multi: wideStructure,
    };
    // display：lettersOf 26→AA（电子表格进位）
    expect(
      dispatchBehavior({ kind: "choice", index: 26 }, "display", structures),
    ).toBe("AA");
    // teacher-queue：optionLabel ≥26 用数字本身
    expect(
      dispatchBehavior(
        { kind: "choice", index: 26 },
        "teacher-queue",
        structures,
      ),
    ).toBe("26");
    // ai-context：选项正文存在时以数字兜底字母 + 正文呈现
    expect(
      dispatchBehavior({ kind: "choice", index: 26 }, "ai-context", structures),
    ).toBe("26（选项27）");
  });

  it("isAnswered 保持旧口径（I06：与完整度分离）", () => {
    const { judge, choice, multi, fill, final } = answerKindBehaviors;
    // judge/choice：有答案对象即已答（false 与 0 都是有效输入，I03）
    expect(judge.isAnswered({ kind: "judge", value: false })).toBe(true);
    expect(choice.isAnswered({ kind: "choice", index: 0 })).toBe(true);
    // multi：至少一项（空数组=未答）
    expect(multi.isAnswered({ kind: "multi", indexes: [] })).toBe(false);
    expect(multi.isAnswered({ kind: "multi", indexes: [0] })).toBe(true);
    // fill：至少一空非空（全空串=未答）
    expect(fill.isAnswered({ kind: "fill", values: ["", ""] })).toBe(false);
    expect(fill.isAnswered({ kind: "fill", values: ["", "x"] })).toBe(true);
    // final：非空文本
    expect(final.isAnswered({ kind: "final", finalAnswer: " " })).toBe(false);
    expect(final.isAnswered({ kind: "final", finalAnswer: "x" })).toBe(true);
  });

  it("inspectShape 只报告不修复：越界索引报问题、fill 历史多余项不报", () => {
    expect(
      answerKindBehaviors.choice.inspectShape(
        { kind: "choice", index: 9 },
        lettersStructure,
      ),
    ).toEqual([
      {
        code: "OPTION_INDEX_OUT_OF_RANGE",
        message: "选项下标 9 超出题面选项范围（历史数据保留原值，不自动修复）",
      },
    ]);
    expect(
      answerKindBehaviors.fill.inspectShape(
        { kind: "fill", values: ["x", "y", "历史多余"] },
        productionStructures.fill,
      ),
    ).toEqual([]);
  });

  it("扩展演练：排序 ID 映射正文与三口径", () => {
    const structure: OrderingPublicStructure = {
      items: [
        {
          itemId: "it-2",
          text: "如何对一部作品作出恰如其分的评价？",
          fixed: true,
          fixedPosition: 0,
          distractor: false,
        },
        {
          itemId: "it-1",
          text: "也就是说，批评的锋芒最终要指向作品本身。",
          fixed: false,
          fixedPosition: null,
          distractor: false,
        },
        {
          itemId: "it-4",
          text: "古人说「不以人废言」。",
          fixed: false,
          fixedPosition: null,
          distractor: false,
        },
        {
          itemId: "it-3",
          text: "因此，批评家首先需要的是耐心。",
          fixed: false,
          fixedPosition: null,
          distractor: false,
        },
        {
          itemId: "it-6",
          text: "豆浆油条。",
          fixed: false,
          fixedPosition: null,
          distractor: true,
        },
      ],
    };
    const answer: FakeOrderingAnswer = {
      kind: "fake-ordering",
      itemKeys: ["it-2", "it-4", "it-1"],
    };
    // ID→正文：文本化消费的是结构里的正文，不是裸 ID
    expect(orderingBehavior.formatStudent(answer, "display", structure)).toBe(
      "如何对一部作品作出恰如其分的评价？ → 古人说「不以人废言」。 → 也就是说，批评的锋芒最终要指向作品本身。",
    );
    expect(
      orderingBehavior.formatStudent(answer, "ai-context", structure),
    ).toBe(
      "如何对一部作品作出恰如其分的评价？（it-2）、古人说「不以人废言」。（it-4）、也就是说，批评的锋芒最终要指向作品本身。（it-1）",
    );
    expect(orderingBehavior.isAnswered(answer)).toBe(true);
    expect(
      orderingBehavior.isAnswered({ kind: "fake-ordering", itemKeys: [] }),
    ).toBe(false);
    // 合法部分序列（固定项在位）：无形状问题（未排满不报——提交不强制排满）
    expect(orderingBehavior.inspectShape(answer, structure)).toEqual([]);
  });

  it("扩展演练：排序固定项/非法项/重复项诊断", () => {
    const structure: OrderingPublicStructure = {
      items: [
        {
          itemId: "it-3",
          text: "Rinse the burette.",
          fixed: true,
          fixedPosition: 0,
          distractor: false,
        },
        {
          itemId: "it-1",
          text: "Record the initial reading.",
          fixed: false,
          fixedPosition: null,
          distractor: false,
        },
        {
          itemId: "it-5",
          text: "Heat the flask to boiling.",
          fixed: false,
          fixedPosition: null,
          distractor: true,
        },
      ],
    };
    const issues = orderingBehavior.inspectShape(
      {
        kind: "fake-ordering",
        // it-1 在第 1 位（固定项 it-3 错位）、it-5 干扰项入序、it-1 重复
        itemKeys: ["it-1", "it-3", "it-5", "it-1", "it-unknown"],
      },
      structure,
    );
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("FIXED_ITEM_MISPLACED");
    expect(codes).toContain("DISTRACTOR_IN_SEQUENCE");
    expect(codes).toContain("DUPLICATE_ITEM");
    expect(codes).toContain("UNKNOWN_ITEM");
    // 固定项错位的信息里给出应放位置
    const fixedIssue = issues.find(
      (issue) => issue.code === "FIXED_ITEM_MISPLACED",
    );
    expect(fixedIssue?.message).toContain("位置 1");
  });

  it("扩展演练：配对目标合法性与重复约束（干扰选项合法的不对称点）", () => {
    const structure: MatchingPublicStructure = {
      slots: [
        { slotId: "slot-1", text: "第一空" },
        { slotId: "slot-2", text: "第二空" },
        { slotId: "slot-3", text: "第三空" },
      ],
      optionPool: [
        { optionId: "opt-1", text: "深度睡眠清理废物蛋白" },
        { optionId: "opt-3", text: "以少睡为荣即以劣绩为荣" },
        { optionId: "opt-6", text: "尊重这张床：只用来睡觉" },
        { optionId: "opt-7", text: "干扰选项（可被选，选错≠形状错误）" },
      ],
      allowRepeat: false,
    };
    // 合法部分配对：槽位在集合、选项在池（含干扰选项）、无重复占用
    expect(
      matchingBehavior.inspectShape(
        { kind: "fake-matching", pairs: { "slot-1": "opt-7" } },
        structure,
      ),
    ).toEqual([]);
    // 三类形状问题：未知槽位、未知选项、重复占用（allowRepeat=false）
    const issues = matchingBehavior.inspectShape(
      {
        kind: "fake-matching",
        pairs: {
          // opt-3 被两个合法槽位重复占用
          "slot-1": "opt-3",
          "slot-2": "opt-3",
          // 未知选项：槽位合法
          "slot-3": "opt-x",
          // 未知槽位
          "slot-9": "opt-6",
        },
      },
      structure,
    );
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("UNKNOWN_SLOT");
    expect(codes).toContain("UNKNOWN_OPTION");
    expect(codes.filter((code) => code === "OPTION_REPEATED")).toHaveLength(1);
    // allowRepeat=true 时重复占用不再报
    const repeatAllowed: MatchingPublicStructure = {
      ...structure,
      allowRepeat: true,
    };
    expect(
      matchingBehavior.inspectShape(
        {
          kind: "fake-matching",
          pairs: { "slot-1": "opt-3", "slot-2": "opt-3" },
        },
        repeatAllowed,
      ),
    ).toEqual([]);
    // 配对文本化：display 附槽位/选项正文，queue 用 ID 对
    expect(
      matchingBehavior.formatStudent(
        { kind: "fake-matching", pairs: { "slot-1": "opt-1" } },
        "display",
        structure,
      ),
    ).toBe("第一空 = 深度睡眠清理废物蛋白");
    expect(
      matchingBehavior.formatStudent(
        { kind: "fake-matching", pairs: { "slot-1": "opt-1" } },
        "teacher-queue",
        structure,
      ),
    ).toBe("slot-1=opt-1");
  });

  it("扩展登记表：生产五 kind 行为在扩展联合下原样复用（不改旧项）", () => {
    const table: AnswerKindBehaviorTable<DrillAnswer, DrillStructures> =
      drillBehaviors;
    // 生产 kind 经扩展表仍产出既有输出；假 kind 只作为新增分支出现
    expect(
      table.choice.formatStudent(
        { kind: "choice", index: 0 },
        "display",
        lettersStructure,
      ),
    ).toBe("A");
    expect(
      table["fake-ordering"].isAnswered({
        kind: "fake-ordering",
        itemKeys: ["it-1"],
      }),
    ).toBe(true);
    // ReferenceOf 参数化：演练参考联合下取到 fake 参考形态
    const reference: ReferenceOf<"fake-ordering", DrillReference> = {
      kind: "fake-ordering",
      sequence: ["it-3", "it-2", "it-1", "it-4"],
    };
    void reference;
  });
});
