import { describe, expect, it } from "vitest";
import {
  type Rubric,
  rubricDisagreementsOf,
  rubricEffectiveOf,
  rubricFinalRequestSchema,
  rubricMaxOf,
  rubricOpinionBlockOf,
  rubricRatingsEqual,
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

  it("rubricRatingsEqual：同一组 id 且各项档位一致才相等（evidence 不参与）", () => {
    const a = [
      { id: "r1", level: 4, evidence: "开头点题" },
      { id: "r2", level: 2 },
    ];
    expect(rubricRatingsEqual(a, [...a].reverse())).toBe(true);
    expect(
      rubricRatingsEqual(a, [
        { id: "r1", level: 4 },
        { id: "r2", level: 3 },
      ]),
    ).toBe(false);
    expect(rubricRatingsEqual(a, a.slice(0, 1))).toBe(false);
    expect(
      rubricRatingsEqual(a, [
        { id: "r1", level: 4 },
        { id: "r3", level: 2 },
      ]),
    ).toBe(false);
  });

  it("rubricOpinionBlockOf：取回信末尾的 rubric-opinion 块，返回意见与去块后的正文", () => {
    const opinion = {
      ratings: [
        { id: "r1", level: 3, evidence: "理由只有一条" },
        { id: "r2", level: 4 },
        { id: "r3", level: 2 },
      ],
      note: "整体达标。",
    };
    const md = `先说结论：写得不错。\n\n\`\`\`rubric-opinion\n${JSON.stringify(
      opinion,
      null,
      2,
    )}\n\`\`\`\n`;
    const block = rubricOpinionBlockOf(md);
    expect(block).toEqual({
      kind: "ok",
      opinion,
      rest: "先说结论：写得不错。",
    });
    // 多个块取最后一个（模型可能先草拟后修正），正文里两个块都剔掉
    const twice = `${md}\n\`\`\`rubric-opinion\n${JSON.stringify({
      ...opinion,
      note: "修正后的评语",
    })}\n\`\`\``;
    const twiceParsed = rubricOpinionBlockOf(twice);
    expect(twiceParsed.kind).toBe("ok");
    if (twiceParsed.kind !== "ok") throw new Error("unreachable");
    expect(twiceParsed.opinion.note).toBe("修正后的评语");
    expect(twiceParsed.rest).toBe("先说结论：写得不错。");
    // 没有块 → none
    expect(rubricOpinionBlockOf("只有正文")).toEqual({ kind: "none" });
    // JSON 坏 / 档位越界 → invalid，正文仍去掉块（学生不该看到原始 JSON）
    expect(
      rubricOpinionBlockOf("正文\n\n```rubric-opinion\n{oops\n```"),
    ).toEqual({
      kind: "invalid",
      rest: "正文",
      problem: "代码块里不是合法的 JSON",
    });
    expect(
      rubricOpinionBlockOf(
        `\`\`\`rubric-opinion\n${JSON.stringify({
          ratings: [{ id: "r1", level: 9 }],
          note: "x",
        })}\n\`\`\``,
      ).kind,
    ).toBe("invalid");
  });

  it("rubricOpinionBlockOf：对模型的小偏差宽松（未知键 / 字符串档位 / 缺评语 / CRLF），内联提及不算块", () => {
    // 未知键忽略、"3" 当 3、note 缺省为空串、块在正文中间也认
    const lenient = rubricOpinionBlockOf(
      `前言\r\n\r\n\`\`\`rubric-opinion\r\n${JSON.stringify({
        title: "草稿",
        ratings: [{ id: "r1", level: "3", evidence: "  有依据  ", extra: 1 }],
      })}\r\n\`\`\`\r\n\r\n后记`,
    );
    expect(lenient).toEqual({
      kind: "ok",
      opinion: {
        ratings: [{ id: "r1", level: 3, evidence: "有依据" }],
        note: "",
      },
      rest: "前言\n\n后记",
    });
    // 正文里内联提到 ```rubric-opinion 不是开栏，不会把后面真正的块吞掉
    const inline = rubricOpinionBlockOf(
      `我会在末尾附 \`\`\`rubric-opinion 块。\n\n\`\`\`rubric-opinion\n${JSON.stringify(
        { ratings: [{ id: "r1", level: 2 }], note: "ok" },
      )}\n\`\`\``,
    );
    expect(inline).toEqual({
      kind: "ok",
      opinion: { ratings: [{ id: "r1", level: 2 }], note: "ok" },
      rest: "我会在末尾附 ```rubric-opinion 块。",
    });
    // 缩进的闭栏也认；开栏带语言后缀（```rubric-opinion json）也认
    expect(
      rubricOpinionBlockOf(
        `\`\`\`rubric-opinion json\n{"ratings":[{"id":"r1","level":1}],"note":"n"}\n  \`\`\``,
      ).kind,
    ).toBe("ok");
  });
});
