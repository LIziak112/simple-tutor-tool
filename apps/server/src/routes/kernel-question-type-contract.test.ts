import { randomUUID } from "node:crypto";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  attemptDraftOkSchema,
  attemptStartOkSchema,
  BACKUP_KERNEL_DATABASE,
  type GradingPolicy,
  type MarkRequest,
  markResponseDataSchema,
  type QuestionType,
  type StudentAnswer,
  teacherAttemptDetailOkSchema,
} from "@tutor/contract";
import { expect, it, vi } from "vitest";
import {
  importQuestions,
  jsonCall,
  openInstance,
  wire,
} from "../test/kernel-delivery-world.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";

/**
 * 产品侧题型契约：每种产品题型一行，经产品原入口导入、开卷、作答、交卷，
 * 由内核待评任务调用真实登记的 ownclass-* 评估器（再经 gradeResponseRow 判分）。
 * 每行三项：按冻结策略判对 / 判错 / 待批；空答；教师改判后清除回落到原判定。
 * 参照内核 tests/fixtures/contracts/response-type-contract.ts 的行式写法。
 */

type Sample = Readonly<{ answer: StudentAnswer; correct: boolean | null }>;
type Row = Readonly<{
  type: QuestionType;
  /** 一道题的 DSL；所有题都带参考答案，主观题的策略由自评开关冻结。 */
  question: (id: string) => readonly string[];
  /** 整卷共用的前置块（材料等）。 */
  prelude?: (ids: readonly string[]) => readonly string[];
  /**
   * 判断题单独成卷走原值确认，该通道目前没有教师改判入口（见下方现状用例）；
   * 契约行配一道不作答的多选，使整卷经逐题交付通道、由同一组宿主评估器判分。
   */
  deliveryCompanion?: true;
  /** auto 行给判对与判错样例；主观行给一个已作答样例（待批）。 */
  samples: readonly Sample[];
  /** 自动判分题型未作答判错；主观题未作答待批。 */
  emptyCorrect: boolean | null;
}>;

const choiceQuestion = (type: "choice" | "multi") => (id: string) => [
  `::::question{id=${id} type=${type}}`,
  "契约选择题。",
  "- [x] 甲",
  "- [ ] 乙",
  type === "multi" ? "- [x] 丙" : "- [ ] 丙",
  "::::",
  "",
];

const finalQuestion =
  (type: "solve" | "apply" | "find-error") => (id: string) => [
    `::::question{id=${id} type=${type}}`,
    "契约解答题。",
    ":::answer",
    "契约参考",
    ":::",
    "::::",
    "",
  ];

const matchingSlots = ["slot-1", "slot-2"];

const rows: readonly Row[] = [
  {
    type: "judge",
    question: (id) => [
      `::::question{id=${id} type=judge}`,
      "契约判断。[[正确]]",
      "::::",
      "",
    ],
    samples: [
      { answer: { kind: "judge", value: true }, correct: true },
      { answer: { kind: "judge", value: false }, correct: false },
    ],
    emptyCorrect: false,
    deliveryCompanion: true,
  },
  {
    type: "choice",
    question: choiceQuestion("choice"),
    samples: [
      { answer: { kind: "choice", index: 0 }, correct: true },
      { answer: { kind: "choice", index: 1 }, correct: false },
    ],
    emptyCorrect: false,
  },
  {
    type: "multi",
    question: choiceQuestion("multi"),
    samples: [
      { answer: { kind: "multi", indexes: [0, 2] }, correct: true },
      { answer: { kind: "multi", indexes: [0] }, correct: false },
    ],
    emptyCorrect: false,
  },
  {
    type: "fill",
    question: (id) => [
      `::::question{id=${id} type=fill}`,
      "契约填空 [[甲]]。",
      "::::",
      "",
    ],
    samples: [{ answer: { kind: "fill", values: ["甲"] }, correct: null }],
    emptyCorrect: null,
  },
  ...(["solve", "apply", "find-error"] as const).map(
    (type): Row => ({
      type,
      question: finalQuestion(type),
      samples: [
        { answer: { kind: "final", finalAnswer: "契约参考" }, correct: null },
      ],
      emptyCorrect: null,
    }),
  ),
  {
    type: "matching",
    prelude: (ids) => [
      "::::material{id=contract-mat title=契约材料}",
      "第一处 {{slot-1}}，第二处 {{slot-2}}。",
      "::::",
      "",
      '::::group{id=contract-grp title="为空白处选择内容。" label=1}',
      "::ref{material=contract-mat}",
      ...ids.map((id) => `::ref{question=${id}}`),
      "::::",
      "",
    ],
    question: (id) => [
      `:::::question{id=${id} type=matching}`,
      "为文中空白处选择内容。",
      "",
      `::ref{material=contract-mat slots=${matchingSlots.join("..")}}`,
      "",
      "::::options",
      ":::option{id=opt-1}",
      "选项一。",
      ":::",
      ":::option{id=opt-2}",
      "选项二。",
      ":::",
      "::::",
      "",
      ":::answer",
      "slot-1 = opt-1",
      "slot-2 = opt-2",
      ":::",
      ":::::",
      "",
    ],
    samples: [
      {
        answer: {
          kind: "matching",
          pairs: { "slot-1": "opt-1", "slot-2": "opt-2" },
        },
        correct: null,
      },
    ],
    emptyCorrect: null,
  },
  {
    type: "ordering",
    question: (id) => [
      `::::question{id=${id} type=ordering}`,
      "把下列语句排成一段。",
      ":::item{id=first}",
      "甲。",
      ":::",
      ":::item{id=second}",
      "乙。",
      ":::",
      ":::answer",
      "first",
      "second",
      ":::",
      "::::",
      "",
    ],
    samples: [
      {
        answer: { kind: "ordering", sequence: ["first", "second"] },
        correct: null,
      },
    ],
    emptyCorrect: null,
  },
  {
    type: "response",
    question: (id) => [
      `::::question{id=${id} type=response}`,
      "请说明看法。",
      ":::answer",
      "契约参考看法。",
      ":::",
      "::::",
      "",
    ],
    samples: [
      { answer: { kind: "response", body: "我的看法。" }, correct: null },
    ],
    emptyCorrect: null,
  },
];

const autoTypes = new Set<QuestionType>(["judge", "choice", "multi"]);

/** 一份整卷：每个样例一题、再加一道不作答的题。按冻结策略开卷交卷后返回教师视图。 */
async function handInPaper(
  row: Row,
  selfReview: boolean,
  companion = row.deliveryCompanion === true,
) {
  const data = mkdtempDisposableSync(
    join(tmpdir(), `type-contract-${row.type}-`),
  );
  const instance = openInstance(data.path);
  const app = instance.open(false);
  const world = await setupAssignment(app);
  const prefix = `contract-${row.type}`;
  const sampleIds = row.samples.map((_, index) => `${prefix}-${index}`);
  const emptyId = `${prefix}-empty`;
  const ids = [...sampleIds, emptyId];
  const {
    units: [unit],
  } = await importQuestions(app, world.teacher, undefined, [
    ...(row.prelude?.(ids) ?? []),
    ...ids.flatMap((id) => row.question(id)),
    ...(companion ? choiceQuestion("multi")(`${prefix}-companion`) : []),
  ]);
  if (!unit) throw new Error(`未导入 ${row.type} 契约题`);
  const feedback = await jsonCall(
    app,
    "/api/teacher/settings/practice-feedback",
    world.teacher,
    "PUT",
    { studentSelfReviewEnabled: selfReview },
  );
  expect(feedback.status, await feedback.clone().text()).toBe(200);
  const assignment = await assignKernelFixture(
    app,
    { ...world, unitId: unit.id },
    { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00Z" },
  );
  const opened = await postAssignment(app, assignment, world.ownerCookie);
  expect(opened.status, await opened.clone().text()).toBe(200);
  const attempt = attemptStartOkSchema.parse(await opened.json()).data;
  const path = `/api/student/attempts/${attempt.id}`;
  const draft = async () =>
    attemptDraftOkSchema.parse(
      await (await jsonCall(app, path, world.ownerCookie)).json(),
    ).data;
  const revisions = new Map(
    (await draft()).units
      .flatMap(({ questions }) => questions)
      .map((question) => [question.id, question.questionRevisionId]),
  );
  for (const [index, { answer }] of row.samples.entries()) {
    const id = sampleIds[index];
    const saved = await jsonCall(
      app,
      `${path}/answers/${id}`,
      world.ownerCookie,
      "PUT",
      {
        answer,
        baseRevision: 0,
        mutationId: randomUUID(),
        expectedFrozenAt: attempt.frozenAt,
        questionRevisionId: revisions.get(id ?? ""),
      },
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
  }
  const saved = await draft();
  const submitted = await jsonCall(
    app,
    `${path}/submit`,
    world.ownerCookie,
    "POST",
    {
      revisions: [...revisions].map(([questionId, questionRevisionId]) => ({
        questionId,
        questionRevisionId,
        expectedAnswerRevision: saved.draftRevisions?.[questionId] ?? 0,
      })),
    },
  );
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  const teacherView = async () => {
    const response = await jsonCall(
      app,
      `/api/teacher/attempts/${attempt.id}`,
      world.teacher,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const detail = teacherAttemptDetailOkSchema.parse(
      await response.json(),
    ).data;
    return new Map(
      detail.questions.map((question) => [question.questionId, question]),
    );
  };
  const markRaw = (responseId: string, request: MarkRequest) =>
    jsonCall(
      app,
      `/api/teacher/responses/${responseId}/mark`,
      world.teacher,
      "POST",
      request,
    );
  const mark = async (responseId: string, request: MarkRequest) => {
    const response = await markRaw(responseId, request);
    expect(response.status, await response.clone().text()).toBe(200);
    return wire(markResponseDataSchema).parse(await response.json()).data;
  };
  // 有参考的题都带评分键：内核评估任务须由真实登记的宿主评估器执行完毕。
  const kernel = new DatabaseSync(join(data.path, BACKUP_KERNEL_DATABASE), {
    readOnly: true,
  });
  const tasks = kernel
    .prepare(
      "SELECT status, attempts, last_error AS lastError FROM evaluation_tasks t JOIN submissions s ON s.id=t.submission_id JOIN step_attempts a ON a.id=s.step_attempt_id WHERE a.activity_id=?",
    )
    .all(attempt.id);
  kernel.close();
  return {
    sampleIds,
    emptyId,
    tasks,
    teacherView,
    mark,
    markRaw,
    close: () => {
      instance.close();
      data.remove();
    },
  };
}

const policiesOf = (row: Row): readonly GradingPolicy[] =>
  autoTypes.has(row.type) ? ["auto"] : ["reference_self", "manual_only"];

const cases = rows.flatMap((row) =>
  policiesOf(row).map((policy) => ({ row, policy, type: row.type })),
);

it("题型契约覆盖全部产品题型", () => {
  expect(rows.map(({ type }) => type).toSorted()).toEqual(
    [
      "judge",
      "choice",
      "multi",
      "fill",
      "solve",
      "apply",
      "find-error",
      "matching",
      "ordering",
      "response",
    ].toSorted(),
  );
});

it.each(cases)(
  "题型契约 $type｜$policy｜判分、空答、改判后清除回落原判定",
  async ({ row, policy }) => {
    vi.stubEnv("NEW_CONTENT_ENABLED", "true");
    const paper = await handInPaper(row, policy !== "manual_only");
    try {
      expect(paper.tasks).toEqual([
        { status: "done", attempts: 0, lastError: null },
      ]);
      const view = await paper.teacherView();
      // 判分：按冻结策略判对、判错或待批（主观题恒不自动判定）。
      for (const [index, { correct }] of row.samples.entries()) {
        const question = view.get(paper.sampleIds[index] ?? "");
        expect(question, row.type).toMatchObject({
          gradingPolicy: policy,
          autoCorrect: correct,
          finalCorrect: correct,
          teacherMark: null,
        });
      }
      // 空答：自动判分题型未作答判错，主观题未作答待批。
      expect(view.get(paper.emptyId)).toMatchObject({
        gradingPolicy: policy,
        answered: false,
        autoCorrect: row.emptyCorrect,
        finalCorrect: row.emptyCorrect,
      });
      // 改判 / 清除：教师改判生效，清除后回落到原判定（自动判定或待批）。
      const target = view.get(paper.sampleIds[0] ?? "");
      if (!target?.responseId) throw new Error("缺少可批改的作答行");
      const original = target.finalCorrect;
      const amended = original !== true;
      const marked = await paper.mark(target.responseId, {
        mark: amended ? "correct" : "wrong",
        comment: null,
        baseRevision: 0,
        mutationId: randomUUID(),
      });
      expect(marked).toMatchObject({ revision: 1, finalCorrect: amended });
      const cleared = await paper.mark(target.responseId, {
        mark: null,
        comment: null,
        baseRevision: 1,
        mutationId: randomUUID(),
      });
      expect(cleared).toMatchObject({
        revision: 2,
        teacherMark: null,
        finalCorrect: original,
      });
      expect((await paper.teacherView()).get(target.questionId)).toMatchObject({
        autoCorrect: target.autoCorrect,
        finalCorrect: original,
        teacherMark: null,
      });
    } finally {
      paper.close();
      vi.unstubAllEnvs();
    }
  },
);

it("现状：判断题单独成卷走原值确认，判分与空答同契约，教师改判入口未开放", async () => {
  const judge = rows.find(({ type }) => type === "judge");
  if (!judge) throw new Error("缺少判断题契约行");
  const paper = await handInPaper(judge, true, false);
  try {
    expect(paper.tasks).toEqual([
      { status: "done", attempts: 0, lastError: null },
    ]);
    const view = await paper.teacherView();
    expect(
      [...paper.sampleIds, paper.emptyId].map(
        (id) => view.get(id)?.finalCorrect,
      ),
    ).toEqual([true, false, false]);
    const target = view.get(paper.sampleIds[0] ?? "");
    if (!target?.responseId) throw new Error("缺少作答行");
    const response = await paper.markRaw(target.responseId, {
      mark: "wrong",
      comment: null,
      baseRevision: 0,
      mutationId: randomUUID(),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "KERNEL_ATTEMPT_WRITE_UNAVAILABLE",
    });
  } finally {
    paper.close();
  }
});
