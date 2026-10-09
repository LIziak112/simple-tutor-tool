import { describe, expect, it } from "vitest";
import {
  ALL_ENABLED_CAPABILITIES,
  capabilitiesManifestSchema,
  capabilityProfileSchema,
  capabilitySwitchSchema,
  questionCapabilityBindings,
  questionCapabilityBindingsSchema,
} from "./capability";
import { questionTypeSchema } from "./content";
import { listDirectives } from "./directives";

/**
 * 能力三面词表与题型桥接表测试（T7.4 / 方案 §4.3）：
 * - 七种题型均有桥接表项，键与词表均来自契约（questionTypeSchema）；
 * - 表项字段严格对照方案 §4.3 桥接表：客观三型 choice+snapshot+同名+exact、
 *   fill 人工 rubric、手写三型 ink+ink-strokes+同名+exact；
 * - evidence.format 是"可采集形式"的声明（手写未书写是否容忍属 T7.5 判分行为）；
 * - 题型名不是注册指令（choice 等只出现在题型表，不进指令注册表）。
 */

describe("questionCapabilityBindings（T7.4 题型桥接表）", () => {
  it("七种题型表项齐全，键集合与 questionTypeSchema 选项一致（名称来自契约）", () => {
    expect(Object.keys(questionCapabilityBindings).sort()).toEqual(
      [...questionTypeSchema.options].sort(),
    );
  });

  it("表项通过自身 schema（round-trip），且 validatorId 与题型同名", () => {
    const parsed = questionCapabilityBindingsSchema.parse(
      questionCapabilityBindings,
    );
    expect(parsed).toEqual(questionCapabilityBindings);
    for (const [type, binding] of Object.entries(questionCapabilityBindings)) {
      expect(binding.validatorId, `${type} 的 validatorId 应与题型同名`).toBe(
        type,
      );
    }
  });

  it("客观题（judge/choice/multi）：choice 输入 + snapshot 证据 + exact 判分", () => {
    for (const type of ["judge", "choice", "multi"] as const) {
      expect(questionCapabilityBindings[type]).toEqual({
        inputType: "choice",
        evidence: { format: "snapshot" },
        validatorId: type,
        validation: { shape: "exact" },
      });
    }
  });

  it("填空题（fill）：fill 输入 + snapshot 证据 + rubric（人工批改，无自动判分）", () => {
    expect(questionCapabilityBindings.fill).toEqual({
      inputType: "fill",
      evidence: { format: "snapshot" },
      validatorId: "fill",
      validation: { shape: "rubric" },
    });
  });

  it("手写题（solve/apply/find-error）：ink 输入 + ink-strokes 证据 + exact（最终答案）", () => {
    for (const type of ["solve", "apply", "find-error"] as const) {
      expect(questionCapabilityBindings[type]).toEqual({
        inputType: "ink",
        evidence: { format: "ink-strokes" },
        validatorId: type,
        validation: { shape: "exact" },
      });
    }
  });

  it("表内无 partial 声明（词表保留但本阶段无实现无声明）", () => {
    for (const binding of Object.values(questionCapabilityBindings)) {
      expect(binding.validation.shape).not.toBe("partial");
    }
  });

  it("缺一种题型的表无法通过 schema（穷尽 Record，防未来加题型漏配）", () => {
    const incomplete = { ...questionCapabilityBindings } as Record<
      string,
      (typeof questionCapabilityBindings)[keyof typeof questionCapabilityBindings]
    >;
    delete incomplete.judge;
    expect(questionCapabilityBindingsSchema.safeParse(incomplete).success).toBe(
      false,
    );
  });

  it("多出非题型的键同样被拒（键封闭于 questionTypeSchema）", () => {
    const withGhost = {
      ...questionCapabilityBindings,
      essay: questionCapabilityBindings.fill,
    };
    expect(questionCapabilityBindingsSchema.safeParse(withGhost).success).toBe(
      false,
    );
  });
});

describe("题型与指令的边界（不把 choice 当注册指令）", () => {
  it("题型名集合与指令主名集合交集为空", () => {
    const directiveNames = new Set(listDirectives().map((d) => d.name));
    for (const type of questionTypeSchema.options) {
      expect(
        directiveNames.has(type),
        `题型 ${type} 不应同时是注册指令名`,
      ).toBe(false);
    }
  });
});

describe("能力清单 schema（T7.6 / 方案 §4.4）", () => {
  /** 最小合法清单：一条未声明能力的指令 + 一条已声明指令 + 七型题型表 */
  const minimalManifest = {
    formatVersion: 1,
    directives: [
      {
        name: "tip",
        kind: "container",
        attrs: [],
        capability: null,
      },
      {
        name: "blank",
        kind: "text",
        attrs: [
          {
            name: "answer",
            type: "string",
            required: true,
            description: "填空答案",
          },
          {
            name: "difficulty",
            type: "number",
            required: false,
            default: 2,
            description: "难度",
          },
        ],
        capability: {
          interaction: { inputType: "fill" },
          evidence: { format: "snapshot" },
        },
      },
    ],
    questionTypes: questionCapabilityBindings,
  };

  it("最小合法清单通过（capability null=未声明；attrs 空数组合法；default 为原始值）", () => {
    expect(capabilitiesManifestSchema.safeParse(minimalManifest).success).toBe(
      true,
    );
  });

  it("formatVersion 只认 1（版本演进时显式升版）", () => {
    expect(
      capabilitiesManifestSchema.safeParse({
        ...minimalManifest,
        formatVersion: 2,
      }).success,
    ).toBe(false);
  });

  it("条目缺 capability 键被拒（null 是显式值，不是缺省）", () => {
    const noCap = {
      ...minimalManifest,
      directives: [{ name: "tip", kind: "container", attrs: [] }],
    };
    expect(capabilitiesManifestSchema.safeParse(noCap).success).toBe(false);
  });

  it("拼错键被 strictObject 拒绝（safeParse 入参为 unknown，此处只有 zod 闸）", () => {
    expect(
      capabilitiesManifestSchema.safeParse({
        ...minimalManifest,
        formatversion: 1,
      }).success,
    ).toBe(false);
  });

  it("questionTypes 少一种题型即整份清单被拒（复用穷尽 Record）", () => {
    const incomplete = { ...questionCapabilityBindings } as Record<
      string,
      (typeof questionCapabilityBindings)[keyof typeof questionCapabilityBindings]
    >;
    delete incomplete.multi;
    expect(
      capabilitiesManifestSchema.safeParse({
        ...minimalManifest,
        questionTypes: incomplete,
      }).success,
    ).toBe(false);
  });
});

describe("能力启用集 profile（T7.7 / 方案 §4.5）", () => {
  it("默认全启用的常量形态：steps 与 ink（choice/fill 是正式作答不出现在开关中）", () => {
    expect(ALL_ENABLED_CAPABILITIES).toEqual(["steps", "ink"]);
    expect(capabilitySwitchSchema.options).toEqual(["steps", "ink"]);
  });

  it("两项全启用、单项、空数组都合法（空数组=显式全关）", () => {
    expect(
      capabilityProfileSchema.safeParse({
        enabledCapabilities: ["steps", "ink"],
      }).success,
    ).toBe(true);
    expect(
      capabilityProfileSchema.safeParse({ enabledCapabilities: ["ink"] })
        .success,
    ).toBe(true);
    expect(
      capabilityProfileSchema.safeParse({ enabledCapabilities: [] }).success,
    ).toBe(true);
  });

  it("重复开关被拒（语义要求显式，不静默去重）", () => {
    expect(
      capabilityProfileSchema.safeParse({
        enabledCapabilities: ["steps", "steps"],
      }).success,
    ).toBe(false);
  });

  it("非法开关名被拒（choice/fill 等正式作答能力不在开关词表）", () => {
    expect(
      capabilityProfileSchema.safeParse({ enabledCapabilities: ["choice"] })
        .success,
    ).toBe(false);
    expect(
      capabilityProfileSchema.safeParse({ enabledCapabilities: ["ink ", ""] })
        .success,
    ).toBe(false);
  });

  it("拼错键被 strictObject 拒绝", () => {
    expect(
      capabilityProfileSchema.safeParse({ enabledcapabilities: [] }).success,
    ).toBe(false);
  });
});
