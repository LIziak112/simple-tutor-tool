import { defineDirective, getDirective } from "@tutor/contract";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { lintDocument } from "./lint.ts";

/**
 * T7.8 / 方案 §4.6：教学包声明显式引用校验。
 * 只检查显式引用存在（directives 经注册表归一、validators 对题型能力表
 * validatorId 集合）；无声明零 issue（普通 MD 不受影响）。
 * 两个 error 码在 rules.ts 登记（rules.test.ts 自动扫描兜底）。
 */

/** 临时注册带别名的测试指令（t-test- 前缀；vitest 文件级模块隔离，不污染其他文件） */
defineDirective({
  name: "t-test-pack-main",
  kind: "container",
  since: "2.0",
  allowedIn: ["lecture"],
  attrs: z.strictObject({}),
  description: "测试专用指令（t-test- 前缀），只用于教学包引用校验用例",
  example: ":::t-test-pack-main\n内容\n:::",
  aliases: ["t-test-pack-old"],
});

/** 最小合法 practice 文档（frontmatter + 一道判断题），pack 为可选声明 */
function practiceMd(packLine?: string): string {
  const fm = ["---", "kind: practice", "unit: 教学包测试"];
  if (packLine !== undefined) fm.push(packLine);
  fm.push("---", "");
  return `${fm.join("\n")}

::::question{type="judge" id="pack-q1"}
判断：$1+1=2$。

- [[正确]]
::::
`;
}

function codesOf(md: string): { code: string; level: string; line: number }[] {
  const { issues } = lintDocument(md);
  return issues.map((issue) => ({
    code: issue.code,
    level: issue.level,
    line: issue.line,
  }));
}

describe("lintTeachingPack：DIRECTIVE_REF_NOT_FOUND / VALIDATOR_REF_NOT_FOUND", () => {
  it("directives 引用未注册指令 → error，行锚 frontmatter 映射首行", () => {
    const found = codesOf(
      practiceMd(
        'teachingPack: {name: "包", directives: ["no-such-directive"]}',
      ),
    );
    expect(found).toContainEqual({
      code: "DIRECTIVE_REF_NOT_FOUND",
      level: "error",
      line: 2,
    });
  });

  it("directives 引用别名合法（经注册表归一命中主名）", () => {
    const found = codesOf(
      practiceMd(
        'teachingPack: {name: "包", directives: ["t-test-pack-old"]}',
      ),
    );
    expect(getDirective("t-test-pack-old")?.name).toBe("t-test-pack-main");
    expect(
      found.filter((i) => i.code.startsWith("DIRECTIVE_REF")),
    ).toHaveLength(0);
  });

  it("validators 引用非内置校验器 → error VALIDATOR_REF_NOT_FOUND", () => {
    const found = codesOf(
      practiceMd('teachingPack: {name: "包", validators: ["gpt-4o"]}'),
    );
    expect(found).toContainEqual({
      code: "VALIDATOR_REF_NOT_FOUND",
      level: "error",
      line: 2,
    });
  });

  it("validators 引用题型能力表 validatorId（fill/solve）合法", () => {
    const found = codesOf(
      practiceMd('teachingPack: {name: "包", validators: ["fill", "solve"]}'),
    );
    expect(
      found.filter((i) => i.code.startsWith("VALIDATOR_REF")),
    ).toHaveLength(0);
  });

  it("合法完整声明（主名 + 内置校验器）两码零 issue", () => {
    const found = codesOf(
      practiceMd(
        'teachingPack: {name: "有理数填空练习", version: "1", directives: ["blank", "steps"], validators: ["fill"]}',
      ),
    );
    expect(
      found.filter(
        (i) =>
          i.code === "DIRECTIVE_REF_NOT_FOUND" ||
          i.code === "VALIDATOR_REF_NOT_FOUND",
      ),
    ).toHaveLength(0);
  });

  it("两类缺失引用同时存在 → 各报一条 error（不去重不吞并）", () => {
    const found = codesOf(
      practiceMd(
        'teachingPack: {name: "包", directives: ["ghost-d"], validators: ["ghost-v"]}',
      ),
    );
    expect(found).toContainEqual({
      code: "DIRECTIVE_REF_NOT_FOUND",
      level: "error",
      line: 2,
    });
    expect(found).toContainEqual({
      code: "VALIDATOR_REF_NOT_FOUND",
      level: "error",
      line: 2,
    });
  });

  it("普通 MD 无声明零新增 issue（与无 teachingPack 的现状一致）", () => {
    const found = codesOf(practiceMd());
    expect(
      found.filter(
        (i) =>
          i.code === "DIRECTIVE_REF_NOT_FOUND" ||
          i.code === "VALIDATOR_REF_NOT_FOUND",
      ),
    ).toHaveLength(0);
  });
});
