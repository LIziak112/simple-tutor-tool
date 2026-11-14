import { aggregateSealedTime } from "@tutor/contract";
import { expect, it } from "vitest";
import { attemptTimeLabel, responseTimeLabel } from "./attempt-time-label";

it("缺证、历史和真实零秒区分展示", () => {
  expect(
    attemptTimeLabel(
      aggregateSealedTime([
        {
          state: "unknown",
          reason: "no_client_evidence",
          activeSec: null,
          observedSec: null,
        },
      ]),
    ),
  ).toContain("未完整记录");
  expect(
    attemptTimeLabel({ metric: "legacy_focus", version: null, activeSec: 0 }),
  ).toBe("历史焦点用时 0 秒");
  expect(
    responseTimeLabel({
      metric: "question_activity_sealed",
      version: 1,
      value: {
        state: "available",
        activeSec: 0,
        observedSec: 0,
        actions: 1,
        viewed: true,
      },
    }),
  ).toBe("活动用时 0 秒");
});
