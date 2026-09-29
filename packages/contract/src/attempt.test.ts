import { describe, expect, it } from "vitest";
import {
  attemptAnswerSaveDataSchema,
  attemptAnswerSaveRequestSchema,
  attemptDetailDataSchema,
  attemptDraftDataSchema,
  attemptErrorCodeSchema,
  attemptResultDataSchema,
  attemptStartDataSchema,
  attemptStatusSchema,
  attemptSummarySchema,
  hintOpenDataSchema,
  hintOpenRequestSchema,
} from "./attempt.ts";

/**
 * 作答生命周期契约自测（T2.6；T2A.6 扩展作答来源）：锁定四个接口的请求/响应形态——
 * - attempt 摘要三态与 scoreAuto 口径（0–100 整数或 null）；
 * - 作答来源（D9）：sourceType assignment|course、courseId 可空、attemptNo ≥1；
 *   来源交叉不变式（schema superRefine 锁定）：course 恒 courseId+unitId 且不挂
 *   作业；assignment 恒 assignmentId 且 unitId=null（courseId 随作业可空）；
 * - 草稿视图：题目是 QuestionPublic 形态（无 answers/solutionMd/hints）、
 *   本人答案收在 drafts 键（键名与结果视图的参考答案 answers 区分）、
 *   courseName 供顶部来源行（assignment 为 null）；
 * - 结果视图：快照 + 参考答案 + 详解 + 本人答案 + autoCorrect，但无提示内容键；
 * - 草稿保存请求体：answer 必须是 StudentAnswer 判别联合成员；
 * - 分步提示（T2.11）：请求体 {questionId, index}、响应只含被请求的那一条
 *   提示 + 计数；两个视图的 hintsOpened 只回显已解锁条目；
 * - 错误码集合（ALREADY_SUBMITTED / HINT_INDEX_OUT_OF_RANGE 为验收项；
 *   COURSE_ACCESS_DENIED / NOT_FOUND 为 T2A.6 课程来源访问权码，D22）；
 * - 详情 union 的状态-形态一致性（superRefine 锁定）：attempt.status=draft ⇔
 *   草稿视图形态（drafts/hintsOpened），submitted/graded ⇔ 结果视图形态
 *   （summary/answersReleased），错配整体拒绝。
 */

const ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const COURSE_ID = "77777777-7777-4777-8777-777777777777";
const UNIT_ID = "练习四";
const STARTED_AT = "2026-09-27T02:00:00.000Z";
const SUBMITTED_AT = "2026-09-27T02:30:00.000Z";

const SUMMARY_DRAFT = {
  id: ATTEMPT_ID,
  sourceType: "assignment",
  assignmentId: ASSIGNMENT_ID,
  courseId: null,
  // T2A.7：assignment 来源多单元化后 unitId 为 null（题目集合走 assignment_units）
  unitId: null,
  attemptNo: 1,
  status: "draft",
  startedAt: STARTED_AT,
  submittedAt: null,
  scoreAuto: null,
} as const;

const SUMMARY_SUBMITTED = {
  ...SUMMARY_DRAFT,
  status: "submitted",
  submittedAt: SUBMITTED_AT,
  scoreAuto: 88,
} as const;

/** 课程练习来源的摘要（D9/D10：courseId 非空、assignmentId 空、unitId 恒有值、attemptNo 递增） */
const SUMMARY_COURSE_SECOND = {
  ...SUMMARY_DRAFT,
  sourceType: "course",
  assignmentId: null,
  courseId: COURSE_ID,
  // 来源不变式（schema 层 superRefine 锁定）：course 来源 unitId 不能继承
  // assignment fixture 的 null——须显式给值（课程练习必须记录目标单元）
  unitId: UNIT_ID,
  attemptNo: 2,
} as const;

describe("attemptStatusSchema / attemptSummarySchema", () => {
  it("接受三态 draft|submitted|graded，拒绝其他值", () => {
    expect(attemptStatusSchema.parse("draft")).toBe("draft");
    expect(attemptStatusSchema.parse("submitted")).toBe("submitted");
    expect(attemptStatusSchema.parse("graded")).toBe("graded");
    expect(attemptStatusSchema.safeParse("in_progress").success).toBe(false);
  });

  it("摘要：scoreAuto 是 0–100 整数或 null；submittedAt 可空", () => {
    expect(attemptSummarySchema.parse(SUMMARY_DRAFT).scoreAuto).toBeNull();
    const submitted = attemptSummarySchema.parse(SUMMARY_SUBMITTED);
    expect(submitted.scoreAuto).toBe(88);
    expect(submitted.submittedAt).toBe(SUBMITTED_AT);
    expect(
      attemptSummarySchema.safeParse({ ...SUMMARY_DRAFT, scoreAuto: 101 })
        .success,
    ).toBe(false);
    expect(
      attemptSummarySchema.safeParse({ ...SUMMARY_DRAFT, scoreAuto: 88.5 })
        .success,
    ).toBe(false);
  });

  it("作答来源（T2A.6，D9）：assignment 记 assignmentId；course 记 courseId+attemptNo", () => {
    const course = attemptSummarySchema.parse(SUMMARY_COURSE_SECOND);
    expect(course.sourceType).toBe("course");
    expect(course.assignmentId).toBeNull();
    expect(course.courseId).toBe(COURSE_ID);
    expect(course.attemptNo).toBe(2);
    // 缺来源字段 / 非法来源值 → 拒绝
    const { sourceType: _omitSource, ...withoutSource } = SUMMARY_DRAFT;
    expect(attemptSummarySchema.safeParse(withoutSource).success).toBe(false);
    expect(
      attemptSummarySchema.safeParse({
        ...SUMMARY_DRAFT,
        sourceType: "exam",
      }).success,
    ).toBe(false);
    expect(
      attemptSummarySchema.safeParse({ ...SUMMARY_DRAFT, attemptNo: 0 })
        .success,
    ).toBe(false);
  });

  it("来源交叉不变式（superRefine 锁定）：course 恒记单元、assignment 恒不落单单元", () => {
    // course 来源 unitId=null → 拒绝（课程练习必须记录目标单元）
    expect(
      attemptSummarySchema.safeParse({
        ...SUMMARY_COURSE_SECOND,
        unitId: null,
      }).success,
    ).toBe(false);
    // course 来源挂作业 assignmentId → 拒绝（课程练习不挂在作业上）
    expect(
      attemptSummarySchema.safeParse({
        ...SUMMARY_COURSE_SECOND,
        assignmentId: ASSIGNMENT_ID,
      }).success,
    ).toBe(false);
    // course 来源缺课程 courseId=null → 拒绝
    expect(
      attemptSummarySchema.safeParse({
        ...SUMMARY_COURSE_SECOND,
        courseId: null,
      }).success,
    ).toBe(false);
    // assignment 来源 unitId 非空 → 拒绝（T2A.7 多单元化后题目集合走 assignment_units）
    expect(
      attemptSummarySchema.safeParse({
        ...SUMMARY_DRAFT,
        unitId: "unit-一元一次方程",
      }).success,
    ).toBe(false);
    // assignment 来源缺作业 assignmentId=null → 拒绝
    expect(
      attemptSummarySchema.safeParse({
        ...SUMMARY_DRAFT,
        assignmentId: null,
      }).success,
    ).toBe(false);
    // assignment 来源挂课程（courseId 非空）合法——作业可挂课程（D9/T2A.7）
    expect(
      attemptSummarySchema.safeParse({
        ...SUMMARY_DRAFT,
        courseId: COURSE_ID,
      }).success,
    ).toBe(true);
  });

  it("POST /attempt 响应 = 摘要本体（attemptStartDataSchema；两种来源共用）", () => {
    expect(attemptStartDataSchema.parse(SUMMARY_DRAFT)).toEqual(SUMMARY_DRAFT);
    expect(attemptStartDataSchema.parse(SUMMARY_COURSE_SECOND)).toEqual(
      SUMMARY_COURSE_SECOND,
    );
  });
});

describe("attemptDraftDataSchema（草稿视图）", () => {
  it("接受合法草稿视图：单元分组 QuestionPublic 形态题目 + drafts 答案表 + hintsOpened 已解锁提示", () => {
    const parsed = attemptDraftDataSchema.parse({
      attempt: SUMMARY_DRAFT,
      title: "周末加练",
      courseName: null,
      dueAt: null,
      // T2A.7：题目按单元分组下发（题号全卷连续由 units 顺序保证）
      units: [
        {
          id: UNIT_ID,
          title: "练习四",
          questions: [
            {
              id: "练习四-1",
              type: "judge",
              difficulty: 1,
              knowledge: ["有理数的概念"],
              stemMd: "$0$ 既不是正数，也不是负数。[[]]",
              hintCount: 0,
            },
            {
              id: "练习四-4",
              type: "fill",
              difficulty: 2,
              knowledge: ["有理数加法"],
              stemMd: "计算：$(-3)+7=$ [[]]",
              hintCount: 1,
            },
          ],
        },
      ],
      drafts: {
        "练习四-1": { kind: "judge", value: true },
        "练习四-4": { kind: "fill", values: ["4", ""] },
      },
      // T2.11：刷新后回显已解锁提示（只含学生请求过的条目）
      hintsOpened: {
        "练习四-4": [
          { index: 0, text: "同号相加，取相同的符号，并把绝对值相加。" },
        ],
      },
    });
    expect(parsed.drafts["练习四-1"]).toEqual({ kind: "judge", value: true });
    expect(parsed.hintsOpened["练习四-4"]?.[0]?.index).toBe(0);
  });

  it("草稿视图里的题目携带教师侧字段会被剥离（strip 语义，与 QuestionPublic 一致）", () => {
    const parsed = attemptDraftDataSchema.parse({
      attempt: SUMMARY_DRAFT,
      title: "周末加练",
      courseName: null,
      dueAt: null,
      units: [
        {
          id: UNIT_ID,
          title: "练习四",
          questions: [
            {
              id: "练习四-1",
              type: "judge",
              difficulty: 1,
              knowledge: [],
              stemMd: "[[]]",
              hintCount: 0,
              // 教师侧字段混入草稿视图题目 → 契约层剥离（fail closed：只少给不多给）
              answers: { kind: "judge", value: true },
              solutionMd: "详解不应出现在草稿视图",
            },
          ],
        },
      ],
      drafts: {},
      hintsOpened: {},
    });
    const question = parsed.units[0]?.questions[0];
    expect(question && "answers" in question).toBe(false);
    expect(question && "solutionMd" in question).toBe(false);
  });
});

describe("attemptResultDataSchema（结果视图）", () => {
  const RESULT = {
    attempt: SUMMARY_SUBMITTED,
    title: "周末加练",
    courseName: null,
    dueAt: null,
    // T2A.8：答案公布时机标记（on_submit / 已到截止的 after_due = 完整形态）
    answersReleased: true,
    summary: {
      total: 2,
      answered: 2,
      correct: 1,
      wrong: 1,
      pending: 0,
      unanswered: 0,
      autoGradable: 2,
    },
    // T2A.7：逐题结果按单元分组（单元序 + 题序；course 单组）
    units: [
      {
        id: UNIT_ID,
        title: "练习四",
        questions: [
          {
            questionId: "练习四-1",
            snapshot: {
              id: "练习四-1",
              type: "judge",
              difficulty: 1,
              knowledge: ["有理数的概念"],
              stemMd: "$0$ 既不是正数，也不是负数。[[正确]]",
              hintCount: 0,
            },
            answers: { kind: "judge", value: true },
            solutionMd: "$0$ 是整数，但既不是正数也不是负数。",
            answer: { kind: "judge", value: true },
            autoCorrect: true,
            hintsOpened: [],
          },
          {
            questionId: "练习四-4",
            snapshot: {
              id: "练习四-4",
              type: "fill",
              difficulty: 2,
              knowledge: ["有理数加法"],
              stemMd: "计算：$(-3)+7=$ [[4]]",
              hintCount: 1,
            },
            answers: { kind: "fill", blanks: [["4"], ["-7"], ["0.5", "1/2"]] },
            solutionMd: null,
            answer: { kind: "fill", values: ["4", "-6", ""] },
            autoCorrect: false,
            // 做题时看过第 0 条提示 → 结果视图回显该条（其余不下发）
            hintsOpened: [{ index: 0, text: "同号相加，取相同的符号。" }],
          },
        ],
      },
    ],
  } as const;

  it("接受合法结果视图：快照 + 参考答案 + 详解 + 本人答案 + autoCorrect", () => {
    const parsed = attemptResultDataSchema.parse(RESULT);
    const resultQuestions = parsed.units[0]?.questions ?? [];
    expect(resultQuestions[0]?.autoCorrect).toBe(true);
    expect(resultQuestions[1]?.answers).toEqual({
      kind: "fill",
      blanks: [["4"], ["-7"], ["0.5", "1/2"]],
    });
  });

  it("快照携带提示内容字段会被剥离（strip 语义；hintCount 是唯一提示形态）", () => {
    const parsed = attemptResultDataSchema.parse({
      ...RESULT,
      units: [
        {
          ...RESULT.units[0],
          questions: [
            {
              ...RESULT.units[0].questions[0],
              snapshot: {
                ...RESULT.units[0].questions[0].snapshot,
                hints: ["提示内容不应出现在结果视图"],
              },
            },
          ],
        },
      ],
    });
    const snapshot = parsed.units[0]?.questions[0]?.snapshot;
    expect(snapshot && "hints" in snapshot).toBe(false);
    expect(snapshot?.hintCount).toBe(0);
  });

  it("autoCorrect / answer 允许 null（未作答或待批）；answers 允许 null（无标准答案）", () => {
    expect(
      attemptResultDataSchema.safeParse({
        ...RESULT,
        units: [
          {
            id: "unit-练习七",
            title: "练习七",
            questions: [
              {
                questionId: "p4-q7",
                snapshot: {
                  id: "p4-q7",
                  type: "solve",
                  difficulty: 3,
                  knowledge: [],
                  stemMd: "计算 …",
                  hintCount: 0,
                },
                answers: null,
                solutionMd: null,
                answer: null,
                autoCorrect: null,
                hintsOpened: [],
              },
            ],
          },
        ],
        summary: {
          total: 1,
          answered: 0,
          correct: 0,
          wrong: 0,
          pending: 1,
          unanswered: 1,
          autoGradable: 0,
        },
      }).success,
    ).toBe(true);
  });

  it("结果视图缺 hintsOpened 字段整体拒绝（必填；回显已解锁提示是 T2.11 契约形态）", () => {
    const { hintsOpened: _omit, ...questionWithoutHints } = {
      ...RESULT.units[0].questions[0],
      questionId: "练习四-9",
    };
    expect(
      attemptResultDataSchema.safeParse({
        ...RESULT,
        units: [
          {
            ...RESULT.units[0],
            questions: [questionWithoutHints],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("T2A.8 answersReleased 缺失整体拒绝（必填；两种形态都须显式声明）", () => {
    const { answersReleased: _omit, ...withoutRelease } = RESULT;
    expect(attemptResultDataSchema.safeParse(withoutRelease).success).toBe(
      false,
    );
  });

  it("T2A.8 受限形态（answersReleased=false）合法：answers/solutionMd/autoCorrect 全 null + 零化对错计数 + scoreAuto 置 null 投影", () => {
    const restricted = attemptResultDataSchema.parse({
      ...RESULT,
      attempt: { ...RESULT.attempt, scoreAuto: null },
      dueAt: "2026-10-01T12:00:00.000Z",
      answersReleased: false,
      summary: {
        total: 2,
        answered: 2,
        correct: 0,
        wrong: 0,
        // 未公布口径：每道已答题都显示为「待批」
        pending: 2,
        unanswered: 0,
        autoGradable: 0,
      },
      units: [
        {
          ...RESULT.units[0],
          questions: RESULT.units[0].questions.map((question) => ({
            ...question,
            // stemMd 为 publicStemMd 公开化版（[[答案]] 标记已替换为 [[]]）
            snapshot: {
              ...question.snapshot,
              stemMd: question.snapshot.stemMd.replace(
                /\[\[[^[\]]*\]\]/g,
                "[[]]",
              ),
            },
            answers: null,
            solutionMd: null,
            autoCorrect: null,
          })),
        },
      ],
    });
    expect(restricted.answersReleased).toBe(false);
    expect(restricted.attempt.scoreAuto).toBeNull();
    const first = restricted.units[0]?.questions[0];
    expect(first?.answers).toBeNull();
    expect(first?.solutionMd).toBeNull();
    expect(first?.autoCorrect).toBeNull();
    // 本人答案不受影响（受限形态仍下发）
    expect(first?.answer).toEqual({ kind: "judge", value: true });
  });
});

describe("hintOpenRequestSchema / hintOpenDataSchema（T2.11 分步提示）", () => {
  it("请求体：questionId 非空 + index 整数（负数/超界留给服务端统一错误码）", () => {
    expect(
      hintOpenRequestSchema.parse({ questionId: "练习四-8", index: 0 }),
    ).toEqual({ questionId: "练习四-8", index: 0 });
    // 负数与超大值在契约层合法（服务端按 HINT_INDEX_OUT_OF_RANGE 拒绝）
    expect(
      hintOpenRequestSchema.safeParse({ questionId: "练习四-8", index: -1 })
        .success,
    ).toBe(true);
    expect(
      hintOpenRequestSchema.safeParse({ questionId: "练习四-8", index: 99 })
        .success,
    ).toBe(true);
    // 非整数 / 缺 questionId → 契约层 400 VALIDATION_ERROR
    expect(
      hintOpenRequestSchema.safeParse({ questionId: "练习四-8", index: 1.5 })
        .success,
    ).toBe(false);
    expect(
      hintOpenRequestSchema.safeParse({ questionId: "", index: 0 }).success,
    ).toBe(false);
  });

  it("响应 data：只含被请求的那一条提示 + 总数/已解锁/剩余计数", () => {
    const parsed = hintOpenDataSchema.parse({
      questionId: "练习四-8",
      index: 0,
      hint: "先回顾异号两数相加的法则。",
      hintCount: 2,
      hintsUsed: 1,
      hintsRemaining: 1,
    });
    expect(parsed.hint).toContain("异号");
    // 计数字段为负 → 拒绝
    expect(
      hintOpenDataSchema.safeParse({
        questionId: "练习四-8",
        index: 0,
        hint: "…",
        hintCount: 2,
        hintsUsed: -1,
        hintsRemaining: 3,
      }).success,
    ).toBe(false);
    expect(
      hintOpenDataSchema.safeParse({
        questionId: "练习四-8",
        index: -1,
        hint: "…",
        hintCount: 2,
        hintsUsed: 0,
        hintsRemaining: 2,
      }).success,
    ).toBe(false);
  });
});

describe("attemptAnswerSaveRequestSchema / attemptAnswerSaveDataSchema", () => {
  it("请求体 answer 必须是 StudentAnswer 判别联合成员", () => {
    expect(
      attemptAnswerSaveRequestSchema.parse({
        answer: { kind: "choice", index: 1 },
      }),
    ).toEqual({ answer: { kind: "choice", index: 1 } });
    expect(
      attemptAnswerSaveRequestSchema.safeParse({
        answer: { kind: "choice", index: -1 },
      }).success,
    ).toBe(false);
    expect(
      attemptAnswerSaveRequestSchema.safeParse({ answer: "B" }).success,
    ).toBe(false);
  });

  it("保存回执：questionId + changeCount（≥1）", () => {
    expect(
      attemptAnswerSaveDataSchema.parse({
        questionId: "练习四-1",
        changeCount: 2,
      }),
    ).toEqual({ questionId: "练习四-1", changeCount: 2 });
    expect(
      attemptAnswerSaveDataSchema.safeParse({
        questionId: "练习四-1",
        changeCount: 0,
      }).success,
    ).toBe(false);
  });
});

describe("attemptDetailDataSchema / attemptErrorCodeSchema", () => {
  it("详情 data 是草稿视图与结果视图的 union（按 attempt.status 分支）", () => {
    expect(
      attemptDetailDataSchema.safeParse({
        attempt: SUMMARY_DRAFT,
        title: "周末加练",
        courseName: null,
        dueAt: null,
        units: [],
        drafts: {},
        hintsOpened: {},
      }).success,
    ).toBe(true);
    expect(
      attemptDetailDataSchema.safeParse({
        attempt: SUMMARY_SUBMITTED,
        title: "周末加练",
        courseName: null,
        dueAt: null,
        answersReleased: true,
        summary: {
          total: 0,
          answered: 0,
          correct: 0,
          wrong: 0,
          pending: 0,
          unanswered: 0,
          autoGradable: 0,
        },
        units: [],
      }).success,
    ).toBe(true);
  });

  it("状态-形态一致性（superRefine 锁定）：status 与视图形态错配整体拒绝，不静默进错误分支", () => {
    // 已交卷状态 + 草稿视图形态（drafts/hintsOpened、无 summary）→ 拒绝
    expect(
      attemptDetailDataSchema.safeParse({
        attempt: SUMMARY_SUBMITTED,
        title: "周末加练",
        courseName: null,
        dueAt: null,
        units: [],
        drafts: {},
        hintsOpened: {},
      }).success,
    ).toBe(false);
    // draft 状态 + 结果视图形态（summary/answersReleased、无 drafts）→ 拒绝
    expect(
      attemptDetailDataSchema.safeParse({
        attempt: SUMMARY_DRAFT,
        title: "周末加练",
        courseName: null,
        dueAt: null,
        answersReleased: true,
        summary: {
          total: 0,
          answered: 0,
          correct: 0,
          wrong: 0,
          pending: 0,
          unanswered: 0,
          autoGradable: 0,
        },
        units: [],
      }).success,
    ).toBe(false);
  });

  it("错误码集合含 ALREADY_SUBMITTED（T2.6 验收项）、HINT_INDEX_OUT_OF_RANGE（T2.11 验收项）与越权/不存在码", () => {
    expect(attemptErrorCodeSchema.parse("ALREADY_SUBMITTED")).toBe(
      "ALREADY_SUBMITTED",
    );
    expect(attemptErrorCodeSchema.parse("ATTEMPT_NOT_FOUND")).toBe(
      "ATTEMPT_NOT_FOUND",
    );
    expect(attemptErrorCodeSchema.parse("QUESTION_NOT_FOUND")).toBe(
      "QUESTION_NOT_FOUND",
    );
    expect(attemptErrorCodeSchema.parse("HINT_INDEX_OUT_OF_RANGE")).toBe(
      "HINT_INDEX_OUT_OF_RANGE",
    );
    expect(attemptErrorCodeSchema.parse("COURSE_ACCESS_DENIED")).toBe(
      "COURSE_ACCESS_DENIED",
    );
    expect(attemptErrorCodeSchema.parse("NOT_FOUND")).toBe("NOT_FOUND");
    expect(attemptErrorCodeSchema.safeParse("SUBMIT_TWICE").success).toBe(
      false,
    );
  });
});
