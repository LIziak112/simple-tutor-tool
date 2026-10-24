import { describe, expect, it, vi } from "vitest";
import type { ResponseRow } from "../db/schema";
import {
  effectiveVerdictOfRow,
  scoreSummaryCoreOf,
  selfReviewRecordOf,
  teacherMarkOf,
} from "./attempt-service";

/**
 * QM-12（TT-09c）细项1：有效判定单一出处的纯函数层验收。
 * - teacherMarkOf：列值枚举收窄（列无 $type）；
 * - selfReviewRecordOf：P3-2 脏行防御（verdict 非空而 at 缺失 → 按无记录
 *   降级并 warn 留痕，不伪造空时间戳）；
 * - effectiveVerdictOfRow：教师判 > 自评 > 自动 三层回落（教师清除后回落
 *   自评→自动，细项3）；
 * - scoreSummaryCoreOf：attemptScoreSummaryOf / lessonLiveSummaryOf 的统一
 *   计数核心（P3-1 对齐——进行中卷只计已提交行、已收尾卷整卷口径；
 *   correct/wrong/pending 为有效判定口径；pendingCount 恒 D4 教师待批）。
 */

/** 行形态构造器（只填判定相关列，其余列由类型断言兜底） */
function rowOf(partial: {
  autoCorrect?: boolean | null;
  teacherMark?: string | null;
  selfReviewVerdict?: "correct" | "wrong" | null;
  selfReviewAt?: string | null;
  selfReviewRevision?: number;
}): Pick<
  ResponseRow,
  | "autoCorrect"
  | "teacherMark"
  | "selfReviewVerdict"
  | "selfReviewAt"
  | "selfReviewRevision"
> {
  return {
    autoCorrect: partial.autoCorrect ?? null,
    teacherMark: partial.teacherMark ?? null,
    selfReviewVerdict: partial.selfReviewVerdict ?? null,
    selfReviewAt: partial.selfReviewAt ?? null,
    selfReviewRevision: partial.selfReviewRevision ?? 0,
  };
}

describe("teacherMarkOf：teacherMark 列值枚举收窄", () => {
  it("correct/wrong 透传，其余（null/脏值）为 null", () => {
    expect(teacherMarkOf("correct")).toBe("correct");
    expect(teacherMarkOf("wrong")).toBe("wrong");
    expect(teacherMarkOf(null)).toBeNull();
    expect(teacherMarkOf("yes")).toBeNull();
  });
});

describe("selfReviewRecordOf：P3-2 脏行防御", () => {
  it("verdict=null → 无记录；verdict+at 齐全 → 完整记录", () => {
    expect(selfReviewRecordOf(rowOf({}))).toBeNull();
    expect(
      selfReviewRecordOf(
        rowOf({
          selfReviewVerdict: "correct",
          selfReviewAt: "2026-10-25T00:00:00.000Z",
          selfReviewRevision: 2,
        }),
      ),
    ).toEqual({
      verdict: "correct",
      at: "2026-10-25T00:00:00.000Z",
      revision: 2,
    });
  });

  it("脏行（verdict 非空而 at 缺失）→ 按无记录降级并 warn 留痕", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const record = selfReviewRecordOf(
        rowOf({ selfReviewVerdict: "wrong", selfReviewAt: null }),
      );
      expect(record).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("自评脏行");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("effectiveVerdictOfRow：教师判 > 自评 > 自动（细项1/3）", () => {
  it("三层回落与全空", () => {
    expect(
      effectiveVerdictOfRow(
        rowOf({
          autoCorrect: false,
          teacherMark: "correct",
          selfReviewVerdict: "wrong",
          selfReviewAt: "2026-10-25T00:00:00.000Z",
        }),
      ),
    ).toEqual({ source: "teacher", value: true });
    expect(
      effectiveVerdictOfRow(
        rowOf({
          autoCorrect: false,
          selfReviewVerdict: "wrong",
          selfReviewAt: "2026-10-25T00:00:00.000Z",
        }),
      ),
    ).toEqual({ source: "self", value: false });
    expect(effectiveVerdictOfRow(rowOf({ autoCorrect: true }))).toEqual({
      source: "auto",
      value: true,
    });
    expect(effectiveVerdictOfRow(rowOf({}))).toBeNull();
  });

  it("教师清除（teacherMark=null）后回落自评→自动（§5.5.4 ✱ 行）", () => {
    expect(
      effectiveVerdictOfRow(
        rowOf({
          autoCorrect: null,
          teacherMark: null,
          selfReviewVerdict: "correct",
          selfReviewAt: "2026-10-25T00:00:00.000Z",
        }),
      ),
    ).toEqual({ source: "self", value: true });
    expect(
      effectiveVerdictOfRow(
        rowOf({
          autoCorrect: true,
          teacherMark: null,
          selfReviewVerdict: null,
        }),
      ),
    ).toEqual({ source: "auto", value: true });
  });

  it("自评脏行（at 缺失）不参与回落——按无记录降级", () => {
    expect(
      effectiveVerdictOfRow(
        rowOf({ autoCorrect: null, selfReviewVerdict: "wrong", selfReviewAt: null }),
      ),
    ).toBeNull();
  });
});

/** 汇总核心行构造器（scoreSummaryCoreOf 输入形态） */
function summaryRow(partial: {
  hasSnapshot?: boolean;
  answerJson?: string | null;
  submittedAt?: string | null;
  autoCorrect?: boolean | null;
  finalCorrect?: boolean | null;
  gradingPolicy?: "auto" | "reference_self" | "manual_only" | null;
  teacherMark?: string | null;
  selfReviewVerdict?: "correct" | "wrong" | null;
}): Parameters<typeof scoreSummaryCoreOf>[0][number] {
  return {
    hasSnapshot: partial.hasSnapshot ?? true,
    answerJson: partial.answerJson ?? null,
    submittedAt: partial.submittedAt ?? null,
    autoCorrect: partial.autoCorrect ?? null,
    finalCorrect: partial.finalCorrect ?? null,
    gradingPolicy: partial.gradingPolicy ?? null,
    teacherMark: partial.teacherMark ?? null,
    selfReviewVerdict: partial.selfReviewVerdict ?? null,
    selfReviewAt: partial.selfReviewVerdict === null ? null : "2026-10-25T00:00:00.000Z",
    selfReviewRevision: 0,
  };
}

describe("scoreSummaryCoreOf：统一计数核心（P3-1 对齐 + 有效判定口径）", () => {
  it("自评对/错计入 correct/wrong；未自评 reference_self 行计 pending 不计 pendingCount", () => {
    const core = scoreSummaryCoreOf(
      [
        // choice：自动判对
        summaryRow({ autoCorrect: true, finalCorrect: true, gradingPolicy: "auto" }),
        // fill（reference_self）：自评错 → wrong（有效判定）
        summaryRow({ gradingPolicy: "reference_self", selfReviewVerdict: "wrong" }),
        // solve 有参考（reference_self）：自评对 → correct
        summaryRow({ gradingPolicy: "reference_self", selfReviewVerdict: "correct" }),
        // solve 无参考（manual_only）：教师未判 → pending 且 pendingCount+1
        summaryRow({ gradingPolicy: "manual_only" }),
      ],
      { finalized: true },
    );
    expect(core).toMatchObject({
      total: 4,
      correct: 2,
      wrong: 1,
      pending: 1,
      autoGradable: 3,
      // D4 教师待批：只有 manual_only 未判行；reference_self 未自评行不计
      pendingCount: 1,
    });
  });

  it("教师清除 reference_self 行后：finalCorrect=null 仍不进教师待批（回落自评）", () => {
    const core = scoreSummaryCoreOf(
      [
        summaryRow({
          gradingPolicy: "reference_self",
          teacherMark: null,
          selfReviewVerdict: "correct",
          finalCorrect: null,
        }),
      ],
      { finalized: true },
    );
    expect(core).toMatchObject({ correct: 1, wrong: 0, pending: 0, pendingCount: 0 });
  });

  it("进行中卷（finalized=false）只计已提交行；未提交行只进 total/unanswered", () => {
    const core = scoreSummaryCoreOf(
      [
        // 已提交：答对
        summaryRow({
          submittedAt: "2026-10-25T00:00:00.000Z",
          answerJson: JSON.stringify({ kind: "choice", index: 0 }),
          autoCorrect: true,
          finalCorrect: true,
          gradingPolicy: "auto",
        }),
        // 未提交：已存草稿答案也不计 answered
        summaryRow({
          answerJson: JSON.stringify({ kind: "final", finalAnswer: "草稿" }),
          gradingPolicy: "reference_self",
        }),
        // 已提交的 reference_self 行：未自评 → pending（不进 pendingCount）
        summaryRow({
          submittedAt: "2026-10-25T00:00:00.000Z",
          answerJson: JSON.stringify({ kind: "final", finalAnswer: "作答" }),
          gradingPolicy: "reference_self",
        }),
      ],
      { finalized: false },
    );
    expect(core).toMatchObject({
      total: 3,
      answered: 2,
      correct: 1,
      wrong: 0,
      pending: 1,
      unanswered: 1,
      pendingCount: 0,
    });
  });

  it("快照缺失行（幽灵行）不进任何计数", () => {
    const core = scoreSummaryCoreOf(
      [
        summaryRow({ hasSnapshot: false, autoCorrect: true, finalCorrect: true }),
        summaryRow({ autoCorrect: true, finalCorrect: true, gradingPolicy: "auto" }),
      ],
      { finalized: true },
    );
    expect(core).toMatchObject({ total: 1, correct: 1, pendingCount: 0 });
  });
});
