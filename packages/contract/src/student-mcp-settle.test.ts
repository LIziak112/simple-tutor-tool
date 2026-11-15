import { describe, expect, it } from "vitest";
import { attemptPartialRequestSchema } from "./attempt-partial.ts";
import { studentMcpSettleInputSchema } from "./student-mcp-settle.ts";

const request = {
  practiceId: "11111111-1111-4111-8111-111111111111",
  workflowVersion: 1,
  workflowRevision: 2,
  mutationId: "22222222-2222-4222-8222-222222222222",
  questions: [
    {
      questionId: "q1",
      questionRevisionId: "opaque-ref",
      expectedAnswerRevision: 0,
      evidence: { state: "none", questionId: "q1" },
    },
  ],
};
describe("MCP 分批契约", () => {
  it("复用HTTP题目CAS/证据，空数组可归批；身份、临时答案、未知字段拒绝", () => {
    expect(studentMcpSettleInputSchema.parse(request)).toEqual(request);
    expect(
      studentMcpSettleInputSchema.safeParse({ ...request, questions: [] })
        .success,
    ).toBe(true);
    const { practiceId: _, ...http } = request;
    expect(attemptPartialRequestSchema.parse(http)).toEqual(http);
    for (const invalid of [
      { ...request, studentId: request.practiceId },
      { ...request, connectionId: request.practiceId },
      { ...request, mutationId: undefined },
      { ...request, questions: [request.questions[0], request.questions[0]] },
      {
        ...request,
        questions: [
          { ...request.questions[0], answer: { kind: "choice", index: 1 } },
        ],
      },
      {
        ...request,
        questions: [{ ...request.questions[0], evidence: undefined }],
      },
    ])
      expect(studentMcpSettleInputSchema.safeParse(invalid).success).toBe(
        false,
      );
  });
});
