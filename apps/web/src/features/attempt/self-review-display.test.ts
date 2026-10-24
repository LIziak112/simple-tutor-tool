import type { AttemptResultQuestion } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { verdictBadgeDisplayOf } from "./self-review-display";

/**
 * 判定徽章显示参数单一出处（QM-11 细项 3）：reference_self 行三态明确，
 * 其余行沿既有 finalCorrect 路径零变化。
 */

const row = (
  overrides: Partial<
    Pick<
      AttemptResultQuestion,
      | "gradingPolicy"
      | "teacherMark"
      | "selfReview"
      | "finalCorrect"
      | "autoCorrect"
    >
  > = {},
) => ({
  gradingPolicy: null,
  teacherMark: null,
  selfReview: null,
  finalCorrect: null,
  autoCorrect: null,
  ...overrides,
});

describe("verdictBadgeDisplayOf", () => {
  it("reference_self 未自评/已撤回 → 已完成、待自评（不冒充待老师批改）", () => {
    expect(
      verdictBadgeDisplayOf(row({ gradingPolicy: "reference_self" })),
    ).toEqual({ verdict: null, pendingLabel: "已完成、待自评" });
    expect(
      verdictBadgeDisplayOf(
        row({
          gradingPolicy: "reference_self",
          selfReview: { record: null, revision: 2 },
        }),
      ),
    ).toEqual({ verdict: null, pendingLabel: "已完成、待自评" });
  });

  it("reference_self 已自评 → 自评正确/自评错误（教师未判）", () => {
    expect(
      verdictBadgeDisplayOf(
        row({
          gradingPolicy: "reference_self",
          selfReview: {
            record: { verdict: "correct", at: "t", revision: 1 },
            revision: 1,
          },
        }),
      ),
    ).toEqual({
      verdict: true,
      correctLabel: "自评正确",
      wrongLabel: "自评错误",
    });
    expect(
      verdictBadgeDisplayOf(
        row({
          gradingPolicy: "reference_self",
          selfReview: {
            record: { verdict: "wrong", at: "t", revision: 1 },
            revision: 1,
          },
        }),
      ).verdict,
    ).toBe(false);
  });

  it("教师已判/manual_only/auto/旧行/公布前 null 投影 → 沿既有 finalCorrect 路径", () => {
    // reference_self 但教师已判：教师优先，徽章走 finalCorrect（=教师判定）
    expect(
      verdictBadgeDisplayOf(
        row({
          gradingPolicy: "reference_self",
          teacherMark: "correct",
          finalCorrect: true,
          selfReview: {
            record: { verdict: "wrong", at: "t", revision: 1 },
            revision: 1,
          },
        }),
      ),
    ).toEqual({ verdict: true });
    // manual_only / 旧行（null）/ 公布前 null 投影：finalCorrect ?? autoCorrect
    expect(
      verdictBadgeDisplayOf(row({ gradingPolicy: "manual_only" })),
    ).toEqual({ verdict: null });
    expect(verdictBadgeDisplayOf(row({ finalCorrect: true }))).toEqual({
      verdict: true,
    });
    // 待批 = finalCorrect 与 autoCorrect 均空（M6 兜底口径，与服务端
    // effectiveVerdictOf 的自动回落一致）；进行中单题反馈只有 autoCorrect
    expect(verdictBadgeDisplayOf(row({ finalCorrect: null }))).toEqual({
      verdict: null,
    });
    expect(
      verdictBadgeDisplayOf(row({ finalCorrect: null, autoCorrect: false })),
    ).toEqual({ verdict: false });
    expect(
      verdictBadgeDisplayOf(row({ finalCorrect: null, autoCorrect: true })),
    ).toEqual({ verdict: true });
  });
});
