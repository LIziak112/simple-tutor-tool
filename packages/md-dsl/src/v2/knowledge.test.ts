import { describe, expect, it } from "vitest";
import { lintDocument } from "../lint/lint.ts";
import { parseDocument } from "./parse.ts";

describe("knowledge 多考点", () => {
  it.each(["practice", "mixed", "lesson"])(
    "%s：拆分、去空、保序去重，原文往返不丢考点",
    (kind) => {
      const markdown = [
        "---",
        `kind: ${kind}`,
        "unit: 多考点练习",
        "---",
        ...(kind === "practice" ? [] : ["# 多考点讲义"]),
        '::::question{type=judge id=multi-knowledge knowledge=" 数轴 | 有理数加法 || 数轴 | "}',
        "判断。[[正确]]",
        "::::",
      ].join("\n");
      const result = lintDocument(markdown);
      expect(result.issues).toEqual([]);
      const question = result.parsed.units[0]?.questions[0];
      expect(question?.knowledge).toEqual(["数轴", "有理数加法"]);
      const roundTrip = parseDocument(question?.sourceMd ?? "", {
        unitId: "多考点练习",
      });
      expect(roundTrip.units[0]?.questions[0]?.knowledge).toEqual([
        "数轴",
        "有理数加法",
      ]);
    },
  );

  it.each([
    [undefined, []],
    [" 有理数加法 ", ["有理数加法"]],
    ["加法、减法|逗号,保留", ["加法、减法", "逗号,保留"]],
  ])("缺省与单值：%s", (value, expected) => {
    const attr = value === undefined ? "" : ` knowledge="${value}"`;
    const result = parseDocument(
      `::::question{type=judge${attr}}\n[[正确]]\n::::`,
    );
    expect(result.units[0]?.questions[0]?.knowledge).toEqual(expected);
  });

  it.each(["", "   ", "|", " | | "])(
    "空考点 %j 阻断导入并定位题块",
    (value) => {
      const result = lintDocument(
        `---\nkind: practice\nunit: 测试\n---\n::::question{type=judge knowledge="${value}"}\n[[正确]]\n::::`,
      );
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "INVALID_QUESTION_ATTRS",
          level: "error",
          line: 5,
        }),
      );
    },
  );
});
