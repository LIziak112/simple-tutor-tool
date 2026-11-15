import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as contract from "./index.ts";

// 从公开入口验契约，红阶段缺失导出也作为实际用例失败，不以零用例代替。
function schema(name: string): z.ZodType {
  const candidate = (contract as unknown as Record<string, unknown>)[name];
  expect(candidate, `${name} 应从 contract 公开导出`).toBeDefined();
  return candidate as z.ZodType;
}

const practiceId = "10000000-0000-4000-8000-000000000001";
const revisionId = "10000000-0000-4000-8000-000000000002";
const noteVersion = "10000000-0000-4000-8000-000000000003";
const workflow = {
  version: 1,
  feedbackMode: "per_question",
  revision: 2,
  canChangeFeedback: true,
  allowedFeedbackModes: ["per_question", "after_attempt"],
  canSubmitQuestion: true,
  restrictionReason: null,
  releaseAt: null,
};

describe("学生 MCP 公开读取契约", () => {
  it("目录版本引用复用既有opaque ref SSOT，不自行收窄UUID", () => {
    const reference =
      contract.studentMcpPracticeDataSchema.shape.questions.element.shape
        .questionRevisionId;
    expect(reference).toBe(contract.questionRevisionIdSchema);
    expect(reference.safeParse("opaque-response-reference").success).toBe(true);
    expect(reference.safeParse(" padded-reference ").success).toBe(false);
  });
  it("列表仅接受有界分页与既有状态，不接受身份和伪阶段", () => {
    const input = schema("studentMcpPracticeListInputSchema");
    expect(input.safeParse({}).success).toBe(true);
    expect(
      input.safeParse({ limit: 50, offset: 0, status: "draft" }).success,
    ).toBe(true);
    for (const invalid of [
      { limit: 0 },
      { limit: 51 },
      { offset: -1 },
      { status: "active" },
      { studentId: "伪造" },
    ]) {
      expect(input.safeParse(invalid).success).toBe(false);
    }
  });

  it("单题可以按长DSL id或正题序定位，至少提供一种定位", () => {
    const input = schema("studentMcpPracticeQuestionReadInputSchema");
    const questionId = `题.${"长".repeat(600)}`;
    expect(input.parse({ practiceId, questionId })).toEqual({
      practiceId,
      questionId,
    });
    expect(
      input.safeParse({ practiceId, questionNo: 2, includeImages: false })
        .success,
    ).toBe(true);
    expect(input.safeParse({ practiceId }).success).toBe(false);
    expect(input.safeParse({ practiceId, questionNo: 0 }).success).toBe(false);
    expect(
      input.safeParse({ practiceId, questionId, connectionId: practiceId })
        .success,
    ).toBe(false);
  });

  it("可用提交参数复用完整CAS与三态证据，不伪造幂等键或missing", () => {
    const input = schema("studentMcpPracticeSubmitParametersSchema");
    const parameters = {
      practiceId,
      questionId: "题-1",
      workflowVersion: 1,
      workflowRevision: 2,
      questionRevisionId: revisionId,
      expectedAnswerRevision: 7,
      evidence: {
        questionId: "题-1",
        state: "frozen",
        versionId: noteVersion,
        revision: 3,
      },
    };
    expect(input.parse(parameters)).toEqual(parameters);
    expect(
      input.safeParse({ ...parameters, evidence: undefined }).success,
    ).toBe(false);
    expect(
      input.safeParse({ ...parameters, expectedAnswerRevision: undefined })
        .success,
    ).toBe(false);
    expect(
      input.safeParse({
        ...parameters,
        evidence: { questionId: "题-1", state: "frozen", revision: 0 },
      }).success,
    ).toBe(false);
    expect(
      input.safeParse({ ...parameters, submissionMutationId: practiceId })
        .success,
    ).toBe(false);
  });

  it("目录保留真实结算序号但不把partial/phase当授权", () => {
    const output = schema("studentMcpPracticeDataSchema");
    const data = {
      schemaVersion: 1,
      practiceId,
      title: "公开目录",
      status: "draft",
      sourceType: "wrong",
      practiceWorkflow: workflow,
      questions: [
        {
          questionNo: 1,
          questionId: "题-1",
          questionRevisionId: revisionId,
          type: "choice",
          stemExcerpt: "公开题干",
          state: "submitted",
          settlementSeq: 3,
        },
      ],
    };
    expect(output.parse(data)).toEqual(data);
    expect(
      output.safeParse({ ...data, canSettlePartially: true }).success,
    ).toBe(false);
    expect(output.safeParse({ ...data, phase: "active" }).success).toBe(false);
  });

  it.each(["answers", "solutionMd", "teacherComment", "autoCorrect", "score"])(
    "目录拒绝额外秘密字段 %s",
    (key) => {
      const output = schema("studentMcpPracticeDataSchema");
      expect(
        output.safeParse({
          schemaVersion: 1,
          practiceId,
          title: "目录",
          status: "draft",
          sourceType: "wrong",
          practiceWorkflow: workflow,
          questions: [
            {
              questionNo: 1,
              questionId: "题-1",
              questionRevisionId: revisionId,
              type: "choice",
              stemExcerpt: "题干",
              state: "unanswered",
              settlementSeq: null,
              [key]: "不应出现",
            },
          ],
        }).success,
      ).toBe(false);
    },
  );

  it("列表返回既有draft状态和纯进度，不夹带判定统计", () => {
    const output = schema("studentMcpPracticeListDataSchema");
    const item = {
      practiceId,
      title: "练习",
      sourceType: "wrong",
      status: "draft",
      startedAt: "2026-11-14T00:00:00.000Z",
      submittedAt: null,
      answerProgress: { answeredCount: 1, totalCount: 3 },
      submissionProgress: { submittedCount: 0, totalCount: 3 },
      practiceWorkflow: workflow,
    };
    const data = { schemaVersion: 1, practices: [item], total: 1 };
    expect(output.parse(data)).toEqual(data);
    expect(
      output.safeParse({ ...data, practices: [{ ...item, score: 100 }] })
        .success,
    ).toBe(false);
  });

  it("单题公开载荷的上下文也拒绝额外字段，题序不能和会话坐标相互矛盾", () => {
    const output = schema("studentMcpPracticeQuestionDataSchema");
    const context = {
      schemaVersion: 1,
      content: {
        courseId: null,
        unitId: null,
        lectureId: null,
        sectionId: null,
        questionId: "q-1",
        titles: { course: null, unit: null, lecture: null },
      },
      session: {
        attemptId: practiceId,
        questionRevisionId: revisionId,
        questionNo: 1,
        questionCount: 1,
        settlementSeq: 2,
      },
      view: null,
      deviceId: null,
    };
    const data = {
      schemaVersion: 1,
      practiceId,
      questionNo: 1,
      questionCount: 1,
      question: {
        id: "q-1",
        questionRevisionId: revisionId,
        type: "choice",
        difficulty: 2,
        knowledge: [],
        stemMd: "公开题",
        options: ["甲", "乙"],
        hintCount: 0,
      },
      materials: [],
      currentAnswer: null,
      context,
      practiceWorkflow: workflow,
      submittedAt: "2026-11-14T00:00:00.000Z",
      submission: { available: false, reason: "QUESTION_ALREADY_SUBMITTED" },
      imagesIncluded: false,
      images: [],
    };
    expect(output.parse(data)).toEqual(data);
    expect(
      output.safeParse({
        ...data,
        context: { ...context, teacherComment: "私注" },
      }).success,
    ).toBe(false);
    expect(output.safeParse({ ...data, questionNo: 2 }).success).toBe(false);
    expect(
      output.safeParse({
        ...data,
        question: { ...data.question, answers: { kind: "choice", index: 1 } },
      }).success,
    ).toBe(false);
  });
});
