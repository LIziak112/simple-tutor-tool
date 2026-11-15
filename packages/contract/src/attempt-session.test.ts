import { describe, expect, it } from "vitest";
import { attemptSettlementSchema } from "./attempt-session.ts";

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
