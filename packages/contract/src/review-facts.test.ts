import { expect, it } from "vitest";
import type { ReviewQuestionFact } from "./review-facts.ts";
import { defaultReviewDimension, groupReviewFacts } from "./review-groups.ts";
import { reviewVerdictOf } from "./review-verdict.ts";

const fact = (patch: Partial<ReviewQuestionFact> = {}): ReviewQuestionFact => ({
  retrainable: true,
  questionId: "q1",
  questionRevisionId: null,
  unit: { id: "u1", title: "单元" },
  settlementSeq: null,
  type: "choice",
  knowledge: [],
  materialIds: [],
  answered: true,
  verdict: false,
  judgmentSource: "auto",
  gradingPolicy: "auto",
  rubricReview: null,
  activeSec: null,
  changeCount: null,
  hintsUsed: null,
  studentFlag: null,
  hasHandwriting: null,
  hasScratch: null,
  memoSequences: null,
  ...patch,
});
it("教师、自评、自动优先级，未做和自评标签保持一致", () => {
  expect(
    reviewVerdictOf({
      answered: false,
      teacherMark: "correct",
      autoCorrect: false,
      finalCorrect: false,
      gradingPolicy: "auto",
      selfReviewVerdict: null,
    }),
  ).toMatchObject({ verdict: true, source: "teacher" });
  expect(
    reviewVerdictOf({
      answered: true,
      teacherMark: null,
      autoCorrect: null,
      finalCorrect: null,
      gradingPolicy: "reference_self",
      selfReviewVerdict: "wrong",
    }),
  ).toMatchObject({ verdict: false, source: "self", wrongLabel: "自评错误" });
  expect(
    reviewVerdictOf({
      answered: false,
      teacherMark: null,
      autoCorrect: false,
      finalCorrect: false,
      gradingPolicy: "auto",
      selfReviewVerdict: null,
    }),
  ).toMatchObject({ verdict: false, notDone: true });
});
it("默认隐藏单单元无批次，多单元优先，其余批次", () => {
  expect(defaultReviewDimension([fact()])).toBeNull();
  expect(defaultReviewDimension([fact({ settlementSeq: 1 })])).toBeNull();
  expect(defaultReviewDimension([fact({ settlementSeq: 2 })])).toBe(
    "settlement",
  );
  expect(
    defaultReviewDimension([
      fact(),
      fact({ unit: { id: "u2", title: "另单元" }, settlementSeq: 1 }),
    ]),
  ).toBe("unit");
});
it("批次未归批独立；多材料多考点重叠，不复制组内同题；未知用时不变零", () => {
  const facts = [
    fact({ materialIds: ["m1", "m1", "m2"], knowledge: ["k1", "k2"] }),
    fact({ questionId: "q2", settlementSeq: 2, activeSec: 0 }),
  ];
  expect(groupReviewFacts(facts, "settlement").map((g) => g.title)).toEqual([
    "未归批",
    "第 2 批",
  ]);
  const groups = groupReviewFacts(facts, "material");
  expect(groups.map((g) => g.total)).toEqual([1, 1, 1]);
  expect(groups[0]?.activeSec).toBeNull();
  expect(groups[2]?.activeSec).toBe(0);
});
it("客观正确率不混量表，量表按有效自评/裁定逐项平均", () => {
  const rubricReview = {
    rubric: { levels: 4 as const, items: [{ id: "r1", title: "结构" }] },
    self: {
      source: "self" as const,
      ratings: [{ id: "r1", level: 2 }],
      note: "",
      at: "now",
    },
    agent: null,
    final: null,
    pendingAgentTaskId: null,
  };
  const [g] = groupReviewFacts(
    [
      fact({ verdict: true }),
      fact({
        questionId: "q2",
        type: "response",
        gradingPolicy: "reference_self",
        verdict: null,
        rubricReview,
      }),
    ],
    "unit",
  );
  expect(g).toMatchObject({
    objectiveCount: 1,
    objectiveCorrect: 1,
    correctRate: 1,
    pending: 1,
    rubricAverages: [{ title: "结构", average: 2, count: 1 }],
  });
});
it("封存用时存在缺证或混入口径时，分组不把已知部分冒充总用时", () => {
  const known = fact({
    activeSec: 5,
    time: {
      metric: "question_activity_sealed",
      version: 1,
      value: {
        state: "available",
        activeSec: 5,
        observedSec: 0,
        actions: 1,
        viewed: true,
      },
    },
  });
  const unknown = fact({
    questionId: "q2",
    activeSec: null,
    time: {
      metric: "question_activity_sealed",
      version: 1,
      value: {
        state: "unknown",
        reason: "ledger_missing",
        activeSec: null,
        observedSec: null,
      },
    },
  });
  expect(groupReviewFacts([known, unknown], "unit")[0]?.activeSec).toBeNull();
  expect(
    groupReviewFacts(
      [
        known,
        fact({
          questionId: "q2",
          activeSec: 3,
          time: { metric: "legacy_focus", version: null, activeSec: 3 },
        }),
      ],
      "unit",
    )[0]?.activeSec,
  ).toBeNull();
  expect(
    groupReviewFacts(
      [
        known,
        {
          ...known,
          questionId: "q2",
          activeSec: 0,
          time: {
            metric: "question_activity_sealed",
            version: 1,
            value: {
              state: "available",
              activeSec: 0,
              observedSec: 0,
              actions: 1,
              viewed: true,
            },
          },
        },
      ],
      "unit",
    )[0]?.activeSec,
  ).toBe(5);
});
it("历史焦点组缺证时不以部分和冒充总量，完整组保留历史标记", () => {
  const known = fact({
    activeSec: 37,
    time: { metric: "legacy_focus", version: null, activeSec: 37 },
  });
  const missing = fact({
    questionId: "q2",
    activeSec: null,
    time: { metric: "legacy_focus", version: null, activeSec: null },
  });
  expect(groupReviewFacts([known, missing], "unit")[0]?.activeSec).toBeNull();
  expect(
    groupReviewFacts(
      [
        known,
        {
          ...known,
          questionId: "q2",
          activeSec: 0,
          time: { metric: "legacy_focus", version: null, activeSec: 0 },
        },
      ],
      "unit",
    )[0],
  ).toMatchObject({ activeSec: 37, timeMetric: "legacy_focus" });
});
