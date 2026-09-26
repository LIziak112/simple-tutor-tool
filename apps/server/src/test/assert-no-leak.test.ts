import { describe, expect, it } from "vitest";
import { assertNoLeak } from "./assert-no-leak.ts";

/**
 * 泄露断言工具自测（工具本身失效 = 全部学生端泄露测试形同虚设，必须先测工具）：
 * 默认禁用键在任意嵌套层级命中；hintCount/hintsUsed 放行；allow/forbid 可配置；
 * 干净响应正常通过。
 */
describe("assertNoLeak（通用泄露断言工具）", () => {
  it("干净响应（含 stemMd/options 公开字段）通过", () => {
    expect(() =>
      assertNoLeak({
        ok: true,
        data: {
          questions: [
            {
              id: "q1",
              stemMd: "计算：$1+1=$ [[]]",
              options: ["$1$", "$2$"],
              hintCount: 2,
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("answers/solution*/hints 内容/passwordHash/linkToken/sourceMd/optionsJson 在任意嵌套层级命中", () => {
    const cases: unknown[] = [
      {
        ok: true,
        data: {
          questions: [{ id: "q", answers: { kind: "fill", blanks: [["2"]] } }],
        },
      },
      { data: [{ solutionMd: "详解" }] },
      { data: { nested: { deep: [{ solution: "s" }] } } },
      { data: { hints: ["提示"] } },
      { data: { hintsJson: "[]" } },
      { data: { teacher: { passwordHash: "x", linkToken: "y" } } },
      { data: { sourceMd: "::::question" } },
      {
        data: { questions: [{ optionsJson: '[{"text":"A","correct":true}]' }] },
      },
    ];
    for (const body of cases) {
      expect(() => assertNoLeak(body)).toThrow(/泄露/);
    }
  });

  it("hintCount 与 hintsUsed（公开/学生自己的计数）不命中", () => {
    expect(() =>
      assertNoLeak({ data: { hintCount: 3, hintsUsed: 1 } }),
    ).not.toThrow();
  });

  it("opts.allow 豁免指定键；opts.forbid 追加禁用键（如列表接口的 stemMd/questions）", () => {
    expect(() =>
      assertNoLeak({ data: { answer: "草稿" } }, { allow: ["answer"] }),
    ).not.toThrow();
    expect(() =>
      assertNoLeak({ data: { stemMd: "题干" } }, { forbid: ["stemMd"] }),
    ).toThrow(/stemMd/);
    expect(() =>
      assertNoLeak(
        { data: { questions: [] } },
        { forbid: ["questions", "options"] },
      ),
    ).toThrow(/questions/);
  });
});
