import { expect, it } from "vitest";
import {
  REVIEW_TEMPLATE_PRESETS,
  resolveReviewTemplate,
  reviewTemplateSchema,
} from "./review-template.ts";

it("四套预设合法，分区id唯一，profile与报告v2同名", () => {
  expect(REVIEW_TEMPLATE_PRESETS.map((t) => t.id)).toEqual([
    "objective",
    "exam",
    "material",
    "longform",
  ]);
  for (const preset of REVIEW_TEMPLATE_PRESETS)
    expect(reviewTemplateSchema.safeParse(preset).success).toBe(true);
  expect(REVIEW_TEMPLATE_PRESETS[3]?.agentReport?.profile).toBe("essay");
});
it("显式单元优先课程、考试标签优先题型，非法配置回退并提示", () => {
  const base = { questionTypes: ["response" as const], hasMaterials: true };
  expect(
    resolveReviewTemplate({
      ...base,
      unitTemplateIds: ["exam"],
      templateId: "material",
      examType: "行测",
    }).template.id,
  ).toBe("exam");
  expect(
    resolveReviewTemplate({ ...base, templateId: "material", examType: "行测" })
      .template.id,
  ).toBe("material");
  expect(resolveReviewTemplate({ ...base, examType: "行测" }).template.id).toBe(
    "exam",
  );
  expect(resolveReviewTemplate(base).template.id).toBe("longform");
  expect(
    resolveReviewTemplate({ ...base, templateId: "不存在" }),
  ).toMatchObject({
    template: { id: "objective" },
    warning: expect.any(String),
  });
  expect(
    resolveReviewTemplate({ ...base, unitTemplateIds: ["exam", "material"] })
      .warning,
  ).not.toBeNull();
});
it("非法或重复分区拒绝，显隐与顺序属于声明配置", () => {
  const preset = REVIEW_TEMPLATE_PRESETS[0]!;
  expect(
    reviewTemplateSchema.safeParse({
      ...preset,
      sections: [{ id: "a", kind: "unknown", visible: true, options: {} }],
    }).success,
  ).toBe(false);
  expect(
    reviewTemplateSchema.safeParse({
      ...preset,
      sections: [preset.sections[0], preset.sections[0]],
    }).success,
  ).toBe(false);
  expect(
    reviewTemplateSchema.safeParse({
      ...preset,
      sections: [...preset.sections]
        .reverse()
        .map((s) => ({ ...s, visible: false })),
    }).success,
  ).toBe(true);
});
