import { describe, expect, it } from "vitest";
import {
  attemptAnswerSaveDataSchema,
  attemptAnswerSaveRequestSchema,
  attemptContextGroupSchema,
  attemptContextMaterialSchema,
  attemptDetailDataSchema,
  attemptDraftDataSchema,
  attemptErrorCodeSchema,
  attemptResultDataSchema,
  attemptSourceSchema,
  attemptStartDataSchema,
  attemptStatusSchema,
  attemptSubmitRequestSchema,
  attemptSummarySchema,
  hintOpenDataSchema,
  hintOpenRequestSchema,
  lessonBlockSchema,
  lessonLandingDataSchema,
  lessonQuestionSubmitDataSchema,
  lessonQuestionSubmitRequestSchema,
  lessonStartDataSchema,
  wrongPracticeRequestSchema,
} from "./attempt.ts";

/**
 * 作答生命周期契约自测（T2.6；T2A.6 扩展作答来源）：锁定四个接口的请求/响应形态——
 * - attempt 摘要三态与 scoreAuto 口径（0–100 整数或 null）；
 * - 作答来源（D9）：sourceType assignment|course|wrong、courseId 可空、attemptNo ≥1；
 *   来源交叉不变式（schema superRefine 锁定）：course 恒 courseId+unitId 且不挂
 *   作业；assignment 恒 assignmentId 且 unitId=null（courseId 随作业可空）；
 *   wrong（2026-10 错题重练）恒三归属键全 null；组卷请求 wrongPracticeRequestSchema
 *   至少一题、重复 id 由服务端去重；
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
  // 2026-10 讲练一体：lesson 来源必填，其余来源恒 null
  lectureId: null,
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

  it("作答来源（T2A.6，D9）：assignment 记 assignmentId；course 记 courseId+attemptNo；wrong 三键全空（2026-10）；lesson 记 lectureId（2026-10）", () => {
    const course = attemptSummarySchema.parse(SUMMARY_COURSE_SECOND);
    expect(course.sourceType).toBe("course");
    expect(course.assignmentId).toBeNull();
    expect(course.courseId).toBe(COURSE_ID);
    expect(course.attemptNo).toBe(2);
    // 来源枚举四种（assignment | course | wrong | lesson）
    expect(attemptSourceSchema.options).toEqual([
      "assignment",
      "course",
      "wrong",
      "lesson",
    ]);
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

  it("wrong 来源（2026-10 错题重练）：三归属键恒 null 才合法，任一非空整体拒绝", () => {
    const wrong = {
      ...SUMMARY_DRAFT,
      sourceType: "wrong",
      assignmentId: null,
      courseId: null,
      unitId: null,
      attemptNo: 1,
    } as const;
    expect(attemptSummarySchema.parse(wrong).sourceType).toBe("wrong");
    expect(attemptStartDataSchema.parse(wrong)).toEqual(wrong);
    // 任一归属键非空 → 拒绝（错题重练不挂作业/课程/单元）
    expect(
      attemptSummarySchema.safeParse({
        ...wrong,
        assignmentId: ASSIGNMENT_ID,
      }).success,
    ).toBe(false);
    expect(
      attemptSummarySchema.safeParse({ ...wrong, courseId: COURSE_ID }).success,
    ).toBe(false);
    expect(
      attemptSummarySchema.safeParse({ ...wrong, unitId: UNIT_ID }).success,
    ).toBe(false);
  });

  it("lesson 来源（2026-10 讲练一体）：lectureId 必填、assignmentId 恒 null、unitId 恒非空（嵌入单元快照值）；courseId 可空可非空", () => {
    const LECTURE_ID = "88888888-8888-4888-8888-888888888888";
    const lessonBase = {
      ...SUMMARY_DRAFT,
      sourceType: "lesson",
      assignmentId: null,
      lectureId: LECTURE_ID,
      courseId: null,
      unitId: "有理数讲练",
      attemptNo: 1,
    } as const;
    // courseId 可空（不带课程上下文打开）与可非空（记录来自哪门课）均合法
    expect(attemptSummarySchema.parse(lessonBase).lectureId).toBe(LECTURE_ID);
    expect(
      attemptSummarySchema.parse({ ...lessonBase, courseId: COURSE_ID })
        .courseId,
    ).toBe(COURSE_ID);
    // lectureId 缺失/为 null → 拒绝（讲练作答必须记录所属讲练页）
    const { lectureId: _omitLecture, ...withoutLecture } = lessonBase;
    void _omitLecture;
    expect(attemptSummarySchema.safeParse(withoutLecture).success).toBe(false);
    expect(
      attemptSummarySchema.safeParse({ ...lessonBase, lectureId: null })
        .success,
    ).toBe(false);
    // 空串 lectureId → 拒绝（min(1)）
    expect(
      attemptSummarySchema.safeParse({ ...lessonBase, lectureId: "" }).success,
    ).toBe(false);
    // assignmentId 非空 → 拒绝（讲练作答不挂作业）
    expect(
      attemptSummarySchema.safeParse({
        ...lessonBase,
        assignmentId: ASSIGNMENT_ID,
      }).success,
    ).toBe(false);
    // unitId 为 null → 拒绝（嵌入单元快照值非空）
    expect(
      attemptSummarySchema.safeParse({ ...lessonBase, unitId: null }).success,
    ).toBe(false);
  });

  it("非 lesson 来源携带 lectureId → 拒绝（讲练开卷专属归属键，交叉不变式锁定）", () => {
    expect(
      attemptSummarySchema.safeParse({
        ...SUMMARY_COURSE_SECOND,
        lectureId: "88888888-8888-4888-8888-888888888888",
      }).success,
    ).toBe(false);
    expect(
      attemptSummarySchema.safeParse({
        ...SUMMARY_DRAFT,
        lectureId: "88888888-8888-4888-8888-888888888888",
      }).success,
    ).toBe(false);
    const wrong = {
      ...SUMMARY_DRAFT,
      sourceType: "wrong",
      assignmentId: null,
      courseId: null,
      unitId: null,
    } as const;
    expect(
      attemptSummarySchema.safeParse({
        ...wrong,
        lectureId: "88888888-8888-4888-8888-888888888888",
      }).success,
    ).toBe(false);
  });

  it("错题重练组卷请求（wrongPracticeRequestSchema）：至少一题；空数组/空串元素拒绝", () => {
    expect(
      wrongPracticeRequestSchema.parse({ questionIds: ["练习四-1"] }),
    ).toEqual({ questionIds: ["练习四-1"] });
    // 重复 id 不在契约层拦截（服务端去重保序）
    expect(
      wrongPracticeRequestSchema.safeParse({
        questionIds: ["练习四-1", "练习四-1"],
      }).success,
    ).toBe(true);
    expect(
      wrongPracticeRequestSchema.safeParse({ questionIds: [] }).success,
    ).toBe(false);
    expect(
      wrongPracticeRequestSchema.safeParse({ questionIds: [""] }).success,
    ).toBe(false);
    expect(wrongPracticeRequestSchema.safeParse({}).success).toBe(false);
  });

  it("错题组卷请求携带建卷工作流选项（M1b）：旧请求合法；feedbackMode 必须伴随 workflowVersion=1", () => {
    expect(
      wrongPracticeRequestSchema.parse({
        questionIds: ["练习四-1"],
        workflowVersion: 1,
        feedbackMode: "per_question",
      }),
    ).toMatchObject({ workflowVersion: 1, feedbackMode: "per_question" });
    expect(
      wrongPracticeRequestSchema.safeParse({
        questionIds: ["练习四-1"],
        feedbackMode: "per_question",
      }).success,
    ).toBe(false);
    // 旧 schema 非 strict：未知字段沿用既有宽松语义（strip），不为本任务改变
    expect(
      wrongPracticeRequestSchema.parse({
        questionIds: ["练习四-1"],
        workflowVersion: 1,
        layout: "single",
      }),
    ).toEqual({ questionIds: ["练习四-1"], workflowVersion: 1 });
  });
});

describe("attemptDraftDataSchema（草稿视图）", () => {
  it("接受合法草稿视图：单元分组题目带 questionRevisionId + drafts 答案表 + hintsOpened 已解锁提示 + legacyUnverified + answerRelease", () => {
    const parsed = attemptDraftDataSchema.parse({
      attempt: SUMMARY_DRAFT,
      title: "周末加练",
      courseName: null,
      dueAt: null,
      // 2026-10-21 交卷前置预期：草稿视图携带公布时机（assignment 原值；
      // course/wrong/lesson 恒 on_submit），交卷弹窗据此告知「截止后统一公布」
      answerRelease: "on_submit",
      // T2A.7：题目按单元分组下发（题号全卷连续由 units 顺序保证）；
      // T6R.3：每题携带不透明 questionRevisionId（= responses 行 id）
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
              questionRevisionId: "11111111-1111-4111-8111-111111111111",
            },
            {
              id: "练习四-4",
              type: "fill",
              difficulty: 2,
              knowledge: ["有理数加法"],
              stemMd: "计算：$(-3)+7=$ [[]]",
              hintCount: 1,
              questionRevisionId: "22222222-2222-4222-8222-222222222222",
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
      // T6R.3：建卷即冻结（false）；懒冻结的升级遗留卷为 true
      legacyUnverified: false,
      // T7.7：教师辅助能力有效启用集（服务端恒下发）
      enabledCapabilities: ["steps", "ink"],
    });
    expect(parsed.drafts["练习四-1"]).toEqual({ kind: "judge", value: true });
    expect(parsed.answerRelease).toBe("on_submit");
    expect(parsed.hintsOpened["练习四-4"]?.[0]?.index).toBe(0);
    expect(parsed.units[0]?.questions[0]?.questionRevisionId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("草稿视图缺 questionRevisionId、legacyUnverified 或 answerRelease → 整体拒绝（必填，防漏发）", () => {
    const base = {
      attempt: SUMMARY_DRAFT,
      title: "周末加练",
      courseName: null,
      dueAt: null,
      answerRelease: "on_submit",
      drafts: {},
      hintsOpened: {},
      legacyUnverified: false,
      enabledCapabilities: ["steps", "ink"],
    };
    const question = {
      id: "练习四-1",
      type: "judge",
      difficulty: 1,
      knowledge: [],
      stemMd: "[[]]",
      hintCount: 0,
      questionRevisionId: "11111111-1111-4111-8111-111111111111",
    };
    expect(
      attemptDraftDataSchema.safeParse({
        ...base,
        units: [
          {
            id: UNIT_ID,
            title: "练习四",
            questions: [{ ...question, questionRevisionId: undefined }],
          },
        ],
      }).success,
    ).toBe(false);
    const { legacyUnverified: _omit, ...withoutFlag } = base;
    void _omit;
    expect(
      attemptDraftDataSchema.safeParse({
        ...withoutFlag,
        units: [{ id: UNIT_ID, title: "练习四", questions: [question] }],
      }).success,
    ).toBe(false);
    const { answerRelease: _omitRelease, ...withoutRelease } = base;
    void _omitRelease;
    expect(
      attemptDraftDataSchema.safeParse({
        ...withoutRelease,
        units: [{ id: UNIT_ID, title: "练习四", questions: [question] }],
      }).success,
    ).toBe(false);
  });

  it("草稿视图 answerRelease 接受 after_due（截止后公布作业的交卷前置预期）；非法值拒绝", () => {
    const base = {
      attempt: SUMMARY_DRAFT,
      title: "周末加练",
      courseName: null,
      dueAt: "2026-10-25T12:00:00.000Z",
      drafts: {},
      hintsOpened: {},
      legacyUnverified: false,
      enabledCapabilities: ["steps", "ink"],
      units: [] as const,
    };
    expect(
      attemptDraftDataSchema.parse({ ...base, answerRelease: "after_due" })
        .answerRelease,
    ).toBe("after_due");
    expect(
      attemptDraftDataSchema.safeParse({
        ...base,
        answerRelease: "immediately",
      }).success,
    ).toBe(false);
  });

  it("草稿视图里的题目携带教师侧字段会被剥离（strip 语义，与 QuestionPublic 一致）", () => {
    const parsed = attemptDraftDataSchema.parse({
      attempt: SUMMARY_DRAFT,
      title: "周末加练",
      courseName: null,
      dueAt: null,
      answerRelease: "on_submit",
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
              questionRevisionId: "11111111-1111-4111-8111-111111111111",
              // 教师侧字段混入草稿视图题目 → 契约层剥离（fail closed：只少给不多给）
              answers: { kind: "judge", value: true },
              solutionMd: "详解不应出现在草稿视图",
            },
          ],
        },
      ],
      drafts: {},
      hintsOpened: {},
      legacyUnverified: false,
      enabledCapabilities: ["steps", "ink"],
    });
    const question = parsed.units[0]?.questions[0];
    expect(question && "answers" in question).toBe(false);
    expect(question && "solutionMd" in question).toBe(false);
  });

  it("题目组上下文 groupOrdinal（TT-05a 域④ §5.2.3/§5.8.1）：在组内题开卷冻结携带、非 1 起正整数拒绝；组实体与材料投影随 QM-03/QM-08 接线", () => {
    const draftWith = (groupOrdinal: number) =>
      attemptDraftDataSchema.safeParse({
        attempt: SUMMARY_DRAFT,
        title: "周末加练",
        courseName: null,
        dueAt: null,
        answerRelease: "on_submit",
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
                questionRevisionId: "11111111-1111-4111-8111-111111111111",
                groupOrdinal,
              },
            ],
          },
        ],
        drafts: {},
        hintsOpened: {},
        legacyUnverified: false,
        enabledCapabilities: ["steps", "ink"],
      });
    // 在组内的题：开卷冻结写入组内序号（§5.2.3 展示派生：不进主键，仅公开投影）
    const inGroup = draftWith(3);
    expect(inGroup.success).toBe(true);
    if (inGroup.success) {
      expect(inGroup.data.units[0]?.questions[0]?.groupOrdinal).toBe(3);
    }
    // 0/负数/非整数不是合法组内序（1 起）
    expect(draftWith(0).success).toBe(false);
    expect(draftWith(-1).success).toBe(false);
    expect(draftWith(1.5).success).toBe(false);
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
      // D9（T3.5）：最终得分与待批数（全部判定完成 → graded，待批 0）
      scoreFinal: 50,
      pendingCount: 0,
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
            // D9（T3.5）：未批注 → teacherMark/teacherComment null，finalCorrect=autoCorrect
            teacherMark: null,
            teacherComment: null,
            finalCorrect: true,
            answered: true,
            studentFlag: null,
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
            // D9（T3.5）：教师改判错 + 评语的合法形态（finalCorrect 以 teacherMark 为准）
            teacherMark: "wrong",
            teacherComment: "第三空漏了，重算一遍异号相加。",
            finalCorrect: false,
            answered: true,
            studentFlag: null,
            // 做题时看过第 0 条提示 → 结果视图回显该条（其余不下发）
            hintsOpened: [{ index: 0, text: "同号相加，取相同的符号。" }],
          },
        ],
      },
    ],
    // T7.7：结果视图与草稿视图同口径携带有效启用集
    enabledCapabilities: ["steps", "ink"],
  } as const;

  it("接受合法结果视图：快照 + 参考答案 + 详解 + 本人答案 + autoCorrect", () => {
    const parsed = attemptResultDataSchema.parse(RESULT);
    const resultQuestions = parsed.units[0]?.questions ?? [];
    expect(resultQuestions[0]?.autoCorrect).toBe(true);
    // D9：批注字段与最终判定随结果视图透传
    expect(resultQuestions[0]?.finalCorrect).toBe(true);
    expect(resultQuestions[1]?.teacherMark).toBe("wrong");
    expect(resultQuestions[1]?.teacherComment).toBe(
      "第三空漏了，重算一遍异号相加。",
    );
    expect(resultQuestions[1]?.finalCorrect).toBe(false);
    expect(parsed.summary.scoreFinal).toBe(50);
    expect(parsed.summary.pendingCount).toBe(0);
    expect(resultQuestions[1]?.answers).toEqual({
      kind: "fill",
      blanks: [["4"], ["-7"], ["0.5", "1/2"]],
    });
  });

  it("结果快照组上下文 groupOrdinal（TT-05a 域④ §5.2.3/§5.8.1/§5.8.3）：旧快照缺省=独立题不拒绝、在组内题携带、非 1 起正整数拒绝", () => {
    // 旧快照（RESULT 固件无 groupOrdinal）→ 按「不在组内的独立题」处理（§5.8.3）
    const legacy = attemptResultDataSchema.parse(RESULT);
    expect(
      legacy.units[0]?.questions[0]?.snapshot.groupOrdinal,
    ).toBeUndefined();
    const withOrdinal = (groupOrdinal: number) =>
      attemptResultDataSchema.safeParse({
        ...RESULT,
        units: [
          {
            ...RESULT.units[0],
            questions: [
              {
                ...RESULT.units[0].questions[0],
                snapshot: {
                  ...RESULT.units[0].questions[0].snapshot,
                  groupOrdinal,
                },
              },
              RESULT.units[0].questions[1],
            ],
          },
        ],
      });
    const inGroup = withOrdinal(1);
    expect(inGroup.success).toBe(true);
    if (inGroup.success) {
      expect(inGroup.data.units[0]?.questions[0]?.snapshot.groupOrdinal).toBe(
        1,
      );
    }
    expect(withOrdinal(0).success).toBe(false);
    expect(withOrdinal(2.5).success).toBe(false);
  });

  it("QM-11 自评状态两键可选：旧载荷缺省合法、携带（record/revision + gradingPolicy）合法、公布前 null 投影合法、形态错误拒绝", () => {
    const base = RESULT.units[0]?.questions[0];
    if (base === undefined) throw new Error("测试固件缺题");
    const withSelfReview = (selfReview: unknown, gradingPolicy: unknown) =>
      attemptResultDataSchema.safeParse({
        ...RESULT,
        units: [
          {
            ...RESULT.units[0],
            questions: [
              { ...base, selfReview, gradingPolicy },
              RESULT.units[0].questions[1],
            ],
          },
        ],
      });
    // 旧载荷（升级前缓存/旧服务端响应）缺省合法——optional 兼容
    expect(
      attemptResultDataSchema.parse(RESULT).units[0]?.questions[0],
    ).not.toHaveProperty("selfReview");
    // 携带合法：未自评（record=null 但 revision 推进过——undecided 清除后）
    const cleared = withSelfReview(
      { record: null, revision: 2 },
      "reference_self",
    );
    expect(cleared.success).toBe(true);
    if (cleared.success) {
      expect(cleared.data.units[0]?.questions[0]?.selfReview).toEqual({
        record: null,
        revision: 2,
      });
      expect(cleared.data.units[0]?.questions[0]?.gradingPolicy).toBe(
        "reference_self",
      );
    }
    // 已自评：record 三键完整
    const reviewed = withSelfReview(
      {
        record: {
          verdict: "wrong",
          at: "2026-10-24T01:00:00.000Z",
          revision: 1,
        },
        revision: 1,
      },
      "reference_self",
    );
    expect(reviewed.success).toBe(true);
    // 公布前受限形态：整键 null 投影（读侧按「无自评信息」处理）
    const gated = withSelfReview(null, null);
    expect(gated.success).toBe(true);
    if (gated.success) {
      expect(gated.data.units[0]?.questions[0]?.selfReview).toBeNull();
      expect(gated.data.units[0]?.questions[0]?.gradingPolicy).toBeNull();
    }
    // 旧行与 manual_only/auto 策略值合法；非法策略枚举 / record 非法 verdict 拒绝
    expect(withSelfReview({ record: null, revision: 0 }, null).success).toBe(
      true,
    );
    expect(
      withSelfReview({ record: null, revision: 0 }, "manual_only").success,
    ).toBe(true);
    expect(withSelfReview({ record: null, revision: 0 }, "auto").success).toBe(
      true,
    );
    expect(withSelfReview({ record: null, revision: 0 }, "magic").success).toBe(
      false,
    );
    expect(
      withSelfReview(
        { record: { verdict: "undecided", at: "x", revision: 1 }, revision: 1 },
        "reference_self",
      ).success,
    ).toBe(false);
    expect(withSelfReview({ record: null, revision: -1 }, "auto").success).toBe(
      false,
    );
  });

  it("practiceWorkflow 裁决投影可选（M4-D3 §13.8 结果页节奏摘要）：缺省（legacy/lesson 卷）合法、携带合法、形态错误拒绝", () => {
    const workflow = {
      version: 1,
      feedbackMode: "per_question",
      revision: 0,
      canChangeFeedback: false,
      allowedFeedbackModes: ["per_question"],
      canSubmitQuestion: false,
      restrictionReason: null,
      releaseAt: null,
    };
    // legacy/lesson 卷不携带 → 结果页不显示节奏摘要行
    expect(
      attemptResultDataSchema.parse(RESULT).practiceWorkflow,
    ).toBeUndefined();
    const parsed = attemptResultDataSchema.parse({
      ...RESULT,
      practiceWorkflow: workflow,
    });
    expect(parsed.practiceWorkflow?.feedbackMode).toBe("per_question");
    expect(parsed.practiceWorkflow?.version).toBe(1);
    // 形态错误拒绝（非法枚举值不是合法裁决投影）
    expect(
      attemptResultDataSchema.safeParse({
        ...RESULT,
        practiceWorkflow: { ...workflow, feedbackMode: "immediately" },
      }).success,
    ).toBe(false);
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
                // D9：待批题的批注与最终判定全 null
                teacherMark: null,
                teacherComment: null,
                finalCorrect: null,
                answered: false,
                studentFlag: null,
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
          // D9：待批 → scoreFinal null、pendingCount 1
          scoreFinal: null,
          pendingCount: 1,
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
        // D9：未公布口径下最终得分与待批数同样置 null 投影
        scoreFinal: null,
        pendingCount: null,
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
            // D9：教师批注与最终判定同样不下发（库里已批也不提前泄露）
            teacherMark: null,
            teacherComment: null,
            finalCorrect: null,
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
    expect(first?.teacherMark).toBeNull();
    expect(first?.teacherComment).toBeNull();
    expect(first?.finalCorrect).toBeNull();
    expect(restricted.summary.scoreFinal).toBeNull();
    expect(restricted.summary.pendingCount).toBeNull();
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

describe("attemptSubmitRequestSchema（T6R.3 交卷回传题目版本）", () => {
  it("接受合法请求：每题 questionId + questionRevisionId；空 revisions 合法（空卷）", () => {
    expect(
      attemptSubmitRequestSchema.parse({
        revisions: [
          {
            questionId: "练习四-1",
            questionRevisionId: "11111111-1111-4111-8111-111111111111",
          },
          {
            questionId: "练习四-2",
            questionRevisionId: "22222222-2222-4222-8222-222222222222",
          },
        ],
      }),
    ).toEqual({
      revisions: [
        {
          questionId: "练习四-1",
          questionRevisionId: "11111111-1111-4111-8111-111111111111",
        },
        {
          questionId: "练习四-2",
          questionRevisionId: "22222222-2222-4222-8222-222222222222",
        },
      ],
    });
    expect(attemptSubmitRequestSchema.parse({ revisions: [] })).toEqual({
      revisions: [],
    });
  });

  it("拒绝：revisionId 空/纯空白/首尾空白、questionId 空、超 500 条", () => {
    const valid = {
      questionId: "练习四-1",
      questionRevisionId: "11111111-1111-4111-8111-111111111111",
    };
    expect(
      attemptSubmitRequestSchema.safeParse({
        revisions: [{ ...valid, questionRevisionId: "" }],
      }).success,
    ).toBe(false);
    expect(
      attemptSubmitRequestSchema.safeParse({
        revisions: [{ ...valid, questionRevisionId: "  " }],
      }).success,
    ).toBe(false);
    expect(
      attemptSubmitRequestSchema.safeParse({
        revisions: [{ ...valid, questionRevisionId: " abc " }],
      }).success,
    ).toBe(false);
    expect(
      attemptSubmitRequestSchema.safeParse({
        revisions: [{ ...valid, questionId: "" }],
      }).success,
    ).toBe(false);
    expect(
      attemptSubmitRequestSchema.safeParse({
        revisions: Array.from({ length: 501 }, () => ({ ...valid })),
      }).success,
    ).toBe(false);
  });

  it("错误码集合包含 QUESTION_REVISION_STALE（陈旧题目版本提交，409）与 NOTE_EVIDENCE_MISMATCH（交卷证据声明不符，409——T6R.10）", () => {
    expect(
      attemptErrorCodeSchema.safeParse("QUESTION_REVISION_STALE").success,
    ).toBe(true);
    expect(
      attemptErrorCodeSchema.safeParse("NOTE_EVIDENCE_MISMATCH").success,
    ).toBe(true);
  });

  it("错误码集合包含 M2 逐题提交三码（均 409：协议不符/幂等键冲突/当前规则受限）", () => {
    for (const code of [
      "WORKFLOW_PROTOCOL_MISMATCH",
      "WORKFLOW_MUTATION_CONFLICT",
      "WORKFLOW_RESTRICTED",
    ] as const) {
      expect(attemptErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it("错误码集合包含 ATTEMPT_CONTEXT_BROKEN（开卷缺依赖/上下文快照损坏，409 fail closed——tt-07a/QM-06）", () => {
    expect(
      attemptErrorCodeSchema.safeParse("ATTEMPT_CONTEXT_BROKEN").success,
    ).toBe(true);
  });

  it("attemptContext 条目投影 strip 教师侧/答案类键，键集 = 公开白名单 + sourceVersion（tt-07a/QM-06 三投影纪律）", () => {
    const material = attemptContextMaterialSchema.safeParse({
      id: "mat-1",
      title: "给定资料",
      contentMd: "正文",
      anchors: [],
      slots: [],
      mediaPaths: [],
      sourceVersion: 2,
      // 教师侧/答案类多余键：parse 后 strip（白名单防线）
      sourceMd: "::::material{id=mat-1}\n正文\n::::",
      answers: { kind: "choice", index: 1 },
      solutionMd: "详解哨兵",
      hints: ["提示哨兵"],
    });
    expect(material.success).toBe(true);
    expect(Object.keys(material.data ?? {}).sort()).toEqual([
      "anchors",
      "contentMd",
      "id",
      "mediaPaths",
      "slots",
      "sourceVersion",
      "title",
    ]);
    const group = attemptContextGroupSchema.safeParse({
      id: "grp-1",
      title: "资料组",
      label: "1～2",
      introMd: "",
      materialRefs: [],
      questionIds: ["q-1"],
      sourceVersion: 1,
      sourceMd: "::::group\n::::",
    });
    expect(group.success).toBe(true);
    expect(Object.keys(group.data ?? {}).sort()).toEqual([
      "id",
      "introMd",
      "label",
      "materialRefs",
      "questionIds",
      "sourceVersion",
      "title",
    ]);
  });
});

describe("attemptSubmitRequestSchema.evidence（T6R.10 提交事务固定原稿）", () => {
  const UUID = "33333333-3333-4333-8333-333333333333";

  /** 单条声明数组的拒绝断言（收敛 safeParse 包裹样板） */
  const rejectsEvidence = (evidence: unknown) =>
    expect(
      attemptSubmitRequestSchema.safeParse({ revisions: [], evidence }).success,
    ).toBe(false);

  it("缺省 evidence = 旧客户端（合法：服务端据此走兼容分支）", () => {
    expect(attemptSubmitRequestSchema.parse({ revisions: [] })).toEqual({
      revisions: [],
    });
  });

  it("接受三种声明形态：none（仅题目）/ frozen（versionId+revision）/ missing", () => {
    const parsed = attemptSubmitRequestSchema.parse({
      revisions: [],
      evidence: [
        { questionId: "练习四-1", state: "none" },
        {
          questionId: "练习四-2",
          state: "frozen",
          versionId: UUID,
          revision: 3,
        },
        { questionId: "练习四-3", state: "missing" },
      ],
    });
    expect(parsed.evidence).toEqual([
      { questionId: "练习四-1", state: "none" },
      { questionId: "练习四-2", state: "frozen", versionId: UUID, revision: 3 },
      { questionId: "练习四-3", state: "missing" },
    ]);
  });

  it("拒绝：frozen 缺 versionId 或 revision<1；none/missing 携带版本引用", () => {
    rejectsEvidence([{ questionId: "q1", state: "frozen", revision: 1 }]);
    rejectsEvidence([{ questionId: "q1", state: "frozen", versionId: UUID }]);
    rejectsEvidence([
      {
        questionId: "q1",
        state: "frozen",
        versionId: UUID,
        revision: 0,
      },
    ]);
    rejectsEvidence([{ questionId: "q1", state: "none", versionId: UUID }]);
    rejectsEvidence([{ questionId: "q1", state: "missing", revision: 2 }]);
  });

  it("拒绝：legacy_unverified 不可由客户端声明；坏 uuid / 空 questionId / 超 500 条", () => {
    rejectsEvidence([
      { questionId: "q1", state: "legacy_unverified" as never },
    ]);
    rejectsEvidence([
      {
        questionId: "q1",
        state: "frozen",
        versionId: "not-a-uuid",
        revision: 1,
      },
    ]);
    rejectsEvidence([{ questionId: "", state: "none" }]);
    rejectsEvidence(
      Array.from({ length: 501 }, (_, i) => ({
        questionId: `q${i}`,
        state: "none" as const,
      })),
    );
  });
});

describe("lessonStartDataSchema / lessonQuestionSubmit（2026-10 讲练一体）", () => {
  const LECTURE_ID = "88888888-8888-4888-8888-888888888888";
  const LESSON_SUMMARY_DRAFT = {
    ...SUMMARY_DRAFT,
    sourceType: "lesson",
    assignmentId: null,
    lectureId: LECTURE_ID,
    courseId: COURSE_ID,
    unitId: "有理数讲练",
  } as const;

  const LESSON_QUESTION = {
    id: "有理数讲练-1",
    type: "judge",
    difficulty: 1,
    knowledge: ["有理数的概念"],
    stemMd: "$0$ 既不是正数，也不是负数。[[]]",
    hintCount: 0,
    questionRevisionId: "11111111-1111-4111-8111-111111111111",
  } as const;

  const LESSON_START = {
    lecture: {
      id: LECTURE_ID,
      title: "第1讲 有理数讲练",
      topic: "有理数",
      courseId: COURSE_ID,
      courseName: "初一上",
    },
    blocks: [
      { type: "md", md: "# 第1讲 有理数讲练\n\n先讲一段正数与负数。" },
      { type: "question", questionId: "有理数讲练-1" },
      { type: "md", md: "## 小结\n\n本段完。" },
    ],
    attempt: LESSON_SUMMARY_DRAFT,
    questions: [LESSON_QUESTION],
    drafts: { "有理数讲练-1": { kind: "judge", value: true } },
    hintsOpened: {},
    released: {},
    // 进行中卷 summary 为 null（读侧现算；完成后非空）
    summary: null,
    enabledCapabilities: ["steps", "ink"],
  } as const;

  it("lessonBlockSchema：md 段非空、question 段 questionId 非空；其他 type 拒绝", () => {
    expect(lessonBlockSchema.parse({ type: "md", md: "讲一段。" })).toEqual({
      type: "md",
      md: "讲一段。",
    });
    expect(
      lessonBlockSchema.parse({
        type: "question",
        questionId: "有理数讲练-1",
      }),
    ).toEqual({ type: "question", questionId: "有理数讲练-1" });
    expect(lessonBlockSchema.safeParse({ type: "md", md: "" }).success).toBe(
      false,
    );
    expect(
      lessonBlockSchema.safeParse({ type: "question", questionId: "" }).success,
    ).toBe(false);
    expect(lessonBlockSchema.safeParse({ type: "html", md: "…" }).success).toBe(
      false,
    );
  });

  it("接受合法开卷新卷：blocks 切段 + 冻结题平铺（含 questionRevisionId）+ drafts/hintsOpened/released + summary null（进行中）", () => {
    const parsed = lessonStartDataSchema.parse(LESSON_START);
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[1]).toEqual({
      type: "question",
      questionId: "有理数讲练-1",
    });
    expect(parsed.questions[0]?.questionRevisionId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(parsed.summary).toBeNull();
    expect(parsed.lecture.courseId).toBe(COURSE_ID);
  });

  it("attempt.sourceType 非 lesson → 整体拒绝（讲练开卷数据只承载 lesson 来源）", () => {
    expect(
      lessonStartDataSchema.safeParse({
        ...LESSON_START,
        attempt: { ...LESSON_SUMMARY_DRAFT, sourceType: "course" },
      }).success,
    ).toBe(false);
  });

  it("attempt 已完成（非 draft）但 summary 为 null → 拒绝（完成后非空，状态-形态一致性）", () => {
    expect(
      lessonStartDataSchema.safeParse({
        ...LESSON_START,
        attempt: { ...LESSON_SUMMARY_DRAFT, status: "graded" },
      }).success,
    ).toBe(false);
    // 已完成 + summary 非空 → 合法（草稿与完成态共用一形态，由 attempt.status 区分）
    expect(
      lessonStartDataSchema.safeParse({
        ...LESSON_START,
        attempt: { ...LESSON_SUMMARY_DRAFT, status: "graded" },
        summary: {
          total: 1,
          answered: 1,
          correct: 1,
          wrong: 0,
          pending: 0,
          unanswered: 0,
          autoGradable: 1,
          scoreFinal: 100,
          pendingCount: 0,
        },
      }).success,
    ).toBe(true);
  });

  it("单题提交请求：questionRevisionId 必填；evidence 可选（复用整卷声明形态，含 superRefine）", () => {
    expect(
      lessonQuestionSubmitRequestSchema.parse({
        questionRevisionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({ questionRevisionId: "11111111-1111-4111-8111-111111111111" });
    // evidence 复用 submitEvidenceDeclarationSchema：frozen 缺 versionId → 拒绝
    expect(
      lessonQuestionSubmitRequestSchema.safeParse({
        questionRevisionId: "11111111-1111-4111-8111-111111111111",
        evidence: {
          questionId: "有理数讲练-1",
          state: "frozen",
          revision: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      lessonQuestionSubmitRequestSchema.safeParse({
        questionRevisionId: "11111111-1111-4111-8111-111111111111",
        evidence: {
          questionId: "有理数讲练-1",
          state: "frozen",
          versionId: "33333333-3333-4333-8333-333333333333",
          revision: 2,
        },
      }).success,
    ).toBe(true);
    // 空/空白 revisionId → 拒绝（与交卷同口径）
    expect(
      lessonQuestionSubmitRequestSchema.safeParse({ questionRevisionId: "" })
        .success,
    ).toBe(false);
    expect(lessonQuestionSubmitRequestSchema.safeParse({}).success).toBe(false);
  });

  it("单题提交响应：question（当题释放）+ summary + attempt 三键；summary 必填非 null", () => {
    const payload = {
      question: {
        questionId: "有理数讲练-1",
        snapshot: {
          id: "有理数讲练-1",
          type: "judge",
          difficulty: 1,
          knowledge: ["有理数的概念"],
          stemMd: "$0$ 既不是正数，也不是负数。[[正确]]",
          hintCount: 0,
        },
        answers: { kind: "judge", value: true },
        solutionMd: null,
        answer: { kind: "judge", value: true },
        autoCorrect: true,
        teacherMark: null,
        teacherComment: null,
        finalCorrect: true,
        answered: true,
        studentFlag: null,
        hintsOpened: [],
      },
      summary: {
        total: 1,
        answered: 1,
        correct: 1,
        wrong: 0,
        pending: 0,
        unanswered: 0,
        autoGradable: 1,
        scoreFinal: null,
        pendingCount: 0,
      },
      attempt: LESSON_SUMMARY_DRAFT,
    };
    const data = lessonQuestionSubmitDataSchema.parse(payload);
    expect(data.question.autoCorrect).toBe(true);
    expect(data.attempt.sourceType).toBe("lesson");
    // summary 为 null → 拒绝（单题提交响应恒带现算汇总）
    expect(
      lessonQuestionSubmitDataSchema.safeParse({ ...payload, summary: null })
        .success,
    ).toBe(false);
  });
});

describe("lessonLandingDataSchema（2026-10 讲练落地页）", () => {
  const LECTURE_ID = "88888888-8888-4888-8888-888888888888";
  const ATTEMPT_ID = "99999999-9999-4999-8999-999999999999";

  it("接受合法落地：题数/题型分布 + 历次（attemptNo 降序）+ 汇总；从未做 summary=null", () => {
    const parsed = lessonLandingDataSchema.parse({
      lectureId: LECTURE_ID,
      title: "第1讲 有理数讲练",
      topic: "有理数",
      courseId: COURSE_ID,
      courseName: "初一上",
      questionCount: 2,
      typeDistribution: { judge: 1, choice: 1 },
      attempts: [
        {
          attemptId: ATTEMPT_ID,
          attemptNo: 1,
          status: "draft",
          score: null,
          startedAt: "2026-10-13T02:00:00.000Z",
          submittedAt: null,
        },
      ],
      summary: {
        count: 1,
        submittedCount: 0,
        hasDraft: true,
        firstScore: null,
        latestScore: null,
        bestScore: null,
        pendingCount: 0,
      },
    });
    expect(parsed.attempts[0]?.status).toBe("draft");
    expect(parsed.summary?.hasDraft).toBe(true);
  });

  it("零题讲练（questionCount=0 + 空分布 + summary=null）合法", () => {
    const parsed = lessonLandingDataSchema.parse({
      lectureId: LECTURE_ID,
      title: "纯讲义",
      topic: null,
      courseId: null,
      courseName: null,
      questionCount: 0,
      typeDistribution: {},
      attempts: [],
      summary: null,
    });
    expect(parsed.questionCount).toBe(0);
    expect(parsed.summary).toBeNull();
  });

  it("历次行 status 越值（非 draft/submitted/graded）→ 拒绝", () => {
    expect(
      lessonLandingDataSchema.safeParse({
        lectureId: LECTURE_ID,
        title: "第1讲",
        topic: null,
        courseId: null,
        courseName: null,
        questionCount: 0,
        typeDistribution: {},
        attempts: [
          {
            attemptId: ATTEMPT_ID,
            attemptNo: 1,
            status: "abandoned",
            score: null,
            startedAt: "2026-10-13T02:00:00.000Z",
            submittedAt: null,
          },
        ],
        summary: null,
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
        answerRelease: "on_submit",
        units: [],
        drafts: {},
        hintsOpened: {},
        legacyUnverified: false,
        enabledCapabilities: ["steps", "ink"],
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
          // D9：空卷结果视图也须携带两个新汇总字段（无可判分 → null）
          scoreFinal: null,
          pendingCount: 0,
        },
        units: [],
        enabledCapabilities: ["steps", "ink"],
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
        legacyUnverified: false,
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
    expect(attemptErrorCodeSchema.parse("WRONG_PRACTICE_EMPTY")).toBe(
      "WRONG_PRACTICE_EMPTY",
    );
    // 2026-10 讲练一体：该题已单题提交（lesson 逐题提交防重，409）
    expect(attemptErrorCodeSchema.parse("QUESTION_ALREADY_SUBMITTED")).toBe(
      "QUESTION_ALREADY_SUBMITTED",
    );
    expect(attemptErrorCodeSchema.safeParse("SUBMIT_TWICE").success).toBe(
      false,
    );
  });
});

describe("attemptDraftDataSchema（M1a 可选工作流与题级进度）", () => {
  /** 草稿视图最小合法基底（不含新可选字段——旧响应缺省必须仍合法） */
  const base = {
    attempt: SUMMARY_DRAFT,
    title: "周末加练",
    courseName: null,
    dueAt: null,
    answerRelease: "on_submit",
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
            questionRevisionId: "11111111-1111-4111-8111-111111111111",
          },
        ],
      },
    ],
    drafts: {},
    hintsOpened: {},
    legacyUnverified: false,
    enabledCapabilities: ["steps", "ink"],
  };

  it("缺省不带 practiceWorkflow / questionProgress（旧响应兼容，不默认授权）", () => {
    const parsed = attemptDraftDataSchema.parse(base);
    expect(parsed.practiceWorkflow).toBeUndefined();
    expect(parsed.questionProgress).toBeUndefined();
  });

  it("携带合法 practiceWorkflow + questionProgress 时透传", () => {
    const workflow = {
      version: 1,
      feedbackMode: "per_question",
      revision: 0,
      canChangeFeedback: true,
      allowedFeedbackModes: ["per_question", "after_attempt"],
      canSubmitQuestion: true,
      restrictionReason: null,
      releaseAt: null,
    };
    const parsed = attemptDraftDataSchema.parse({
      ...base,
      practiceWorkflow: workflow,
      questionProgress: [
        { questionId: "练习四-1", submittedAt: null, feedbackReadable: false },
      ],
    });
    expect(parsed.practiceWorkflow?.feedbackMode).toBe("per_question");
    expect(parsed.questionProgress?.[0]?.questionId).toBe("练习四-1");
  });

  it("夹带答案字段的题级进度 → 整体拒绝（白名单，防答案混入题面）", () => {
    expect(
      attemptDraftDataSchema.safeParse({
        ...base,
        questionProgress: [
          {
            questionId: "练习四-1",
            submittedAt: null,
            feedbackReadable: false,
            autoCorrect: true,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
