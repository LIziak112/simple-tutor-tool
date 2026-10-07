import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  notebookRoundSchema,
  studentNotebookDataSchema,
  studentNotebookOkSchema,
} from "./student-notebook-api.ts";

/**
 * 题目笔记本聚合契约自测（T6R.15）：锁定 GET /api/student/notebook/questions/
 * :questionId 的轮次聚合形状。对照派单失败测试清单：rounds 空/多轮、
 * questionVersion null 合法、evidence null 合法、零答案负向断言
 * （AGENTS.md 第 3 条：契约键集合结构上不含答案/详解/提示类字段）。
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

/** 轮次基座（第一轮：frozen 原稿 + 一条已封存订正） */
const ROUND_BASE = {
  attemptId: ATTEMPT_ID,
  sourceType: "course",
  sourceLabel: "一元一次方程 · 第 2 次",
  submittedAt: "2026-10-06T03:00:00.000Z",
  roundOrdinal: 1,
  questionVersion: 3,
  evidence: FROZEN_EVIDENCE,
  corrections: [SEALED_CORRECTION, OPEN_CORRECTION],
  supplements: [],
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
          evidence: {
            attemptId: "55555555-5555-4555-8555-555555555555",
            questionId: "p4-q7",
            state: "missing",
            versionId: null,
            recordedAt: "2026-10-07T05:00:00.000Z",
          },
          corrections: [],
          supplements: [SUPPLEMENT],
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

  it("契约键集合不含答案/详解/提示/题干/判定类字段；顶层键精确锁定", () => {
    const keys = [...collectKeys(studentNotebookDataSchema)];
    const forbidden = [
      "answer",
      "answers",
      "solution",
      "solutionMd",
      "hint",
      "hints",
      "stem",
      "stemMd",
      "options",
      "answerText",
      "autoCorrect",
      "finalCorrect",
      "correct",
      "questionSnapshotJson",
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
      "evidence",
      "corrections",
      "supplements",
    ]);
    expect(Object.keys(studentNotebookDataSchema.shape)).toEqual([
      "questionId",
      "rounds",
    ]);
  });
});
