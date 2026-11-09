import { describe, expect, it } from "vitest";
import {
  type Rubric,
  rubricDisagreementsOf,
  rubricEffectiveOf,
  rubricFinalRequestSchema,
  rubricMaxOf,
  rubricRatingsProblem,
  rubricSchema,
  rubricSelfRequestSchema,
  rubricTotalOf,
} from "./rubric.ts";

const RUBRIC: Rubric = {
  items: [
    { id: "r1", title: "要点覆盖", desc: "是否点明观点" },
    { id: "r2", title: "结构" },
    { id: "r3", title: "字数" },
  ],
  levels: 4,
};

describe("量表契约（模块 3）", () => {
  it("rubricSchema：1–8 项、固定 4 档；档位越界与空项拒绝", () => {
    expect(rubricSchema.safeParse(RUBRIC).success).toBe(true);
    expect(rubricSchema.safeParse({ ...RUBRIC, items: [] }).success).toBe(
      false,
    );
    expect(rubricSchema.safeParse({ ...RUBRIC, levels: 5 }).success).toBe(
      false,
    );
    expect(
      rubricSelfRequestSchema.safeParse({
        ratings: [{ id: "r1", level: 5 }],
      }).success,
    ).toBe(false);
    // note 缺省为空串（自评可以只给档位）
    expect(
      rubricSelfRequestSchema.parse({ ratings: [{ id: "r1", level: 1 }] }).note,
    ).toBe("");
    expect(
      rubricFinalRequestSchema.safeParse({ decision: "teacher", note: "" })
        .success,
    ).toBe(false);
  });

  it("rubricRatingsProblem：未知项 / 重复项 / 缺项各给一句原因，齐全返回 null", () => {
    const full = [
      { id: "r1", level: 4 },
      { id: "r2", level: 2 },
      { id: "r3", level: 3 },
    ];
    expect(rubricRatingsProblem(RUBRIC, full)).toBeNull();
    expect(
      rubricRatingsProblem(RUBRIC, [...full, { id: "r9", level: 1 }]),
    ).toContain("r9");
    expect(
      rubricRatingsProblem(RUBRIC, [...full, { id: "r1", level: 1 }]),
    ).toContain("重复");
    expect(rubricRatingsProblem(RUBRIC, full.slice(0, 2))).toContain("字数");
  });

  it("合计 / 满分 / 分歧 / 生效档位", () => {
    const self = [
      { id: "r1", level: 4 },
      { id: "r2", level: 2 },
      { id: "r3", level: 3 },
    ];
    const agent = [
      { id: "r1", level: 3 },
      { id: "r2", level: 2 },
      { id: "r3", level: 4 },
    ];
    expect(rubricTotalOf(self)).toBe(9);
    expect(rubricMaxOf(RUBRIC)).toBe(12);
    expect(rubricDisagreementsOf(self, agent)).toEqual(["r1", "r3"]);
    expect(rubricEffectiveOf({ self: null, final: null })).toBeNull();
    const at = "2026-11-09T00:00:00.000Z";
    expect(
      rubricEffectiveOf({
        self: { source: "self", ratings: self, note: "", at },
        final: null,
      }),
    ).toEqual(self);
    expect(
      rubricEffectiveOf({
        self: { source: "self", ratings: self, note: "", at },
        final: { decision: "agent", ratings: agent, note: "", at },
      }),
    ).toEqual(agent);
  });
});
