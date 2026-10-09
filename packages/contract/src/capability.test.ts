import { describe, expect, it } from "vitest";
import { questionTypeSchema } from "./content";
import { listDirectives } from "./directives";
import {
  questionCapabilityBindings,
  questionCapabilityBindingsSchema,
} from "./capability";

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
    expect(
      questionCapabilityBindingsSchema.safeParse(incomplete).success,
    ).toBe(false);
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
