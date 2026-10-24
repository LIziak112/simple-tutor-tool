import { describe, expect, it } from "vitest";
import type {
  MatchingStudentAnswer,
  OrderingStudentAnswer,
  ResponseStudentAnswer,
  StudentAnswer,
} from "../grading.ts";
import {
  type AnswerKindBehaviorTable,
  answerKindBehaviors,
  countResponseWords,
  dispatchBehavior,
  dispatchIsAnswered,
  emptyPublicStructure,
  type MatchingPublicStructure,
  matchingPublicStructureOf,
  type OrderingPublicStructure,
  orderingPublicStructureOf,
  type PublicStructureByKind,
} from "./index.ts";

// ---------- 编译期负例（@ts-expect-error 带原因；tsc 消费，运行时零执行） ----------

// @ts-expect-error: matching 行为不接受 response 答案形态（AnswerOf 窄化）
const _wrongMatchingAnswer: (answer: ResponseStudentAnswer) => boolean =
  answerKindBehaviors.matching.isAnswered;

// @ts-expect-error: ordering 的 inspectShape 需 OrderingPublicStructure，传入 MatchingPublicStructure
const _wrongOrderingStructure: (
  answer: OrderingStudentAnswer,
  structure: MatchingPublicStructure,
) => readonly unknown[] = answerKindBehaviors.ordering.inspectShape;

// @ts-expect-error: 漏 response/matching/ordering 的登记表不满足穷尽约束
const _incompleteTable: AnswerKindBehaviorTable<
  StudentAnswer,
  PublicStructureByKind
> = {
  judge: answerKindBehaviors.judge,
  choice: answerKindBehaviors.choice,
  multi: answerKindBehaviors.multi,
  fill: answerKindBehaviors.fill,
  final: answerKindBehaviors.final,
};

/**
 * 新答案 kind（response/matching/ordering）纯行为测试（TT-05a 域②）。
 * 三口径文本化、isAnswered 纯行为口径（§5.3.1）、inspectShape 结构诊断
 * （只报告不拦截；干扰项进入 ordering 序列报 DISTRACTOR_IN_SEQUENCE，
 * matching 干扰选项可被选不报——§6.1 调整 6 的不对称口径）。
 */

const matchingStructure = matchingPublicStructureOf(
  {
    allowRepeat: false,
    options: [
      { id: "opt-1", text: "选项一" },
      { id: "opt-2", text: "选项二" },
      { id: "opt-8", text: "干扰项", distractor: true },
    ],
  },
  ["slot-1", "slot-2"],
);

const orderingStructure = orderingPublicStructureOf([
  { id: "it-1", text: "甲" },
  { id: "it-2", text: "乙", fixedPosition: 1 },
  { id: "it-6", text: "干扰", distractor: true },
]);

describe("登记表穷尽与公开结构（I01）", () => {
  it("answerKindBehaviors 覆盖八个 kind（response/matching/ordering 接入，纯层无 React）", () => {
    expect(Object.keys(answerKindBehaviors).sort()).toEqual(
      [
        "judge",
        "choice",
        "multi",
        "fill",
        "final",
        "response",
        "matching",
        "ordering",
      ].sort(),
    );
  });

  it("emptyPublicStructure 覆盖八键：response=null、matching 空池、ordering 空项", () => {
    expect(Object.keys(emptyPublicStructure).sort()).toEqual(
      [
        "fill",
        "final",
        "judge",
        "matching",
        "multi",
        "ordering",
        "response",
        "choice",
      ].sort(),
    );
    expect(emptyPublicStructure.response).toBeNull();
    expect(emptyPublicStructure.matching).toEqual({
      options: [],
      slotIds: [],
      allowRepeat: false,
    });
    expect(emptyPublicStructure.ordering).toEqual({ items: [] });
  });

  it("结构构造器：matchingPublicStructureOf / orderingPublicStructureOf 归一缺省", () => {
    expect(matchingStructure).toEqual({
      allowRepeat: false,
      slotIds: ["slot-1", "slot-2"],
      options: [
        { key: "opt-1", text: "选项一", distractor: false },
        { key: "opt-2", text: "选项二", distractor: false },
        { key: "opt-8", text: "干扰项", distractor: true },
      ],
    } satisfies MatchingPublicStructure);
    expect(orderingStructure).toEqual({
      items: [
        { key: "it-1", text: "甲", fixedPosition: null, distractor: false },
        { key: "it-2", text: "乙", fixedPosition: 1, distractor: false },
        { key: "it-6", text: "干扰", fixedPosition: null, distractor: true },
      ],
    } satisfies OrderingPublicStructure);
  });
});

describe("response 纯行为（§5.3.1/§11.4：isAnswered = body 非空白）", () => {
  const behavior = answerKindBehaviors.response;

  it("isAnswered：body 非空白才算已答（空串/纯空白=未写正文，仅手写作答合法）", () => {
    expect(behavior.isAnswered({ kind: "response", body: "正文" })).toBe(true);
    expect(behavior.isAnswered({ kind: "response", body: "  " })).toBe(false);
    expect(behavior.isAnswered({ kind: "response", body: "" })).toBe(false);
  });

  it("三口径文本化：title 非空前置一行，正文原样（多段 Markdown 不截断）", () => {
    // satisfies 而非类型注解：exactOptionalPropertyTypes 下注解会把 title
    // 扩为 string | undefined，与行为参数的 title?: string 不兼容
    const withTitle = {
      kind: "response",
      title: "分歧是治理的起点",
      body: "第一段……\n\n第二段……",
    } satisfies ResponseStudentAnswer;
    for (const profile of ["display", "teacher-queue", "ai-context"] as const) {
      expect(behavior.formatStudent(withTitle, profile, null)).toBe(
        "分歧是治理的起点\n第一段……\n\n第二段……",
      );
    }
    expect(
      behavior.formatStudent(
        { kind: "response", body: "仅正文" },
        "display",
        null,
      ),
    ).toBe("仅正文");
  });

  it("inspectShape 恒空（无结构面，纯行为只读答案本身）", () => {
    expect(
      behavior.inspectShape({ kind: "response", body: "x" }, null),
    ).toEqual([]);
  });
});

describe("response 字数口径（QM-09：中文按字含中文标点、英文按词，UI 与保存共用单源）", () => {
  it("中文正文：每个汉字与中文标点各计 1 字", () => {
    expect(countResponseWords("老旧小区改造")).toBe(6);
    // 中文标点同样计入（作文字数惯例含标点）
    expect(countResponseWords("分歧，是起点。")).toBe(7);
  });

  it("英文正文：连续拉丁字母/数字/撇号串计 1 词", () => {
    expect(countResponseWords("Reading furnishes the mind")).toBe(4);
    expect(countResponseWords("it's a well-known fact")).toBe(4);
    expect(countResponseWords("x^2 + 3")).toBe(3); // x、2、3 各一词
  });

  it("中英混排：中文字数与英文词数相加；空白/换行/英文标点不计", () => {
    // 「概括主要特点，」7 字（含中文逗号）+ no/more/than/250/words 五词 + 「。」1 字 = 13
    expect(countResponseWords("概括主要特点，no more than 250 words。")).toBe(
      13,
    );
    expect(countResponseWords("  \n\n ")).toBe(0);
    expect(countResponseWords("")).toBe(0);
  });
});

describe("matching 纯行为（§5.3.1：pairs 非空对象=已答；部分配对=草稿合法）", () => {
  const behavior = answerKindBehaviors.matching;

  it("isAnswered：pairs 非空对象", () => {
    expect(behavior.isAnswered({ kind: "matching", pairs: {} })).toBe(false);
    expect(
      behavior.isAnswered({ kind: "matching", pairs: { "slot-1": "opt-1" } }),
    ).toBe(true);
  });

  it("三口径文本化：slot = 选项正文（无正文回落 id），键序稳定，「；」连接", () => {
    const answer: MatchingStudentAnswer = {
      kind: "matching",
      pairs: { "slot-2": "opt-8", "slot-1": "opt-1" },
    };
    for (const profile of ["display", "teacher-queue", "ai-context"] as const) {
      expect(behavior.formatStudent(answer, profile, matchingStructure)).toBe(
        "slot-1 = 选项一；slot-2 = 干扰项",
      );
    }
    // 空池（三代理的 emptyPublicStructure 路径）回落裸 id
    expect(
      behavior.formatStudent(answer, "display", emptyPublicStructure.matching),
    ).toBe("slot-1 = opt-1；slot-2 = opt-8");
  });

  it("inspectShape：未知槽位/未知选项/重复占用（allowRepeat=false）各自报 ShapeIssue；干扰选项被选不报", () => {
    expect(
      behavior
        .inspectShape(
          { kind: "matching", pairs: { "slot-9": "opt-1" } },
          matchingStructure,
        )
        .map((issue) => issue.code),
    ).toEqual(["MATCHING_UNKNOWN_SLOT"]);
    expect(
      behavior
        .inspectShape(
          { kind: "matching", pairs: { "slot-1": "opt-404" } },
          matchingStructure,
        )
        .map((issue) => issue.code),
    ).toEqual(["MATCHING_UNKNOWN_OPTION"]);
    // 干扰选项（opt-8）在池内、学生可选——选错是答案错误不是形状错误（§6.1 调整 6）
    expect(
      behavior.inspectShape(
        { kind: "matching", pairs: { "slot-1": "opt-8" } },
        matchingStructure,
      ),
    ).toEqual([]);
    expect(
      behavior
        .inspectShape(
          { kind: "matching", pairs: { "slot-1": "opt-2", "slot-2": "opt-2" } },
          matchingStructure,
        )
        .map((issue) => issue.code),
    ).toEqual(["MATCHING_OPTION_REUSED"]);
    // allowRepeat=true 时重复占用合法
    const repeatable = matchingPublicStructureOf(
      { allowRepeat: true, options: [{ id: "opt-1", text: "一" }] },
      ["slot-1", "slot-2"],
    );
    expect(
      behavior.inspectShape(
        { kind: "matching", pairs: { "slot-1": "opt-1", "slot-2": "opt-1" } },
        repeatable,
      ),
    ).toEqual([]);
    // 空结构（选项池与槽位集合都缺）= 结构不可用，无从校验
    expect(
      behavior.inspectShape(
        { kind: "matching", pairs: { "slot-1": "opt-1" } },
        emptyPublicStructure.matching,
      ),
    ).toEqual([]);
  });
});

describe("ordering 纯行为（§5.3.1：sequence 非空=已答；固定项在位为结构约束）", () => {
  const behavior = answerKindBehaviors.ordering;

  it("isAnswered：sequence 非空数组", () => {
    expect(behavior.isAnswered({ kind: "ordering", sequence: [] })).toBe(false);
    expect(behavior.isAnswered({ kind: "ordering", sequence: ["it-1"] })).toBe(
      true,
    );
  });

  it("三口径文本化：项正文依序「 → 」连接（无正文回落 id）", () => {
    const answer: OrderingStudentAnswer = {
      kind: "ordering",
      sequence: ["it-2", "it-1"],
    };
    for (const profile of ["display", "teacher-queue", "ai-context"] as const) {
      expect(behavior.formatStudent(answer, profile, orderingStructure)).toBe(
        "乙 → 甲",
      );
    }
    expect(
      behavior.formatStudent(answer, "display", emptyPublicStructure.ordering),
    ).toBe("it-2 → it-1");
  });

  it("inspectShape：干扰项入序/未知项/重复项/固定项错位各自报码（DISTRACTOR_IN_SEQUENCE，§6.1 调整 6）", () => {
    expect(
      behavior
        .inspectShape(
          { kind: "ordering", sequence: ["it-1", "it-6"] },
          orderingStructure,
        )
        .map((issue) => issue.code),
    ).toEqual(["DISTRACTOR_IN_SEQUENCE"]);
    expect(
      behavior
        .inspectShape(
          { kind: "ordering", sequence: ["it-404"] },
          orderingStructure,
        )
        .map((issue) => issue.code),
    ).toEqual(["ORDERING_UNKNOWN_ITEM"]);
    expect(
      behavior
        .inspectShape(
          { kind: "ordering", sequence: ["it-1", "it-1"] },
          orderingStructure,
        )
        .map((issue) => issue.code),
    ).toEqual(["ORDERING_DUPLICATE_ITEM"]);
    // it-2 声明固定在第 1 位，出现在第 2 位即错位（部分草稿中未出现的固定项不报）
    expect(
      behavior
        .inspectShape(
          { kind: "ordering", sequence: ["it-1", "it-2"] },
          orderingStructure,
        )
        .map((issue) => issue.code),
    ).toEqual(["FIXED_ITEM_OUT_OF_POSITION"]);
    expect(
      behavior.inspectShape(
        { kind: "ordering", sequence: ["it-2", "it-1"] },
        orderingStructure,
      ),
    ).toEqual([]);
    // 空结构 = 结构不可用
    expect(
      behavior.inspectShape(
        { kind: "ordering", sequence: ["it-1"] },
        emptyPublicStructure.ordering,
      ),
    ).toEqual([]);
  });
});

describe("调度边界扩展（§11.1 触点①：dispatch 三 case + assertNever 收尾保持）", () => {
  it("dispatchBehavior/dispatchIsAnswered 可调度新 kind（经登记表单源行为）", () => {
    const structures: PublicStructureByKind = {
      ...emptyPublicStructure,
      matching: matchingStructure,
      ordering: orderingStructure,
    };
    expect(
      dispatchBehavior(
        { kind: "response", body: "正文" } satisfies StudentAnswer,
        "display",
        structures,
      ),
    ).toBe("正文");
    expect(
      dispatchBehavior(
        { kind: "matching", pairs: { "slot-1": "opt-1" } },
        "teacher-queue",
        structures,
      ),
    ).toBe("slot-1 = 选项一");
    expect(
      dispatchBehavior(
        { kind: "ordering", sequence: ["it-1", "it-2"] },
        "ai-context",
        structures,
      ),
    ).toBe("甲 → 乙");
    expect(dispatchIsAnswered({ kind: "response", body: " " })).toBe(false);
    expect(
      dispatchIsAnswered({ kind: "matching", pairs: { a: "opt-1" } }),
    ).toBe(true);
    expect(dispatchIsAnswered({ kind: "ordering", sequence: [] })).toBe(false);
  });

  it("类型负例：登记表签名错配编译失败（赋值式负例不执行，tsc 消费）", () => {
    // 负例定义在模块顶部（_wrongMatchingAnswer/_wrongOrderingStructure/
    // _incompleteTable），此处仅引用防被树摇——运行时零调用
    void _wrongMatchingAnswer;
    void _wrongOrderingStructure;
    void _incompleteTable;
  });

  it("类型负例：漏登记新 kind 时 satisfies 穷尽失败（编译期）", () => {
    // @ts-expect-error 漏 matching/ordering/response 的登记表不满足穷尽约束
    const incomplete: AnswerKindBehaviorTable<
      StudentAnswer,
      PublicStructureByKind
    > = {
      judge: answerKindBehaviors.judge,
      choice: answerKindBehaviors.choice,
      multi: answerKindBehaviors.multi,
      fill: answerKindBehaviors.fill,
      final: answerKindBehaviors.final,
    };
    void incomplete;
  });
});
