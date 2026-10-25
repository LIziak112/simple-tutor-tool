import { describe, expect, it } from "vitest";
import { attemptResultQuestionSchema } from "./attempt.ts";
import {
  practiceQuestionFeedbackDataSchema,
  practiceQuestionFeedbackSchema,
  practiceQuestionSubmitDataSchema,
  practiceQuestionSubmitOkSchema,
  practiceQuestionSubmitRequestSchema,
} from "./practice-question-submit.ts";
import {
  practiceWorkflowSchema as m1WorkflowSchema,
  practiceQuestionProgressSchema,
} from "./practice-workflow.ts";

/**
 * M2 逐题提交与题级反馈契约测试（2026-10-22 计划 §6.1/§10.1–10.4）：
 * - 请求：strict、未知字段拒绝、缺省拒绝；证据声明复用整卷三态语义；
 * - 共用授权投影：判别二态——授权态确实携带答案解析字段、无秘密态确实
 *   不含（负断言）；提交回执与反馈读取引用同一 schema（防漂移成两套）；
 * - 回执形状：字段全集锁定，纯状态不夹带得分/对错/摘要（白名单纪律）；
 * - 与 M1 组合：practiceWorkflow 嵌入回执可解析 M1 resolver 现有输出。
 */

const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const COURSE_ID = "77777777-7777-4777-8777-777777777777";
const REVISION_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const NOTE_VERSION_ID = "2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d2d";
const MUTATION_ID = "1c1c1c1c-2222-4222-8222-1c1c1c1c1c1c";
const SUBMITTED_AT = "2026-10-22T08:00:00.000Z";

/** 合法逐题提交请求（frozen 证据形态；其余三态见证据专项用例） */
const VALID_REQUEST = {
  workflowVersion: 1,
  workflowRevision: 0,
  questionRevisionId: REVISION_ID,
  expectedAnswerRevision: 3,
  submissionMutationId: MUTATION_ID,
  evidence: {
    questionId: "q-1",
    state: "frozen",
    versionId: NOTE_VERSION_ID,
    revision: 2,
  },
} as const;

/** 已授权反馈（released）合法样例：attemptResultQuestion 完整形态 */
const RELEASED_FEEDBACK = {
  status: "released",
  question: {
    questionId: "q-1",
    snapshot: {
      id: "q-1",
      type: "choice",
      difficulty: 2,
      knowledge: ["有理数"],
      stemMd: "$1 + (-1)$ 的结果是？（作答时原文，含 [[答案]] 标记）",
      options: ["$1$", "$0$", "$-1$"],
      hintCount: 1,
    },
    answers: { kind: "choice", index: 1 },
    solutionMd: "解析正文",
    answer: { kind: "choice", index: 1 },
    autoCorrect: true,
    teacherMark: null,
    teacherComment: null,
    finalCorrect: true,
    answered: true,
    studentFlag: null,
    hintsOpened: [{ index: 0, text: "提示一" }],
  },
} as const;

/** M1 resolver 的合法工作流输出（per_question 未受限；M1a 测试同款基底） */
const M1_WORKFLOW_PER_QUESTION = {
  version: 1,
  feedbackMode: "per_question",
  revision: 0,
  canChangeFeedback: true,
  allowedFeedbackModes: ["per_question", "after_attempt"],
  canSubmitQuestion: true,
  restrictionReason: null,
  releaseAt: null,
} as const;

/** M1 resolver 收紧输出（教师要求交卷后公布；已提交后节奏冻结） */
const M1_WORKFLOW_TIGHTENED = {
  ...M1_WORKFLOW_PER_QUESTION,
  feedbackMode: "per_question",
  canChangeFeedback: false,
  allowedFeedbackModes: ["after_attempt"],
  canSubmitQuestion: false,
  restrictionReason: "teacher_after_attempt",
} as const;

/** 进行中课程卷的 attempt 摘要（M1 草稿视图同口径基底） */
const ATTEMPT_SUMMARY_DRAFT = {
  id: ATTEMPT_ID,
  sourceType: "course",
  assignmentId: null,
  lectureId: null,
  courseId: COURSE_ID,
  unitId: "练习四",
  attemptNo: 1,
  status: "draft",
  startedAt: "2026-10-22T07:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
} as const;

/** 提交回执合法样例（released + 全卷题级进度 + 工作流投影） */
const VALID_SUBMIT_DATA = {
  feedback: RELEASED_FEEDBACK,
  questionProgress: [
    {
      questionId: "q-1",
      submittedAt: SUBMITTED_AT,
      feedbackReadable: true,
    },
    { questionId: "q-2", submittedAt: null, feedbackReadable: false },
  ],
  attempt: ATTEMPT_SUMMARY_DRAFT,
  practiceWorkflow: M1_WORKFLOW_PER_QUESTION,
} as const;

describe("practiceQuestionSubmitRequestSchema（M2 新协议逐题提交请求）", () => {
  it("接受合法请求（frozen 证据），字段全集恰为六键", () => {
    const parsed = practiceQuestionSubmitRequestSchema.parse(VALID_REQUEST);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "workflowVersion",
        "workflowRevision",
        "questionRevisionId",
        "expectedAnswerRevision",
        "submissionMutationId",
        "evidence",
      ].sort(),
    );
    expect(parsed.workflowVersion).toBe(1);
  });

  it("证据三态：none / missing 合法且不得携带版本引用（复用整卷声明语义）", () => {
    for (const state of ["none", "missing"] as const) {
      expect(
        practiceQuestionSubmitRequestSchema.parse({
          ...VALID_REQUEST,
          evidence: { questionId: "q-1", state },
        }).evidence.state,
      ).toBe(state);
      expect(
        practiceQuestionSubmitRequestSchema.safeParse({
          ...VALID_REQUEST,
          evidence: {
            questionId: "q-1",
            state,
            versionId: NOTE_VERSION_ID,
            revision: 2,
          },
        }).success,
      ).toBe(false);
    }
    // frozen 缺 versionId / revision < 1 均拒绝（CAS 语义随整卷声明透传）
    expect(
      practiceQuestionSubmitRequestSchema.safeParse({
        ...VALID_REQUEST,
        evidence: { questionId: "q-1", state: "frozen", revision: 2 },
      }).success,
    ).toBe(false);
    expect(
      practiceQuestionSubmitRequestSchema.safeParse({
        ...VALID_REQUEST,
        evidence: {
          questionId: "q-1",
          state: "frozen",
          versionId: NOTE_VERSION_ID,
          revision: 0,
        },
      }).success,
    ).toBe(false);
  });

  it("strict：拒绝未知字段（含旧协议残留与答案字段）", () => {
    for (const extra of [
      { answerRelease: "on_submit" },
      { feedbackMode: "per_question" },
      { answer: { kind: "choice", index: 1 } },
    ]) {
      expect(
        practiceQuestionSubmitRequestSchema.safeParse({
          ...VALID_REQUEST,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it("缺省拒绝：任一字段缺失整体拒绝（新协议无旧客户端兼容分支）", () => {
    for (const key of [
      "workflowVersion",
      "workflowRevision",
      "questionRevisionId",
      "expectedAnswerRevision",
      "submissionMutationId",
      "evidence",
    ] as const) {
      const { [key]: _omit, ...rest } = VALID_REQUEST;
      void _omit;
      expect(practiceQuestionSubmitRequestSchema.safeParse(rest).success).toBe(
        false,
      );
    }
  });

  it("非法值拒绝：workflowVersion 仅 1、两 revision 非负整数、mutationId 须 uuid、版本引用非空", () => {
    expect(
      practiceQuestionSubmitRequestSchema.safeParse({
        ...VALID_REQUEST,
        workflowVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      practiceQuestionSubmitRequestSchema.safeParse({
        ...VALID_REQUEST,
        workflowRevision: -1,
      }).success,
    ).toBe(false);
    expect(
      practiceQuestionSubmitRequestSchema.safeParse({
        ...VALID_REQUEST,
        workflowRevision: 1.5,
      }).success,
    ).toBe(false);
    expect(
      practiceQuestionSubmitRequestSchema.safeParse({
        ...VALID_REQUEST,
        expectedAnswerRevision: -1,
      }).success,
    ).toBe(false);
    expect(
      practiceQuestionSubmitRequestSchema.safeParse({
        ...VALID_REQUEST,
        expectedAnswerRevision: 1.5,
      }).success,
    ).toBe(false);
    expect(
      practiceQuestionSubmitRequestSchema.safeParse({
        ...VALID_REQUEST,
        submissionMutationId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      practiceQuestionSubmitRequestSchema.safeParse({
        ...VALID_REQUEST,
        questionRevisionId: "  ",
      }).success,
    ).toBe(false);
  });
});

describe("practiceQuestionFeedbackSchema（提交回执与反馈读取共用授权投影）", () => {
  it("released 态确实携带判定/参考答案/详解（正断言）且与整卷结果单题同构", () => {
    const parsed = practiceQuestionFeedbackSchema.parse(RELEASED_FEEDBACK);
    expect(parsed.status).toBe("released");
    if (parsed.status !== "released") throw new Error("不可达（收窄）");
    expect(parsed.question.answers).toEqual({ kind: "choice", index: 1 });
    expect(parsed.question.solutionMd).toBe("解析正文");
    expect(parsed.question.autoCorrect).toBe(true);
    expect(parsed.question.finalCorrect).toBe(true);
    // 与整卷结果单题同一形状定义（不另造第二份结果条目契约）
    expect(attemptResultQuestionSchema.parse(parsed.question)).toEqual(
      parsed.question,
    );
  });

  it("三个无秘密态合法：字段全集恰为判别键（restricted 另含 M1 受限原因）", () => {
    expect(
      Object.keys(
        practiceQuestionFeedbackSchema.parse({ status: "not_submitted" }),
      ),
    ).toEqual(["status"]);
    expect(
      Object.keys(
        practiceQuestionFeedbackSchema.parse({ status: "pending_attempt" }),
      ),
    ).toEqual(["status"]);
    const restricted = practiceQuestionFeedbackSchema.parse({
      status: "restricted",
      restrictionReason: "teacher_after_attempt",
    });
    expect(Object.keys(restricted).sort()).toEqual([
      "restrictionReason",
      "status",
    ]);
    // M1 三种受限原因全部可表达，不造第二套枚举
    for (const reason of [
      "teacher_after_attempt",
      "teacher_after_due",
      "legacy_attempt",
    ] as const) {
      expect(
        practiceQuestionFeedbackSchema.parse({
          status: "restricted",
          restrictionReason: reason,
        }).status,
      ).toBe("restricted");
    }
  });

  it("负断言：无秘密态夹带答案/详解/判定/题目条目一律拒绝（判别二态而非可选堆叠）", () => {
    for (const secret of [
      { answers: { kind: "choice", index: 1 } },
      { solutionMd: "解析正文" },
      { autoCorrect: true },
      { finalCorrect: false },
      { score: 90 },
      { question: RELEASED_FEEDBACK.question },
    ]) {
      expect(
        practiceQuestionFeedbackSchema.safeParse({
          status: "not_submitted",
          ...secret,
        }).success,
      ).toBe(false);
      expect(
        practiceQuestionFeedbackSchema.safeParse({
          status: "pending_attempt",
          ...secret,
        }).success,
      ).toBe(false);
      expect(
        practiceQuestionFeedbackSchema.safeParse({
          status: "restricted",
          restrictionReason: "teacher_after_attempt",
          ...secret,
        }).success,
      ).toBe(false);
    }
  });

  it("restricted 的 restrictionReason 拒绝 M1 枚举之外与 null", () => {
    expect(
      practiceQuestionFeedbackSchema.safeParse({
        status: "restricted",
        restrictionReason: "not_submitted_yet",
      }).success,
    ).toBe(false);
    expect(
      practiceQuestionFeedbackSchema.safeParse({
        status: "restricted",
        restrictionReason: null,
      }).success,
    ).toBe(false);
    // 未知判别值拒绝
    expect(
      practiceQuestionFeedbackSchema.safeParse({ status: "granted" }).success,
    ).toBe(false);
  });

  it("released 态缺 question 或 question 非法整体拒绝（不静默降级成无秘密态）", () => {
    const { question: _omit, ...withoutQuestion } = RELEASED_FEEDBACK;
    void _omit;
    expect(
      practiceQuestionFeedbackSchema.safeParse(withoutQuestion).success,
    ).toBe(false);
    expect(
      practiceQuestionFeedbackSchema.safeParse({
        status: "released",
        question: { ...RELEASED_FEEDBACK.question, answers: "B" },
      }).success,
    ).toBe(false);
  });
});

describe("practiceQuestionSubmitDataSchema（逐题提交回执）", () => {
  it("接受合法回执，字段全集恰为四键", () => {
    const parsed = practiceQuestionSubmitDataSchema.parse(VALID_SUBMIT_DATA);
    expect(Object.keys(parsed).sort()).toEqual(
      ["feedback", "questionProgress", "attempt", "practiceWorkflow"].sort(),
    );
  });

  it("strict：拒绝未知字段——纯状态不夹带得分/汇总/对错（白名单纪律）", () => {
    for (const extra of [
      { summary: { total: 2 } },
      { score: 90 },
      { autoCorrect: true },
      { answersReleased: true },
    ]) {
      expect(
        practiceQuestionSubmitDataSchema.safeParse({
          ...VALID_SUBMIT_DATA,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it("题级进度沿用 M1 白名单：未提交行可读反馈拒绝（M1 约束透传）", () => {
    expect(
      practiceQuestionSubmitDataSchema.safeParse({
        ...VALID_SUBMIT_DATA,
        questionProgress: [
          { questionId: "q-2", submittedAt: null, feedbackReadable: true },
        ],
      }).success,
    ).toBe(false);
    expect(
      practiceQuestionProgressSchema.parse(
        VALID_SUBMIT_DATA.questionProgress[0],
      ).feedbackReadable,
    ).toBe(true);
  });

  it("与 M1 组合：回执可嵌入 resolver 收紧后的工作流输出（已提交后节奏冻结）", () => {
    const parsed = practiceQuestionSubmitDataSchema.parse({
      ...VALID_SUBMIT_DATA,
      // 收紧后重取：feedback 无秘密态 + 当前进度全部不可读 + 收紧投影
      feedback: {
        status: "restricted",
        restrictionReason: "teacher_after_attempt",
      },
      questionProgress: [
        {
          questionId: "q-1",
          submittedAt: SUBMITTED_AT,
          feedbackReadable: false,
        },
      ],
      practiceWorkflow: M1_WORKFLOW_TIGHTENED,
    });
    expect(parsed.practiceWorkflow.restrictionReason).toBe(
      "teacher_after_attempt",
    );
    // M1 schema 自身也能解析该嵌入投影（双向组合，非仅子集宽松匹配）
    expect(
      m1WorkflowSchema.parse(M1_WORKFLOW_TIGHTENED).canSubmitQuestion,
    ).toBe(false);
  });

  it("attempt 摘要随行校验：非法摘要（course 来源缺 unitId）拒绝", () => {
    const { unitId: _omit, ...badAttempt } = ATTEMPT_SUMMARY_DRAFT;
    void _omit;
    expect(
      practiceQuestionSubmitDataSchema.safeParse({
        ...VALID_SUBMIT_DATA,
        attempt: badAttempt,
      }).success,
    ).toBe(false);
  });
});

describe("回执与反馈读取共用同一投影（防漂移）", () => {
  it("两个 data schema 的 feedback 字段引用同一 schema 对象", () => {
    const submitShape = (
      practiceQuestionSubmitDataSchema as unknown as {
        shape: { feedback: unknown };
      }
    ).shape;
    const feedbackShape = (
      practiceQuestionFeedbackDataSchema as unknown as {
        shape: { feedback: unknown };
      }
    ).shape;
    expect(submitShape.feedback).toBe(practiceQuestionFeedbackSchema);
    expect(feedbackShape.feedback).toBe(practiceQuestionFeedbackSchema);
  });

  it("同一 released 样例在两条通道解析结果一致", () => {
    expect(
      practiceQuestionFeedbackDataSchema.parse({
        feedback: RELEASED_FEEDBACK,
      }),
    ).toEqual({
      feedback:
        practiceQuestionSubmitDataSchema.parse(VALID_SUBMIT_DATA).feedback,
    });
    // 反馈读取 data 形态恰为单键 feedback，strict 拒绝未知字段
    expect(
      Object.keys(
        practiceQuestionFeedbackDataSchema.parse({
          feedback: RELEASED_FEEDBACK,
        }),
      ),
    ).toEqual(["feedback"]);
    expect(
      practiceQuestionFeedbackDataSchema.safeParse({
        ...RELEASED_FEEDBACK,
        questionProgress: [],
      }).success,
    ).toBe(false);
  });

  it("成功响应壳：ok 字面量 + data 具体化", () => {
    expect(
      practiceQuestionSubmitOkSchema.parse({
        ok: true,
        data: VALID_SUBMIT_DATA,
      }).data.attempt.id,
    ).toBe(ATTEMPT_ID);
    expect(
      practiceQuestionSubmitOkSchema.safeParse({ ok: false, data: null })
        .success,
    ).toBe(false);
  });
});
