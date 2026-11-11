import { describe, expect, it } from "vitest";
import { parseDocument } from "./parse";

/**
 * `:::rubric` 量表解析（模块 3 通用量表判卷）：每行一项「- 项名：评什么」，
 * id 按序 r1…；量表块不进题干；客观题内记 error 并忽略；空 / 超项 / 坏项报码。
 */

function doc(questionBlock: string): string {
  return [
    "---",
    "kind: practice",
    "unit: 量表单元",
    "---",
    "",
    questionBlock,
  ].join("\n");
}

describe("量表解析", () => {
  it("response 题内四项量表：id 按序、说明可省、题干不含量表块", () => {
    const parsed = parseDocument(
      doc(`::::question{type=response difficulty=2}
结合材料写一篇 800 字的策论。

:::rubric
- 要点覆盖：是否覆盖材料核心要点
- 结构：总分总、段落清晰
- 字数
* 用时：在限时内完成
:::

:::answer
参考要点：……
:::
::::`),
    );
    const question = parsed.units[0]?.questions[0];
    expect(parsed.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(question?.rubric).toEqual({
      levels: 4,
      items: [
        { id: "r1", title: "要点覆盖", desc: "是否覆盖材料核心要点" },
        { id: "r2", title: "结构", desc: "总分总、段落清晰" },
        { id: "r3", title: "字数" },
        { id: "r4", title: "用时", desc: "在限时内完成" },
      ],
    });
    expect(question?.stemMd).not.toContain("要点覆盖");
    expect(question?.stemMd).toContain("策论");
  });

  it("客观题内的量表：RUBRIC_ON_OBJECTIVE_QUESTION 且不注入 rubric", () => {
    const parsed = parseDocument(
      doc(`::::question{type=judge}
$1$ 是正数。[[正确]]
:::rubric
- 要点
:::
::::`),
    );
    expect(parsed.units[0]?.questions[0]?.rubric).toBeUndefined();
    expect(parsed.issues.map((i) => i.code)).toContain(
      "RUBRIC_ON_OBJECTIVE_QUESTION",
    );
  });

  it("空量表 / 超过 8 项 / 坏项分别报码", () => {
    const empty = parseDocument(
      doc(`::::question{type=solve}
解方程。
:::rubric
:::
::::`),
    );
    expect(empty.issues.map((i) => i.code)).toContain("RUBRIC_EMPTY");
    const many = parseDocument(
      doc(`::::question{type=solve}
解方程。
:::rubric
${Array.from({ length: 9 }, (_, i) => `- 项 ${i + 1}`).join("\n")}
:::
::::`),
    );
    expect(many.issues.map((i) => i.code)).toContain("RUBRIC_TOO_MANY_ITEMS");
    expect(many.units[0]?.questions[0]?.rubric).toBeUndefined();
    const bad = parseDocument(
      doc(`::::question{type=solve}
解方程。
:::rubric
- ：没有项名
- 正常项：说明
:::
::::`),
    );
    expect(bad.issues.map((i) => i.code)).toContain("RUBRIC_ITEM_INVALID");
    expect(bad.units[0]?.questions[0]?.rubric?.items).toEqual([
      { id: "r1", title: "正常项", desc: "说明" },
    ]);
  });
});
