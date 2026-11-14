import { describe, expect, it } from "vitest";
import {
  REVIEW_V2_SECTIONS,
  reviewV2CreateSchema,
  reviewV2ReportSchema,
} from "./attempt-review-v2.ts";

describe("范围复盘v2契约", () => {
  it("范围严格且不允许把批次伪装成全卷", () => {
    expect(
      reviewV2CreateSchema.safeParse({
        mutationId: "retry",
        purpose: "复盘",
        profile: "objective",
        scope: { kind: "settlement", seq: 2 },
      }).success,
    ).toBe(true);
    expect(
      reviewV2CreateSchema.safeParse({
        mutationId: "retry",
        purpose: "复盘",
        profile: "objective",
        scope: { kind: "attempt", seq: 2 },
      }).success,
    ).toBe(false);
    expect(
      reviewV2CreateSchema.safeParse({
        mutationId: "retry",
        purpose: "复盘",
        profile: "objective",
        scope: { kind: "settlement", seq: 0 },
      }).success,
    ).toBe(false);
  });
  it("报告分节严格跟随profile并拒绝重复和空节", () => {
    const report = {
      schemaVersion: 2,
      profile: "essay",
      sections: REVIEW_V2_SECTIONS.essay.map((section) => ({
        ...section,
        markdown: "观察",
        evidenceQuestionNos: [31],
      })),
      limitations: ["未提供笔迹图像"],
    };
    expect(reviewV2ReportSchema.safeParse(report).success).toBe(true);
    expect(
      reviewV2ReportSchema.safeParse({
        ...report,
        sections: report.sections.slice(1),
      }).success,
    ).toBe(false);
    expect(
      reviewV2ReportSchema.safeParse({
        ...report,
        sections: [...report.sections, report.sections[0]],
      }).success,
    ).toBe(false);
    expect(
      reviewV2ReportSchema.safeParse({ ...report, schemaVersion: 1 }).success,
    ).toBe(false);
  });
});
