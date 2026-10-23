import { describe, expect, it } from "vitest";
import {
  attemptStartOptionsRequestSchema,
  practiceFeedbackModeSchema,
  practiceLayoutSchema,
  practiceQuestionProgressSchema,
  practiceRecommendationSchema,
  practiceWorkflowSchema,
  practiceWorkflowUpdateRequestSchema,
  studentPracticePreferenceSchema,
  teacherPracticeFeedbackPolicySchema,
  teacherPracticeFeedbackSettingsSchema,
  teacherPracticeFeedbackSettingsUpdateRequestSchema,
} from "./practice-workflow.ts";

/** 合法 workflow 投影样例（各 schema 行为断言的公共基底） */
const validWorkflow = {
  version: 1,
  feedbackMode: "per_question",
  revision: 0,
  canChangeFeedback: true,
  allowedFeedbackModes: ["per_question", "after_attempt"],
  canSubmitQuestion: true,
  restrictionReason: null,
  releaseAt: null,
};

describe("practiceLayoutSchema", () => {
  it("接受 list 与 single，拒绝其他值", () => {
    expect(practiceLayoutSchema.parse("list")).toBe("list");
    expect(practiceLayoutSchema.parse("single")).toBe("single");
    expect(() => practiceLayoutSchema.parse("grid")).toThrow();
  });
});

describe("practiceRecommendationSchema（M5-D1 frontmatter practice 推荐命名空间）", () => {
  it("两字段均可选：全缺（空对象）与缺一都合法——不过度设计，空声明不构成错误", () => {
    expect(practiceRecommendationSchema.parse({})).toEqual({});
    expect(practiceRecommendationSchema.parse({ layout: "single" })).toEqual({
      layout: "single",
    });
    expect(
      practiceRecommendationSchema.parse({ feedback: "after_attempt" }),
    ).toEqual({ feedback: "after_attempt" });
    expect(
      practiceRecommendationSchema.parse({
        layout: "list",
        feedback: "per_question",
      }),
    ).toEqual({ layout: "list", feedback: "per_question" });
  });

  it("枚举值非法即拒绝；未知键拒绝（strict，与教学策略配置同严口径）", () => {
    expect(
      practiceRecommendationSchema.safeParse({ layout: "grid" }).success,
    ).toBe(false);
    expect(
      practiceRecommendationSchema.safeParse({ feedback: "immediate" }).success,
    ).toBe(false);
    expect(
      practiceRecommendationSchema.safeParse({
        layout: "single",
        unknown: true,
      }).success,
    ).toBe(false);
  });
});

describe("practiceFeedbackModeSchema", () => {
  it("接受 per_question 与 after_attempt，拒绝其他值", () => {
    expect(practiceFeedbackModeSchema.parse("per_question")).toBe(
      "per_question",
    );
    expect(practiceFeedbackModeSchema.parse("after_attempt")).toBe(
      "after_attempt",
    );
    expect(() => practiceFeedbackModeSchema.parse("immediate")).toThrow();
  });
});

describe("teacherPracticeFeedbackPolicySchema", () => {
  it("接受 student_choice 与 after_attempt，拒绝其他值", () => {
    expect(teacherPracticeFeedbackPolicySchema.parse("student_choice")).toBe(
      "student_choice",
    );
    expect(teacherPracticeFeedbackPolicySchema.parse("after_attempt")).toBe(
      "after_attempt",
    );
    expect(() =>
      teacherPracticeFeedbackPolicySchema.parse("on_submit"),
    ).toThrow();
  });
});

describe("studentPracticePreferenceSchema", () => {
  const valid = {
    version: 1,
    layout: "list",
    feedback: "per_question",
    keyboardShortcuts: true,
  };

  it("接受合法 v1 偏好", () => {
    expect(studentPracticePreferenceSchema.parse(valid)).toEqual(valid);
  });

  it("strict：拒绝未知字段", () => {
    expect(() =>
      studentPracticePreferenceSchema.parse({ ...valid, extra: 1 }),
    ).toThrow();
  });

  it("拒绝 version 2 与非法枚举", () => {
    expect(() =>
      studentPracticePreferenceSchema.parse({ ...valid, version: 2 }),
    ).toThrow();
    expect(() =>
      studentPracticePreferenceSchema.parse({ ...valid, layout: "grid" }),
    ).toThrow();
    expect(() =>
      studentPracticePreferenceSchema.parse({ ...valid, feedback: "fast" }),
    ).toThrow();
  });
});

describe("practiceWorkflowSchema", () => {
  it("接受合法投影（releaseAt 可为 ISO 截止时间）", () => {
    expect(
      practiceWorkflowSchema.parse({
        ...validWorkflow,
        releaseAt: "2026-11-01T00:00:00.000Z",
      }),
    ).toMatchObject({ releaseAt: "2026-11-01T00:00:00.000Z" });
  });

  it("拒绝负数 revision、空 allowedFeedbackModes 与重复项", () => {
    expect(() =>
      practiceWorkflowSchema.parse({ ...validWorkflow, revision: -1 }),
    ).toThrow();
    expect(() =>
      practiceWorkflowSchema.parse({
        ...validWorkflow,
        allowedFeedbackModes: [],
      }),
    ).toThrow();
    expect(() =>
      practiceWorkflowSchema.parse({
        ...validWorkflow,
        allowedFeedbackModes: ["per_question", "per_question"],
      }),
    ).toThrow();
  });

  it("releaseAt 仅接受 UTC ISO（Z 后缀）或 null，拒绝无时区/+08:00 偏移/非法字符串", () => {
    expect(() =>
      practiceWorkflowSchema.parse({
        ...validWorkflow,
        releaseAt: "not-a-date",
      }),
    ).toThrow();
    expect(() =>
      practiceWorkflowSchema.parse({
        ...validWorkflow,
        releaseAt: "2026-11-01T00:00:00",
      }),
    ).toThrow();
    expect(() =>
      practiceWorkflowSchema.parse({
        ...validWorkflow,
        releaseAt: "2026-11-01T08:00:00+08:00",
      }),
    ).toThrow();
    expect(
      practiceWorkflowSchema.parse({ ...validWorkflow, releaseAt: null }),
    ).toMatchObject({ releaseAt: null });
  });

  it("restrictionReason 仅限三种受限原因或 null；feedbackMode 不得使用", () => {
    expect(() =>
      practiceWorkflowSchema.parse({
        ...validWorkflow,
        restrictionReason: "teacher_relaxed",
      }),
    ).toThrow();
  });

  it("strict：拒绝未知字段（如夹带得分/答案类字段）", () => {
    expect(() =>
      practiceWorkflowSchema.parse({ ...validWorkflow, score: 90 }),
    ).toThrow();
    expect(() =>
      practiceWorkflowSchema.parse({ ...validWorkflow, autoCorrect: true }),
    ).toThrow();
  });
});

describe("practiceQuestionProgressSchema", () => {
  it("接受白名单字段：questionId/submittedAt/feedbackReadable", () => {
    expect(
      practiceQuestionProgressSchema.parse({
        questionId: "q1",
        submittedAt: "2026-10-22T00:00:00.000Z",
        feedbackReadable: true,
      }),
    ).toMatchObject({ questionId: "q1" });
  });

  it("submittedAt 可空（未提交）；strict 拒绝答案/得分/教师批注字段", () => {
    expect(
      practiceQuestionProgressSchema.parse({
        questionId: "q1",
        submittedAt: null,
        feedbackReadable: false,
      }),
    ).toMatchObject({ submittedAt: null });
    expect(() =>
      practiceQuestionProgressSchema.parse({
        questionId: "q1",
        submittedAt: null,
        feedbackReadable: false,
        autoCorrect: true,
      }),
    ).toThrow();
    expect(() =>
      practiceQuestionProgressSchema.parse({
        questionId: "q1",
        submittedAt: null,
        feedbackReadable: false,
        answer: "A",
      }),
    ).toThrow();
    expect(() =>
      practiceQuestionProgressSchema.parse({
        questionId: "q1",
        submittedAt: null,
        feedbackReadable: false,
        teacherComment: "好",
      }),
    ).toThrow();
  });
  it("跨字段约束：submittedAt 为 null 时 feedbackReadable 必须为 false", () => {
    expect(() =>
      practiceQuestionProgressSchema.parse({
        questionId: "q1",
        submittedAt: null,
        feedbackReadable: true,
      }),
    ).toThrow();
  });

  it("已提交但当前不可读合法（教师收紧/节奏不允许时不放行反馈）", () => {
    expect(
      practiceQuestionProgressSchema.parse({
        questionId: "q1",
        submittedAt: "2026-10-22T00:00:00.000Z",
        feedbackReadable: false,
      }),
    ).toMatchObject({ feedbackReadable: false });
  });

  it("submittedAt 仅接受 UTC ISO（Z 后缀）或 null，拒绝无时区/+08:00 偏移/非法字符串", () => {
    for (const bad of [
      "not-a-date",
      "2026-10-22T00:00:00",
      "2026-10-22T08:00:00+08:00",
    ]) {
      expect(() =>
        practiceQuestionProgressSchema.parse({
          questionId: "q1",
          submittedAt: bad,
          feedbackReadable: false,
        }),
      ).toThrow();
    }
  });
});

describe("practiceWorkflowUpdateRequestSchema", () => {
  it("接受 feedbackMode + 非负 workflowRevision，strict 拒绝未知字段", () => {
    expect(
      practiceWorkflowUpdateRequestSchema.parse({
        feedbackMode: "after_attempt",
        workflowRevision: 3,
      }),
    ).toMatchObject({ feedbackMode: "after_attempt" });
    expect(() =>
      practiceWorkflowUpdateRequestSchema.parse({
        feedbackMode: "after_attempt",
        workflowRevision: -1,
      }),
    ).toThrow();
    expect(() =>
      practiceWorkflowUpdateRequestSchema.parse({
        feedbackMode: "per_question",
        workflowRevision: 0,
        answerRelease: "on_submit",
      }),
    ).toThrow();
  });
});

describe("teacherPracticeFeedbackSettingsSchema（M1b）", () => {
  it("读取：policy 可空（null=未配置），strict 拒绝未知字段", () => {
    expect(
      teacherPracticeFeedbackSettingsSchema.parse({
        practiceFeedbackPolicy: "after_attempt",
      }),
    ).toEqual({ practiceFeedbackPolicy: "after_attempt" });
    expect(
      teacherPracticeFeedbackSettingsSchema.parse({
        practiceFeedbackPolicy: null,
      }),
    ).toEqual({ practiceFeedbackPolicy: null });
    expect(() =>
      teacherPracticeFeedbackSettingsSchema.parse({
        practiceFeedbackPolicy: "on_submit",
      }),
    ).toThrow();
    expect(() =>
      teacherPracticeFeedbackSettingsSchema.parse({
        practiceFeedbackPolicy: null,
        steps: true,
      }),
    ).toThrow();
  });

  it("写入：policy 必填枚举，缺省/未知拒绝", () => {
    expect(
      teacherPracticeFeedbackSettingsUpdateRequestSchema.parse({
        practiceFeedbackPolicy: "student_choice",
      }),
    ).toEqual({ practiceFeedbackPolicy: "student_choice" });
    expect(() =>
      teacherPracticeFeedbackSettingsUpdateRequestSchema.parse({}),
    ).toThrow();
    expect(() =>
      teacherPracticeFeedbackSettingsUpdateRequestSchema.parse({
        practiceFeedbackPolicy: null,
      }),
    ).toThrow();
  });
});

describe("建卷可选工作流选项（M1b）", () => {
  it("attemptStartOptionsRequestSchema：空对象合法（旧协议）", () => {
    expect(attemptStartOptionsRequestSchema.parse({})).toEqual({});
  });

  it("携带 workflowVersion=1 合法；非 1 拒绝", () => {
    expect(
      attemptStartOptionsRequestSchema.parse({ workflowVersion: 1 }),
    ).toEqual({ workflowVersion: 1 });
    expect(() =>
      attemptStartOptionsRequestSchema.parse({ workflowVersion: 2 }),
    ).toThrow();
  });

  it("feedbackMode 有值但无 workflowVersion=1 拒绝（不得暗中升级协议）", () => {
    expect(
      attemptStartOptionsRequestSchema.parse({
        workflowVersion: 1,
        feedbackMode: "after_attempt",
      }),
    ).toEqual({ workflowVersion: 1, feedbackMode: "after_attempt" });
    for (const body of [
      { feedbackMode: "per_question" },
      { feedbackMode: "per_question", workflowVersion: 2 },
    ]) {
      expect(() => attemptStartOptionsRequestSchema.parse(body)).toThrow();
    }
  });

  it("strict 拒绝未知字段", () => {
    expect(() =>
      attemptStartOptionsRequestSchema.parse({
        workflowVersion: 1,
        layout: "single",
      }),
    ).toThrow();
  });
});
