import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  attemptContextGroupSchema,
  attemptContextMaterialSchema,
  attemptQuestionPublicSchema,
} from "./attempt.ts";
import {
  notebookRoundContextSchema,
  notebookRoundReleaseSchema,
  notebookRoundSchema,
  studentNotebookDataSchema,
  studentNotebookOkSchema,
} from "./student-notebook-api.ts";

/**
 * 题目笔记本聚合契约自测（T6R.15；题面/解析扩展）：锁定 GET /api/student/
 * notebook/questions/:questionId 的轮次聚合形状。对照派单失败测试清单：
 * rounds 空/多轮、questionVersion null 合法、evidence null 合法、零答案负向
 * 断言（AGENTS.md 第 3 条：答案/详解只在 release 白名单形态下受控出现，
 * 教师侧字段全树禁入）。
 */

const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

/** 未封存订正行（noteRecordMeta 最小合法形态，phase=correction） */
const OPEN_CORRECTION = {
  noteId: "99999999-9999-4999-8999-999999999999",
  attemptId: ATTEMPT_ID,
  questionId: "p4-q7",
  questionRevisionId: "resp-1",
  phase: "correction",
  revision: 1,
  currentVersionId: VERSION_ID,
  serverSavedAt: "2026-10-06T02:00:00.000Z",
};

/** 已封存订正行（sealedAt + 反思字段齐全） */
const SEALED_CORRECTION = {
  ...OPEN_CORRECTION,
  noteId: "88888888-8888-4888-8888-888888888888",
  sealedAt: "2026-10-07T01:00:00.000Z",
  stuckAt: "第二问的辅助线没想到",
  errorCause: "把内错角看成了同位角",
};

/** 补充稿行（phase=supplement，无封存语义） */
const SUPPLEMENT = {
  ...OPEN_CORRECTION,
  noteId: "77777777-7777-4777-8777-777777777777",
  phase: "supplement",
};

/** frozen 证据行（noteSubmissionEvidenceMeta 最小合法形态） */
const FROZEN_EVIDENCE = {
  attemptId: ATTEMPT_ID,
  questionId: "p4-q7",
  state: "frozen",
  versionId: VERSION_ID,
  recordedAt: "2026-10-06T03:00:00.000Z",
};

/**
 * 轮次题面（attemptQuestionPublic 最小合法形态；与取卷/结果视图同一 schema，
 * stemMd 为 studentStemMd 脱敏后的题干）
 */
const QUESTION_PUBLIC = {
  id: "p4-q7",
  type: "choice",
  difficulty: 3,
  knowledge: ["一元一次方程"],
  stemMd: "下列哪个选项正确？",
  options: ["选项一", "选项二", "选项三"],
  hintCount: 2,
  questionRevisionId: "resp-1",
};

/** 受控解析（notebookRoundRelease 最小合法形态：参考答案 + 详解） */
const RELEASE = {
  answers: { kind: "choice", index: 2 },
  solutionMd: "先移项，再合并同类项。",
};

/** 该轮冻结上下文（notebookRoundContext 最小合法形态：1 材料 + 1 组） */
const ROUND_CONTEXT = {
  materials: [
    {
      id: "mat-1",
      title: "2025 年产量",
      contentMd: "给定资料正文。",
      anchors: [],
      slots: [],
      mediaPaths: [],
      sourceVersion: 2,
    },
  ],
  groups: [
    {
      id: "grp-1",
      introMd: "根据以下资料回答。",
      materialRefs: [{ material: "mat-1" }],
      questionIds: ["p4-q7"],
      sourceVersion: 1,
    },
  ],
};

/** 轮次基座（第一轮：frozen 原稿 + 一条已封存订正） */
const ROUND_BASE = {
  attemptId: ATTEMPT_ID,
  sourceType: "course",
  sourceLabel: "一元一次方程 · 第 2 次",
  submittedAt: "2026-10-06T03:00:00.000Z",
  roundOrdinal: 1,
  questionVersion: 3,
  question: QUESTION_PUBLIC,
  release: RELEASE,
  evidence: FROZEN_EVIDENCE,
  corrections: [SEALED_CORRECTION, OPEN_CORRECTION],
  supplements: [],
  context: ROUND_CONTEXT,
};

describe("studentNotebookData：轮次聚合形状", () => {
  it("questionId 无已交卷轮次 → rounds 空数组（契约不禁止空，200 口径由服务层）", () => {
    const parsed = studentNotebookDataSchema.parse({
      questionId: "p4-q7",
      rounds: [],
    });
    expect(parsed.rounds).toEqual([]);
  });

  it("多轮完整形态通过：第二轮含 supplement 与 evidence=null（missing 交卷）", () => {
    const parsed = studentNotebookDataSchema.parse({
      questionId: "p4-q7",
      rounds: [
        ROUND_BASE,
        {
          attemptId: "55555555-5555-4555-8555-555555555555",
          sourceType: "wrong",
          sourceLabel: "错题重练",
          submittedAt: "2026-10-07T05:00:00.000Z",
          roundOrdinal: 2,
          questionVersion: null,
          question: null,
          release: null,
          evidence: {
            attemptId: "55555555-5555-4555-8555-555555555555",
            questionId: "p4-q7",
            state: "missing",
            versionId: null,
            recordedAt: "2026-10-07T05:00:00.000Z",
          },
          corrections: [],
          supplements: [SUPPLEMENT],
          context: null,
        },
      ],
    });
    expect(parsed.rounds).toHaveLength(2);
    expect(parsed.rounds[1]?.supplements[0]?.phase).toBe("supplement");
    expect(parsed.rounds[1]?.questionVersion).toBeNull();
  });

  it("成功壳：studentNotebookOkSchema 携带 data；ok=false 拒", () => {
    expect(
      studentNotebookOkSchema.safeParse({
        ok: true,
        data: { questionId: "p4-q7", rounds: [] },
      }).success,
    ).toBe(true);
    expect(
      studentNotebookOkSchema.safeParse({
        ok: false,
        data: { questionId: "p4-q7", rounds: [] },
      }).success,
    ).toBe(false);
  });

  it("questionId 空串/缺 rounds 拒；rounds 内坏行（attemptId 非 uuid）拒", () => {
    expect(
      studentNotebookDataSchema.safeParse({ questionId: "", rounds: [] })
        .success,
    ).toBe(false);
    expect(
      studentNotebookDataSchema.safeParse({ questionId: "q" }).success,
    ).toBe(false);
    expect(
      studentNotebookDataSchema.safeParse({
        questionId: "q",
        rounds: [{ ...ROUND_BASE, attemptId: "not-uuid" }],
      }).success,
    ).toBe(false);
  });
});

describe("notebookRound：字段约束", () => {
  it("roundOrdinal 从 1 起（0/负数/非整数拒）；questionVersion 为 null 或 ≥1 整数（0/小数拒）", () => {
    expect(notebookRoundSchema.parse(ROUND_BASE).roundOrdinal).toBe(1);
    expect(
      notebookRoundSchema.safeParse({ ...ROUND_BASE, roundOrdinal: 0 }).success,
    ).toBe(false);
    expect(
      notebookRoundSchema.safeParse({ ...ROUND_BASE, roundOrdinal: 1.5 })
        .success,
    ).toBe(false);
    expect(
      notebookRoundSchema.safeParse({ ...ROUND_BASE, questionVersion: null })
        .success,
    ).toBe(true);
    expect(
      notebookRoundSchema.safeParse({ ...ROUND_BASE, questionVersion: 0 })
        .success,
    ).toBe(false);
    expect(
      notebookRoundSchema.safeParse({ ...ROUND_BASE, questionVersion: 2.5 })
        .success,
    ).toBe(false);
  });

  it("evidence null 合法（无证据行——旧客户端兼容交卷）；sourceType 非法值/sourceLabel 空串拒", () => {
    expect(
      notebookRoundSchema.safeParse({ ...ROUND_BASE, evidence: null }).success,
    ).toBe(true);
    expect(
      notebookRoundSchema.safeParse({
        ...ROUND_BASE,
        sourceType: "practice",
      }).success,
    ).toBe(false);
    expect(
      notebookRoundSchema.safeParse({ ...ROUND_BASE, sourceLabel: "" }).success,
    ).toBe(false);
  });

  it("corrections/supplements 内坏行整体拒（scratch 行带 sealedAt 混入数组）", () => {
    expect(
      notebookRoundSchema.safeParse({
        ...ROUND_BASE,
        corrections: [
          {
            ...OPEN_CORRECTION,
            phase: "scratch",
            sealedAt: "2026-10-07T01:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("缺任一字段拒（roundOrdinal/evidence 等）", () => {
    const { roundOrdinal: _r, ...noOrdinal } = ROUND_BASE;
    expect(notebookRoundSchema.safeParse(noOrdinal).success).toBe(false);
    const { evidence: _e, ...noEvidence } = ROUND_BASE;
    expect(notebookRoundSchema.safeParse(noEvidence).success).toBe(false);
  });
});

describe("notebook 零答案负向断言（AGENTS.md 第 3 条）", () => {
  /** 深收集 schema 全部键名：对象进 shape、数组取 element、可空/可选剥壳 */
  function collectKeys(
    schema: z.core.$ZodType,
    acc: Set<string> = new Set(),
  ): Set<string> {
    if (schema instanceof z.ZodObject) {
      for (const [key, child] of Object.entries(schema.shape)) {
        acc.add(key);
        collectKeys(child, acc);
      }
    } else if (schema instanceof z.ZodArray) {
      collectKeys(schema.element, acc);
    } else if (
      schema instanceof z.ZodNullable ||
      schema instanceof z.ZodOptional
    ) {
      collectKeys(schema.unwrap(), acc);
    }
    return acc;
  }

  it("教师侧字段全树禁入；顶层与 release 形状精确锁定", () => {
    const keys = [...collectKeys(studentNotebookDataSchema)];
    const forbidden = [
      "teacherComment",
      "teacherMark",
      "autoCorrect",
      "finalCorrect",
      "correct",
      "sourceMd",
      "questionSnapshotJson",
      "answersJson",
      "answerJson",
      "answer",
      "stem",
      "answerText",
      "hint",
      "hints",
      "hintsJson",
      "optionsJson",
    ];
    for (const name of forbidden) {
      expect(keys, `契约不得包含字段 ${name}`).not.toContain(name);
    }
    // 顶层字段集合精确锁定：增删字段即接口变化，须显式改契约与本断言
    expect(Object.keys(notebookRoundSchema.shape)).toEqual([
      "attemptId",
      "sourceType",
      "sourceLabel",
      "submittedAt",
      "roundOrdinal",
      "questionVersion",
      "question",
      "release",
      "evidence",
      "corrections",
      "supplements",
      "context",
    ]);
    expect(Object.keys(studentNotebookDataSchema.shape)).toEqual([
      "questionId",
      "rounds",
    ]);
    // release 形状精确锁定：答案/详解只允许在此白名单形态下受控出现
    expect(Object.keys(notebookRoundReleaseSchema.shape)).toEqual([
      "answers",
      "solutionMd",
    ]);
    // 顶层严禁平铺答案/详解/提示/题干——由上方 Object.keys 精确锁全数涵盖
    // （精确表不含任何答案/详解/提示/题干键，嵌套白名单合法化不放宽顶层）
    // question 复用 attemptQuestionPublicSchema 同一实例（白名单投影单一出处）
    expect(notebookRoundSchema.shape.question.unwrap()).toBe(
      attemptQuestionPublicSchema,
    );
  });

  it("question/release 形状：null 合法；教师侧多余键剥除；release 答案 kind 非法拒", () => {
    expect(
      notebookRoundSchema.safeParse({
        ...ROUND_BASE,
        question: null,
        release: null,
      }).success,
    ).toBe(true);
    // question 经 attemptQuestionPublicSchema.parse：教师侧多余键剥除
    // （fail closed——输入显式携带三个教师侧键，断言 parse 后确实不存在）
    const stripped = notebookRoundSchema.parse({
      ...ROUND_BASE,
      question: {
        ...QUESTION_PUBLIC,
        teacherComment: "教师私注",
        answers: { kind: "choice", index: 0 },
        sourceMd: "原始片段",
      },
    }).question;
    expect(stripped).not.toHaveProperty("teacherComment");
    expect(stripped).not.toHaveProperty("answers");
    expect(stripped).not.toHaveProperty("sourceMd");
    // release.answers 走 questionAnswersSchema：kind 非法整体拒（不静默降级）
    expect(
      notebookRoundSchema.safeParse({
        ...ROUND_BASE,
        release: { answers: { kind: "bogus" }, solutionMd: null },
      }).success,
    ).toBe(false);
    // 无标准答案题（主观题）：answers null 合法
    expect(
      notebookRoundSchema.safeParse({
        ...ROUND_BASE,
        release: { answers: null, solutionMd: null },
      }).success,
    ).toBe(true);
  });
});

describe("notebookRoundContext：该轮来源材料/组投影（QM-15 细项 1/4）", () => {
  it("null 合法（legacy 卷未冻结依赖）；缺键拒（服务端恒写，fail-closed）", () => {
    expect(
      notebookRoundSchema.safeParse({ ...ROUND_BASE, context: null }).success,
    ).toBe(true);
    const { context: _c, ...noContext } = ROUND_BASE;
    expect(notebookRoundSchema.safeParse(noContext).success).toBe(false);
  });

  it("materials/groups 与 /attempts/:id/context 同一实例（白名单单一出处）", () => {
    const shape = notebookRoundContextSchema.shape;
    expect(shape.materials.element).toBe(attemptContextMaterialSchema);
    expect(shape.groups.element).toBe(attemptContextGroupSchema);
    // 同材料不同历史版本并存合法（细项 4：按 (id, sourceVersion) 分别保留）
    const parsed = notebookRoundContextSchema.parse({
      materials: [
        { ...ROUND_CONTEXT.materials[0], sourceVersion: 1 },
        { ...ROUND_CONTEXT.materials[0], sourceVersion: 2 },
      ],
      groups: [],
    });
    expect(parsed.materials).toHaveLength(2);
  });

  it("教师侧键剥除：材料投影混入 sourceMd/answers 经 parse strip（fail closed）", () => {
    const stripped = notebookRoundContextSchema.parse({
      materials: [
        {
          ...ROUND_CONTEXT.materials[0],
          sourceMd: "教师侧原文",
          answers: { kind: "fill", blanks: [["秘密"]] },
        },
      ],
      groups: [
        {
          ...ROUND_CONTEXT.groups[0],
          sourceMd: "组容器原文",
          answers: { kind: "judge", value: true },
        },
      ],
    });
    expect(stripped.materials[0]).not.toHaveProperty("sourceMd");
    expect(stripped.materials[0]).not.toHaveProperty("answers");
    expect(stripped.groups[0]).not.toHaveProperty("sourceMd");
    expect(stripped.groups[0]).not.toHaveProperty("answers");
    // sourceVersion ≥1（快照身份进键）
    expect(
      notebookRoundContextSchema.safeParse({
        materials: [{ ...ROUND_CONTEXT.materials[0], sourceVersion: 0 }],
        groups: [],
      }).success,
    ).toBe(false);
  });
});
