import { describe, expect, it } from "vitest";
import {
  aggregateSealedTime,
  sealedQuestionTimeSchema,
} from "./attempt-time-ledger.ts";

describe("封存活动账", () => {
  it("未知与真实零分开，只有全覆盖才有总用时", () => {
    const zero = sealedQuestionTimeSchema.parse({
      state: "available",
      activeSec: 0,
      observedSec: 0,
      actions: 1,
      viewed: true,
    });
    expect(
      aggregateSealedTime([
        zero,
        {
          state: "unknown",
          reason: "no_client_evidence",
          activeSec: null,
          observedSec: null,
        },
      ]),
    ).toMatchObject({
      activeSec: null,
      knownActiveSec: 0,
      memberCount: 2,
      unknownCount: 1,
    });
    expect(aggregateSealedTime([])).toMatchObject({
      activeSec: 0,
      memberCount: 0,
    });
  });
  it("不接受溢出、负数、半套未知账", () => {
    for (const activeSec of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        sealedQuestionTimeSchema.safeParse({
          state: "available",
          activeSec,
          observedSec: 0,
          actions: 0,
          viewed: false,
        }).success,
      ).toBe(false);
    expect(
      sealedQuestionTimeSchema.safeParse({
        state: "unknown",
        reason: "no_client_evidence",
        activeSec: 0,
        observedSec: null,
      }).success,
    ).toBe(false);
  });
});
