/**
 * QM-02 回归语料的契约层测试骨架（TT-05a，决策记录 §12）。
 *
 * 15 份语料已从 docs/题目模型与练习适配/语料/ 迁入 samples/qm/（§5.9 授权
 * 本轮迁移；**不进 samples/v2**——新语法必须与 TT-06 注册同批次接入自动回归，
 * 硬性规则 12；samples/lint 是固定名册，同样不自动消费本目录）。
 *
 * 本文件锁三件事：
 * 1. **语料清单与预期表**（来源 kind、题数/组数/材料数、ID、参考答案归属、
 *    槽位映射、干扰项）——TT-06 解析器与 QM-04 导入实现的对照组（oracle
 *    先行：先锁预期，实现向预期对齐，而不是反过来）；
 * 2. **预期结构的契约可解析性**：手工推导的解析投影经 unitSchema /
 *    questionPublicSchema / questionAnswersSchema / materialPublicSchema 验证
 *    ——当前就绿；TT-06 的真实解析结果必须与这些形态吻合；
 * 3. **公开/私有隔离**与**题级 ::ref 落位**（域①遗漏 materialRefs，本批补齐）。
 *
 * DSL 解析断言（parseDocument 直接消费新语法）按 §12「注册表探针条件激活」
 * 策略放 packages/md-dsl/src/v2/qm-corpus.test.ts——TT-06 注册 material/
 * group/ref 指令后自动转执行，不依赖人工摘除 skip。
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  questionAnswersSchema,
  questionPublicSchema,
  questionSchema,
  unitSchema,
} from "./content.ts";
import {
  materialPublicSchema,
  materialRefSchema,
  materialSlotSchema,
} from "./material.ts";
import { gradingPolicyOf } from "./self-review.ts";

const CORPUS_DIR = fileURLToPath(
  new URL("../../../samples/qm/", import.meta.url),
);

// ---------- 1. 清单与预期表（八类有效形态；对照实施清单 QM-02 细项一） ----------

interface ExpectedValid {
  /** frontmatter 来源（全部 practice：本轮语料不含 lecture/lesson） */
  readonly kind: "practice";
  /** 材料数与每份材料的 (锚点数, 槽位数) */
  readonly materials: ReadonlyArray<{
    readonly id: string;
    readonly anchors: number;
    readonly slots: number;
  }>;
  /** 组数与每组的 (id, label, 材料引用数, 子题数) */
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly label?: string;
    readonly materialRefs: number;
    readonly questions: number;
  }>;
  /** 题目 ID → 题型（平铺全量） */
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    /** 参考答案归属：有=answers 存在；无=manual_only 演示 */
    readonly hasAnswer: boolean;
  }>;
  /** 材料槽位总数与种类（choice=完形空位、match=配对槽） */
  readonly slotKind?: "choice" | "match";
}

const EXPECTED_VALID: Record<string, ExpectedValid> = {
  "valid-01-资料分析五题.md": {
    kind: "practice",
    materials: [{ id: "mat-1", anchors: 2, slots: 0 }],
    groups: [{ id: "grp-1", label: "1～5", materialRefs: 1, questions: 5 }],
    questions: [
      { id: "zl-1", type: "choice", hasAnswer: true },
      { id: "zl-2", type: "choice", hasAnswer: true },
      { id: "zl-3", type: "multi", hasAnswer: true },
      { id: "zl-4", type: "fill", hasAnswer: true },
      { id: "zl-5", type: "choice", hasAnswer: true },
    ],
  },
  "valid-02-英语阅读五题.md": {
    kind: "practice",
    materials: [{ id: "mat-1", anchors: 0, slots: 0 }],
    groups: [{ id: "grp-1", label: "1–5", materialRefs: 1, questions: 5 }],
    questions: [
      { id: "rc-1", type: "choice", hasAnswer: true },
      { id: "rc-2", type: "choice", hasAnswer: true },
      { id: "rc-3", type: "choice", hasAnswer: true },
      { id: "rc-4", type: "multi", hasAnswer: true },
      { id: "rc-5", type: "choice", hasAnswer: true },
    ],
  },
  "valid-03-二十空完形.md": {
    kind: "practice",
    materials: [{ id: "mat-1", anchors: 0, slots: 20 }],
    groups: [{ id: "grp-1", label: "1–20", materialRefs: 1, questions: 20 }],
    questions: Array.from({ length: 20 }, (_, i) => ({
      id: `xk-${i + 1}`,
      type: "choice",
      hasAnswer: true,
    })),
    slotKind: "choice",
  },
  "valid-04-七选五.md": {
    kind: "practice",
    materials: [{ id: "mat-1", anchors: 0, slots: 5 }],
    groups: [{ id: "grp-1", label: "1–5", materialRefs: 1, questions: 1 }],
    questions: [{ id: "qx-1", type: "matching", hasAnswer: true }],
    slotKind: "match",
  },
  "valid-05-固定项排序.md": {
    kind: "practice",
    materials: [],
    groups: [],
    questions: [
      { id: "px-1", type: "ordering", hasAnswer: true },
      { id: "px-2", type: "ordering", hasAnswer: true },
    ],
  },
  "valid-06-多材料申论翻译作文.md": {
    kind: "practice",
    materials: [
      { id: "mat-1", anchors: 3, slots: 0 },
      { id: "mat-2", anchors: 0, slots: 0 },
      { id: "mat-3", anchors: 2, slots: 0 },
    ],
    groups: [],
    questions: [
      { id: "sl-1", type: "response", hasAnswer: true },
      { id: "fy-1", type: "response", hasAnswer: true },
      { id: "zw-1", type: "response", hasAnswer: true },
    ],
  },
  "valid-07-两问证明计算.md": {
    kind: "practice",
    materials: [],
    groups: [{ id: "grp-1", label: "1–2", materialRefs: 0, questions: 2 }],
    questions: [
      { id: "zm-1", type: "response", hasAnswer: true },
      { id: "zm-2", type: "solve", hasAnswer: false },
    ],
  },
  "valid-08-旧七型混合题.md": {
    kind: "practice",
    materials: [],
    groups: [],
    questions: [
      { id: "", type: "judge", hasAnswer: true },
      { id: "", type: "choice", hasAnswer: true },
      { id: "", type: "multi", hasAnswer: true },
      { id: "", type: "fill", hasAnswer: true },
      { id: "", type: "solve", hasAnswer: true },
      { id: "", type: "apply", hasAnswer: true },
      { id: "", type: "find-error", hasAnswer: true },
    ],
  },
};

/** 七类错误语料的预期码表（§5.4.3；文件名已带 expected- 前缀，此处双核对） */
const EXPECTED_INVALID: Record<string, string[]> = {
  "invalid-01-缺材料-expected-UNKNOWN_MATERIAL_REF.md": [
    "UNKNOWN_MATERIAL_REF",
  ],
  // 跨域是导入/发布层码：静态 lint 先报 UNKNOWN_MATERIAL_REF（文档内不可解析），
  // 导入层按教师域查询命中他域材料才升级 MATERIAL_REF_OUT_OF_DOMAIN（§5.4.3）
  "invalid-02-跨教师域-expected-MATERIAL_REF_OUT_OF_DOMAIN.md": [
    "MATERIAL_REF_OUT_OF_DOMAIN",
    "UNKNOWN_MATERIAL_REF",
  ],
  "invalid-03-重复循环组-expected-GROUP_MEMBER_DUPLICATED.md": [
    "GROUP_MEMBER_DUPLICATED",
    "GROUP_NESTED_OR_CYCLIC",
  ],
  "invalid-04-未知槽位-expected-UNKNOWN_SLOT_REF.md": ["UNKNOWN_SLOT_REF"],
  "invalid-05-越界锚点-expected-SEG_RANGE_OUT_OF_BOUNDS.md": [
    "SEG_RANGE_OUT_OF_BOUNDS",
  ],
  "invalid-06-材料含答案指令-expected-MATERIAL_CONTAINS_ANSWER.md": [
    "MATERIAL_CONTAINS_ANSWER",
  ],
  "invalid-07-非法选项引用-expected-INVALID_OPTION_REF.md": [
    "INVALID_OPTION_REF",
  ],
};

/** 预期表访问器：缺登记即测试失败（防名实分离的编译期+运行期双保险） */
function valid(name: string): ExpectedValid {
  const found = EXPECTED_VALID[name];
  if (found === undefined) throw new Error(`预期表缺登记：${name}`);
  return found;
}

describe("QM-02 语料清单（samples/qm 新专题目录，§5.9/§12）", () => {
  it("目录恰好包含 8 有效 + 7 错误共 15 份；新增语料必须同步登记预期表", () => {
    const onDisk = readdirSync(CORPUS_DIR)
      .filter((name) => name.endsWith(".md"))
      .sort();
    expect(onDisk).toEqual(
      [...Object.keys(EXPECTED_VALID), ...Object.keys(EXPECTED_INVALID)].sort(),
    );
    expect(onDisk).toHaveLength(15);
  });

  it("预期表自检：八类有效形态与实施清单 QM-02 细项逐条对应", () => {
    // 八类形态各占一份（资料分析/英语阅读/二十空完形/七选五/固定项排序/
    // 多材料申论翻译作文/两问证明计算/旧七型混合）
    expect(Object.keys(EXPECTED_VALID)).toHaveLength(8);
    // 二十空完形：20 槽 20 choice 子题（逐空绑定）
    const cloze = valid("valid-03-二十空完形.md");
    expect(cloze.materials[0]?.slots).toBe(20);
    expect(cloze.questions).toHaveLength(20);
    // 固定项排序：无材料无组的独立题
    const ordering = valid("valid-05-固定项排序.md");
    expect(ordering.materials).toHaveLength(0);
    expect(ordering.groups).toHaveLength(0);
    // 两问证明计算：第 (2) 问 solve 无参考答案（manual_only 演示）
    const twoPart = valid("valid-07-两问证明计算.md");
    expect(twoPart.questions.find((q) => q.id === "zm-2")?.hasAnswer).toBe(
      false,
    );
    // 旧七型混合：七题型齐全（judge…find-error 各一）
    const legacy = valid("valid-08-旧七型混合题.md");
    expect(legacy.questions.map((q) => q.type)).toEqual([
      "judge",
      "choice",
      "multi",
      "fill",
      "solve",
      "apply",
      "find-error",
    ]);
  });

  it("错误语料文件名 expected- 码与预期码表一致（防名实分离）", () => {
    for (const [name, codes] of Object.entries(EXPECTED_INVALID)) {
      const m = /expected-([A-Z_]+)/.exec(name);
      expect(m, name).not.toBeNull();
      expect(codes, name).toContain(m?.[1] ?? "");
    }
  });
});

// ---------- 2. 预期结构的契约可解析性（oracle 形态；TT-06 对齐目标） ----------

/** 最小合法题目载荷（来源 version：kind=practice 语料的题目平铺项） */ function q(
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    difficulty: 2,
    stemMd: "题干",
    sourceMd: "题块原文",
    ...extra,
  };
}

describe("预期解析投影的契约可解析性（资料分析五题）", () => {
  const parsed = unitSchema.safeParse({
    id: "资料分析专项",
    title: "资料分析专项",
    materials: [
      {
        id: "mat-1",
        title: "2025 年某省粮食生产情况",
        sourceMd: "::::material{id=mat-1 …}…::::",
        contentMd: "正文（含统计表与 ::image）",
        anchors: [
          { id: "seg-1", order: 0 },
          { id: "seg-2", order: 1 },
        ],
        slots: [],
        mediaPaths: [
          "blobs/media/9af3c2e1b7d84a06f2c5e3d1a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2.png",
        ],
      },
    ],
    groups: [
      {
        id: "grp-1",
        title: "根据以下资料回答第 1～5 题",
        label: "1～5",
        materialRefs: [{ material: "mat-1" }],
        questionIds: ["zl-1", "zl-2", "zl-3", "zl-4", "zl-5"],
      },
    ],
    questions: [
      q("zl-1", "choice", {
        options: [
          { text: "1.6%" },
          { text: "3.0%" },
          { text: "3.8%" },
          { text: "5.6%" },
        ],
        answers: { kind: "choice", index: 1 },
      }),
      q("zl-2", "choice", { answers: { kind: "choice", index: 1 } }),
      q("zl-3", "multi", { answers: { kind: "multi", indexes: [0, 2] } }),
      q("zl-4", "fill", {
        answers: { kind: "fill", blanks: [["60.0", "60"]] },
      }),
      q("zl-5", "choice", { answers: { kind: "choice", index: 1 } }),
    ],
  });

  it("材料/组/题目挂载投影整体可解析（anchors 有序、mediaPaths 白名单路径）", () => {
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.materials?.[0]?.anchors).toHaveLength(2);
    expect(parsed.data.groups?.[0]?.label).toBe("1～5");
    expect(parsed.data.groups?.[0]?.questionIds).toHaveLength(5);
    // 多空等价答案：[[60.0|60]] 的解析形态
    expect(parsed.data.questions[3]?.answers).toEqual({
      kind: "fill",
      blanks: [["60.0", "60"]],
    });
  });

  it("材料公开投影剥离教师侧 sourceMd（fail closed）", () => {
    const pub = materialPublicSchema.parse({
      id: "mat-1",
      title: "2025 年某省粮食生产情况",
      sourceMd: "::::material{id=mat-1 …}…::::",
      contentMd: "正文（学生可见）",
      anchors: [{ id: "seg-1", order: 0 }],
      slots: [],
      mediaPaths: [],
    });
    expect(pub.contentMd).toBe("正文（学生可见）");
    expect("sourceMd" in pub).toBe(false);
  });
});

describe("预期解析投影的契约可解析性（七选五 matching）", () => {
  it("20 槽 choice 完形与 5 槽 match 七选五的槽位/选项/映射形态", () => {
    // 完形：20 个 choice 槽位按出现顺序
    const clozeSlots = Array.from({ length: 20 }, (_, i) => ({
      id: `slot-${i + 1}`,
      slotKind: "choice",
      order: i,
    }));
    expect(
      clozeSlots.filter((s) => materialSlotSchema.safeParse(s).success),
    ).toHaveLength(20);
    // 七选五：7 选项 2 干扰 + 5 槽映射（slotId→optionId）
    const parsed = questionAnswersSchema.safeParse({
      kind: "matching",
      pairs: {
        "slot-1": "opt-1",
        "slot-2": "opt-5",
        "slot-3": "opt-3",
        "slot-4": "opt-4",
        "slot-5": "opt-6",
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (parsed.data.kind !== "matching") {
      throw new Error(`应为 matching，实为 ${parsed.data.kind}`);
    }
    expect(Object.keys(parsed.data.pairs)).toHaveLength(5);
    // 干扰项标记是公开结构（学生可见可错选）
    const options = {
      allowRepeat: false,
      options: [
        { id: "opt-1", text: "深睡期脑类淋巴系统清除废物蛋白" },
        { id: "opt-2", text: "午间十分钟小睡", distractor: true },
        { id: "opt-7", text: "早晨的咖啡因早已代谢", distractor: true },
      ],
    };
    expect(
      questionPublicSchema.safeParse({
        id: "qx-1",
        type: "matching",
        difficulty: 4,
        knowledge: ["七选五"],
        stemMd: "从 7 个选项中选 5 个",
        hintCount: 0,
        matchingOptions: options,
      }).success,
    ).toBe(true);
  });
});

describe("预期解析投影的契约可解析性（固定项排序 ordering）", () => {
  it("固定项 fixedPosition 与干扰项 distractor 从参考序列推导（§5.4.1）", () => {
    const parsed = questionSchema.parse(
      q("px-1", "ordering", {
        orderingItems: [
          {
            id: "it-1",
            text: "也就是说……",
            fixedPosition: null,
            distractor: false,
          },
          {
            id: "it-2",
            text: "如何对一部作品作出评价？",
            fixedPosition: 1,
            distractor: false,
          },
          {
            id: "it-6",
            text: "豆浆与油条……",
            fixedPosition: null,
            distractor: true,
          },
        ],
        answers: {
          kind: "ordering",
          sequence: ["it-2", "it-4", "it-5", "it-1", "it-3"],
        },
      }),
    );
    expect(
      parsed.orderingItems?.find((i) => i.id === "it-2")?.fixedPosition,
    ).toBe(1);
    expect(parsed.orderingItems?.find((i) => i.id === "it-6")?.distractor).toBe(
      true,
    );
    expect(parsed.answers).toEqual({
      kind: "ordering",
      sequence: ["it-2", "it-4", "it-5", "it-1", "it-3"],
    });
  });
});

describe("预期解析投影的契约可解析性（多材料申论翻译作文 response）", () => {
  it("response 参考 Markdown 与多参考表达（variantsMd）；word-min/max 只是提示", () => {
    const parsed = questionSchema.parse(
      q("sl-1", "response", {
        wordMin: 150,
        wordMax: 250,
        materialRefs: [
          { material: "mat-1", segs: "seg-1..seg-2" },
          { material: "mat-2" },
        ],
        answers: {
          kind: "response",
          referenceMd: "S 市议事协商做法的主要特点：\n\n1. **化整为零**……",
          variantsMd: ["若按「协商前—协商中—协商后」时序作答亦可……"],
        },
      }),
    );
    expect(parsed.wordMin).toBe(150);
    expect(parsed.answers).toEqual({
      kind: "response",
      referenceMd: "S 市议事协商做法的主要特点：\n\n1. **化整为零**……",
      variantsMd: ["若按「协商前—协商中—协商后」时序作答亦可……"],
    });
    // 题级 ::ref 产物（域①遗漏、本批补齐）：区间选择串原样保留
    expect(
      materialRefSchema.safeParse({ material: "mat-1", segs: "seg-1..seg-2" })
        .success,
    ).toBe(true);
  });

  it("题级 materialRefs 挂载在 questionSchema（::ref allowedIn: group/question，§5.2.2）", () => {
    // 完形子题逐空绑定：slot 单槽（解析输出必须保留，不能被 strip 吞掉）
    const cloze = questionSchema.parse(
      q("xk-1", "choice", {
        materialRefs: [{ material: "mat-1", slot: "slot-1" }],
      }),
    );
    expect(cloze.materialRefs).toEqual([{ material: "mat-1", slot: "slot-1" }]);
    // matching 槽位集合：slots 区间
    const matching = questionSchema.parse(
      q("qx-1", "matching", {
        materialRefs: [{ material: "mat-1", slots: "slot-1..slot-5" }],
      }),
    );
    expect(matching.materialRefs).toEqual([
      { material: "mat-1", slots: "slot-1..slot-5" },
    ]);
    // 旧七型题目不携带（缺省不注入键，键集不变）
    const legacy = questionSchema.parse(
      q("练习-1", "judge", { answers: { kind: "judge", value: true } }),
    );
    expect("materialRefs" in legacy).toBe(false);
  });
});

describe("语料 × 判分策略冻结（§5.6 D11：域④语义与语料互证）", () => {
  it("valid-07 两问：有参考 response → reference_self；无参考 solve → manual_only", () => {
    expect(
      gradingPolicyOf({
        type: "response",
        answers: { kind: "response", referenceMd: "证明……" },
      }),
    ).toBe("reference_self");
    expect(gradingPolicyOf({ type: "solve" })).toBe("manual_only");
  });

  it("valid-06 翻译/作文多参考表达不改变策略（有参考恒 reference_self）", () => {
    expect(
      gradingPolicyOf({
        type: "response",
        answers: {
          kind: "response",
          referenceMd: "译文",
          variantsMd: ["另一种译法"],
        },
      }),
    ).toBe("reference_self");
  });
});
