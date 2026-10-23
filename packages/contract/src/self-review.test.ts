import { describe, expect, it } from "vitest";

import type { QuestionType } from "./content.ts";
import {
  effectiveVerdictOf,
  finalCorrectOf,
  isTeacherPendingState,
  resolveSelfReviewState,
  selfReviewDataSchema,
  selfReviewRecordSchema,
  selfReviewRequestSchema,
  type SelfReviewRecord,
  verdictSourceSchema,
} from "./self-review.ts";

/**
 * 自评与判定状态契约测试（TT-05a 域③，QM-01 §5.5 定稿）：
 * 三源分立（D7）、有效判定投影 effectiveVerdict 三层回落、单题三态推导
 * （§5.5.3 状态机）、教师清除回落（§5.5.4 组合全表）、批改状态不阻止完成。
 */

const selfReviewCorrect: SelfReviewRecord = {
  verdict: "correct",
  at: "2026-10-24T00:00:00.000Z",
  revision: 1,
};

describe("来源枚举与请求/记录 schema（§5.5.1）", () => {
  it("判断来源三值：auto / teacher / self（AI 评判接入时另行扩展）", () => {
    expect(verdictSourceSchema.options).toEqual(["auto", "teacher", "self"]);
  });

  it("自评请求：verdict 含 undecided（撤回=清除记录）、baseRevision CAS、mutationId 幂等键", () => {
    expect(
      selfReviewRequestSchema.parse({
        verdict: "correct",
        baseRevision: 0,
        mutationId: "0d0f1a1a-8f1f-4b0b-9d9d-2a2a2a2a2a2a",
      }),
    ).toEqual({
      verdict: "correct",
      baseRevision: 0,
      mutationId: "0d0f1a1a-8f1f-4b0b-9d9d-2a2a2a2a2a2a",
    });
    expect(
      selfReviewRequestSchema.safeParse({
        verdict: "undecided",
        baseRevision: 3,
        mutationId: "0d0f1a1a-8f1f-4b0b-9d9d-2a2a2a2a2a2a",
      }).success,
    ).toBe(true);
    // 负基线 / 非 uuid 幂等键 / 非法 verdict 均拒绝
    expect(
      selfReviewRequestSchema.safeParse({
        verdict: "correct",
        baseRevision: -1,
        mutationId: "0d0f1a1a-8f1f-4b0b-9d9d-2a2a2a2a2a2a",
      }).success,
    ).toBe(false);
    expect(
      selfReviewRequestSchema.safeParse({
        verdict: "correct",
        baseRevision: 0,
        mutationId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      selfReviewRequestSchema.safeParse({
        verdict: "对",
        baseRevision: 0,
        mutationId: "0d0f1a1a-8f1f-4b0b-9d9d-2a2a2a2a2a2a",
      }).success,
    ).toBe(false);
  });

  it("自评记录只存 correct/wrong（undecided=清除，天然无记录）", () => {
    expect(selfReviewRecordSchema.safeParse(selfReviewCorrect).success).toBe(
      true,
    );
    expect(
      selfReviewRecordSchema.safeParse({ ...selfReviewCorrect, verdict: "undecided" })
        .success,
    ).toBe(false);
  });

  it("响应 data：selfReview 可空（撤回后/从未自评）+ effective 投影 + 卷汇总", () => {
    const parsed = selfReviewDataSchema.parse({
      selfReview: null,
      effective: null,
      summary: {
        total: 2,
        answered: 2,
        correct: 0,
        wrong: 0,
        pending: 2,
        unanswered: 0,
        autoGradable: 0,
        scoreFinal: null,
        pendingCount: 2,
      },
    });
    expect(parsed.selfReview).toBeNull();
    expect(parsed.effective).toBeNull();
  });
});

describe("三源分立与有效判定（§5.5.2/§5.5.4 组合全表，✱=教师清除后）", () => {
  it("finalCorrect 持久语义冻结：teacherMark ?? autoCorrect（D3/D7，自评不写入）", () => {
    expect(finalCorrectOf(null, true)).toBe(true);
    expect(finalCorrectOf(null, null)).toBeNull();
    expect(finalCorrectOf("wrong", true)).toBe(false);
    expect(finalCorrectOf("correct", null)).toBe(true);
  });

  it("effectiveVerdict 三层回落：teacher > self > auto；全无=未判断（null）", () => {
    // autoCorrect 存在、teacherMark null：自评在场则自评优先于自动（§5.5.2 回落序）
    expect(effectiveVerdictOf(true, null, selfReviewCorrect)).toEqual({
      source: "self",
      value: true,
    });
    expect(effectiveVerdictOf(false, null, null)).toEqual({
      source: "auto",
      value: false,
    });
    // 行 2：teacherMark 存在 → teacher（自评/自动都让位）
    expect(effectiveVerdictOf(true, "wrong", selfReviewCorrect)).toEqual({
      source: "teacher",
      value: false,
    });
    // 行 3：teacher/auto 全无、有自评 → self
    expect(effectiveVerdictOf(null, null, selfReviewCorrect)).toEqual({
      source: "self",
      value: true,
    });
    expect(
      effectiveVerdictOf(null, null, { ...selfReviewCorrect, verdict: "wrong" }),
    ).toEqual({ source: "self", value: false });
    // 行 4：三源全无 → 未判断
    expect(effectiveVerdictOf(null, null, null)).toBeNull();
    // 行 5（✱教师清除→null）：自评恢复生效
    expect(effectiveVerdictOf(null, null, selfReviewCorrect)).toEqual({
      source: "self",
      value: true,
    });
    // 行 6（✱清除、无自评）：未判断
    expect(effectiveVerdictOf(null, null, null)).toBeNull();
  });
});

describe("单题三态推导（§5.5.3 状态机，TT-09 服务端 resolveSelfReviewState 消费）", () => {
  const base = {
    submitted: true,
    released: true,
    autoCorrect: null,
    teacherMark: null,
    selfReview: null,
    hasReference: true,
  } as const;

  it("行未提交 → not_submitted；已提交未公布 → pending_release（无自评入口、不显示答案）", () => {
    expect(
      resolveSelfReviewState({ ...base, submitted: false }),
    ).toBe("not_submitted");
    expect(
      resolveSelfReviewState({ ...base, released: false }),
    ).toBe("pending_release");
  });

  it("已提交已公布：teacher 判定优先于 auto（教师权威线）", () => {
    expect(
      resolveSelfReviewState({
        ...base,
        teacherMark: "correct",
        autoCorrect: false,
      }),
    ).toBe("teacher_judged");
    expect(
      resolveSelfReviewState({ ...base, autoCorrect: true }),
    ).toBe("auto_judged");
  });

  it("有参考答案：未自评=self_pending（不入教师必批队列）；已自评=self_reviewed", () => {
    expect(resolveSelfReviewState(base)).toBe("self_pending");
    expect(
      resolveSelfReviewState({ ...base, selfReview: selfReviewCorrect }),
    ).toBe("self_reviewed");
  });

  it("无参考答案（manual_only）：教师待处理=唯一判定出口在教师，进必批队列", () => {
    expect(
      resolveSelfReviewState({ ...base, hasReference: false }),
    ).toBe("teacher_pending");
    expect(
      resolveSelfReviewState({
        ...base,
        hasReference: false,
        teacherMark: "wrong",
      }),
    ).toBe("teacher_judged");
  });

  it("教师清除回落：无参考行清除后回到 teacher_pending（行 5/6 的状态面）", () => {
    // 教师已判后清除 → teacherMark=null、无参考、无自评 → 回必批队列
    expect(
      resolveSelfReviewState({ ...base, hasReference: false }),
    ).toBe("teacher_pending");
    // 有参考行清除后 → self_pending（自评若在则 self_reviewed）
    expect(
      resolveSelfReviewState({
        ...base,
        selfReview: selfReviewCorrect,
      }),
    ).toBe("self_reviewed");
  });

  it("教师待处理谓词与批改状态不阻止完成的语义面", () => {
    expect(isTeacherPendingState("teacher_pending")).toBe(true);
    for (const state of [
      "not_submitted",
      "pending_release",
      "teacher_judged",
      "auto_judged",
      "self_pending",
      "self_reviewed",
    ] as const) {
      expect(isTeacherPendingState(state)).toBe(false);
    }
  });
});
