import { describe, expect, it } from "vitest";
import {
  attemptActivateRequestSchema,
  attemptPhaseOf,
  attemptSettlementSchema,
  isRecordableAttempt,
} from "./attempt-session.ts";

describe("作答会话阶段", () => {
  it("旧缓存缺少新增列时保持原进行中语义，只有显式 null 才表示 opened", () => {
    expect(attemptPhaseOf({ status: "draft" })).toBe("active");
    expect(isRecordableAttempt({ status: "draft" })).toBe(true);
  });
  it.each([
    ["draft", null, null, "opened", false],
    ["draft", "2026-11-01T00:00:00.000Z", null, "active", true],
    ["submitted", null, null, "finished", true],
    ["graded", null, null, "finished", true],
    [
      "draft",
      "2026-11-01T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
      "abandoned",
      false,
    ],
  ] as const)(
    "%s / %s / %s → %s",
    (status, activatedAt, abandonedAt, phase, recordable) => {
      const row = { status, activatedAt, abandonedAt };
      expect(attemptPhaseOf(row)).toBe(phase);
      expect(isRecordableAttempt(row)).toBe(recordable);
    },
  );
  it("显式激活必须声明看到的冻结版本，null 也是精确版本", () => {
    expect(
      attemptActivateRequestSchema.parse({ expectedFrozenAt: null }),
    ).toEqual({ expectedFrozenAt: null });
    expect(attemptActivateRequestSchema.safeParse({}).success).toBe(false);
    expect(
      attemptActivateRequestSchema.safeParse({ expectedFrozenAt: "旧版" })
        .success,
    ).toBe(false);
    expect(
      attemptActivateRequestSchema.safeParse({
        expectedFrozenAt: null,
        answers: [],
      }).success,
    ).toBe(false);
  });
});

const final = {
  seq: 1,
  kind: "final",
  createdAt: "2026-11-01T00:00:00.000Z",
  questionCount: 0,
  activeSec: null,
};

describe("结算事实契约", () => {
  it("零题 final 合法，真实零秒与未计算分开", () => {
    expect(attemptSettlementSchema.parse(final)).toEqual(final);
    expect(
      attemptSettlementSchema.parse({ ...final, activeSec: 0 }).activeSec,
    ).toBe(0);
  });
  it("partial 必须有成员，但契约不代表开放写入口", () => {
    expect(
      attemptSettlementSchema.safeParse({ ...final, kind: "partial" }).success,
    ).toBe(false);
    expect(
      attemptSettlementSchema.parse({
        ...final,
        kind: "partial",
        questionCount: 1,
      }).questionCount,
    ).toBe(1);
  });
  it.each([
    { seq: 0 },
    { seq: 1.5 },
    { questionCount: -1 },
    { activeSec: -1 },
    { activeSec: 0.5 },
    { createdAt: "昨天" },
    { secret: "不接受额外列" },
  ])("拒绝非法事实 %j", (patch) => {
    expect(
      attemptSettlementSchema.safeParse({ ...final, ...patch }).success,
    ).toBe(false);
  });
});
