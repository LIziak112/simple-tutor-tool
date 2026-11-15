import { describe, expect, it } from "vitest";
import { studentMcpSubmitInputSchema } from "./student-mcp-submit.ts";

const base = {
  practiceId: "11111111-1111-4111-8111-111111111111",
  questionId: "q1",
  workflowVersion: 1,
  workflowRevision: 0,
  questionRevisionId: "opaque-row",
  expectedAnswerRevision: 0,
  evidence: { questionId: "q1", state: "none" },
};
const key = "22222222-2222-4222-8222-222222222222";
describe("MCP 提交版本兼容", () => {
  it("旧请求保留必填幂等键", () => {
    expect(studentMcpSubmitInputSchema.safeParse(base).success).toBe(false);
    expect(
      studentMcpSubmitInputSchema.safeParse({
        ...base,
        submissionMutationId: key,
      }).success,
    ).toBe(true);
  });
  it("v2 允许省键及仅题序定位，证据和版本仍必填", () => {
    expect(
      studentMcpSubmitInputSchema.safeParse({ ...base, responseVersion: 2 })
        .success,
    ).toBe(true);
    const { questionId: _, ...numbered } = base;
    expect(
      studentMcpSubmitInputSchema.safeParse({
        ...numbered,
        responseVersion: 2,
        questionNo: 1,
      }).success,
    ).toBe(true);
    expect(
      studentMcpSubmitInputSchema.safeParse({ ...numbered, responseVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      studentMcpSubmitInputSchema.safeParse({
        ...base,
        responseVersion: 2,
        evidence: undefined,
      }).success,
    ).toBe(false);
  });
  it("拒绝未知版本、字段和旧协议题序", () => {
    for (const input of [
      { ...base, responseVersion: 3, submissionMutationId: key },
      { ...base, responseVersion: 2, rogue: true },
      { ...base, questionNo: 1, submissionMutationId: key },
    ])
      expect(studentMcpSubmitInputSchema.safeParse(input).success).toBe(false);
  });
});
