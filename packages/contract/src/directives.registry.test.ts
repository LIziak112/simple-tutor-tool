import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineDirective, getDirective, listDirectives } from "./directives";

/**
 * 注册表「机制」测试：注册/查询/别名/唯一性/定义校验。
 * 与 directives.test.ts（首发清单断言）分文件的原因：本文件会临时注册测试专用指令，
 * vitest 默认按测试文件隔离模块图，因此不会污染其他文件里的注册表实例。
 */

/** 构造一个最小合法的测试指令定义，供各用例按需覆盖字段 */
function testDirective(overrides: {
  name?: string;
  kind?: "container" | "leaf" | "text";
  aliases?: string[];
  example?: string;
}) {
  const name = overrides.name ?? "t-test-demo";
  return defineDirective({
    name,
    kind: overrides.kind ?? "container",
    since: "2.0",
    allowedIn: ["lecture"],
    attrs: z.strictObject({}),
    description: "测试专用指令（t-test- 前缀），只用于验证注册表机制",
    example: overrides.example ?? `:::${name}\n内容\n:::`,
    // exactOptionalPropertyTypes：undefined 不能显式赋给可选属性，条件展开
    ...(overrides.aliases === undefined ? {} : { aliases: overrides.aliases }),
  });
}

describe("注册与查询", () => {
  it("注册后按主名能查到，返回的定义字段完整", () => {
    testDirective({ name: "t-test-by-name" });
    const found = getDirective("t-test-by-name");
    expect(found).toBeDefined();
    expect(found?.name).toBe("t-test-by-name");
    expect(found?.kind).toBe("container");
    expect(found?.since).toBe("2.0");
    expect(found?.description.length).toBeGreaterThan(0);
  });

  it("按别名查询能查到主指令（name 为主名，非别名）", () => {
    testDirective({ name: "t-test-alias-main", aliases: ["t-test-alias-old"] });
    // 别名查到的必须是主指令定义
    const byAlias = getDirective("t-test-alias-old");
    expect(byAlias?.name).toBe("t-test-alias-main");
    // 主名与别名查到的是同一个对象
    expect(getDirective("t-test-alias-main")).toBe(byAlias);
  });

  it("listDirectives 包含新注册指令且别名不单独成条，注册顺序保持", () => {
    const before = listDirectives().length;
    testDirective({ name: "t-test-listed", aliases: ["t-test-listed-old"] });
    const names = listDirectives().map((d) => d.name);
    expect(listDirectives().length).toBe(before + 1);
    expect(names).toContain("t-test-listed");
    // 别名不出现在指令清单里（清单按主名列出）
    expect(names).not.toContain("t-test-listed-old");
    // 新指令追加在注册顺序末尾
    expect(names[names.length - 1]).toBe("t-test-listed");
  });

  it("未知名/别名查询返回 undefined（未知指令由 linter 出 warning，不由注册表抛错）", () => {
    expect(getDirective("t-test-never-registered")).toBeUndefined();
  });
});

describe("名称唯一性（验收第 4 条）", () => {
  it("与已注册主名重名时抛出明确错误", () => {
    testDirective({ name: "t-test-dup" });
    expect(() => testDirective({ name: "t-test-dup" })).toThrow(
      /t-test-dup.*冲突|冲突.*t-test-dup/,
    );
  });

  it("别名与既有主名冲突时抛错", () => {
    testDirective({ name: "t-test-alias-hit-base" });
    expect(() =>
      testDirective({
        name: "t-test-alias-hit",
        aliases: ["t-test-alias-hit-base"],
      }),
    ).toThrow(/t-test-alias-hit-base/);
  });

  it("别名与既有别名冲突时抛错", () => {
    testDirective({
      name: "t-test-alias-a",
      aliases: ["t-test-clash"],
    });
    expect(() =>
      testDirective({ name: "t-test-alias-b", aliases: ["t-test-clash"] }),
    ).toThrow(/t-test-clash/);
  });
});

describe("指令定义校验（注册期 fail fast）", () => {
  it("指令名只允许小写字母开头、小写字母/数字/连字符", () => {
    for (const bad of ["Tip", "1abc", "a b", "有理数", ""]) {
      expect(() => testDirective({ name: bad })).toThrow(/不合法/);
    }
  });

  it("since 必须是版本号格式（如 2.0）", () => {
    expect(() =>
      defineDirective({
        name: "t-test-bad-since",
        kind: "container",
        since: "latest",
        allowedIn: ["lecture"],
        attrs: z.strictObject({}),
        description: "测试",
        example: ":::t-test-bad-since\n内容\n:::",
      }),
    ).toThrow(/不合法/);
  });

  it("allowedIn 为空数组时拒绝", () => {
    expect(() =>
      defineDirective({
        name: "t-test-empty-loc",
        kind: "container",
        since: "2.0",
        allowedIn: [],
        attrs: z.strictObject({}),
        description: "测试",
        example: ":::t-test-empty-loc\n内容\n:::",
      }),
    ).toThrow(/不合法/);
  });

  it("container 的 example 不以「:::名称 … :::」形态呈现时拒绝", () => {
    // 缺少结束围栏
    expect(() =>
      testDirective({
        name: "t-test-bad-ex1",
        example: ":::t-test-bad-ex1\n只有开始",
      }),
    ).toThrow(/example/);
    // 开始行不是该指令名
    expect(() =>
      testDirective({
        name: "t-test-bad-ex2",
        example: ":::别的指令\n内容\n:::",
      }),
    ).toThrow(/example/);
  });

  it("leaf 的 example 必须是「::名称[文字]{属性}」单行形态", () => {
    expect(() =>
      testDirective({
        name: "t-test-bad-leaf",
        kind: "leaf",
        example: '::graph{fn="x"}',
      }),
    ).toThrow(/example/);
    // 正确形态应可注册
    expect(() =>
      testDirective({
        name: "t-test-ok-leaf",
        kind: "leaf",
        example: '::t-test-ok-leaf[x]{k="v"}',
      }),
    ).not.toThrow();
  });

  it("text 的 example 必须含「:名称[」，且不得写成块级「::名称[」形态", () => {
    // 写成了块级形态
    expect(() =>
      testDirective({
        name: "t-test-bad-text",
        kind: "text",
        example: "句子 ::t-test-bad-text[重点] 结尾",
      }),
    ).toThrow(/example/);
    // 正确形态应可注册
    expect(() =>
      testDirective({
        name: "t-test-ok-text",
        kind: "text",
        example: "句子 :t-test-ok-text[重点] 结尾",
      }),
    ).not.toThrow();
  });

  it("attrDocs 键必须在 attrs 属性中，未知键拒绝（gen:spec 数据源防漂移）", () => {
    // 合法：键与 attrs 的业务属性一一对应（id/class 底座说明统一写在规范总则，不经 attrDocs）
    expect(() =>
      defineDirective({
        name: "t-test-attrdocs-ok",
        kind: "container",
        since: "2.0",
        allowedIn: ["lecture"],
        attrs: z.strictObject({ title: z.string().optional() }),
        attrDocs: { title: "标题，可选" },
        description: "测试",
        example: ":::t-test-attrdocs-ok\n内容\n:::",
      }),
    ).not.toThrow();
    // 非法：说明指向不存在的属性
    expect(() =>
      defineDirective({
        name: "t-test-attrdocs-bad",
        kind: "container",
        since: "2.0",
        allowedIn: ["lecture"],
        attrs: z.strictObject({ title: z.string().optional() }),
        attrDocs: { titel: "拼错的键" },
        description: "测试",
        example: ":::t-test-attrdocs-bad\n内容\n:::",
      }),
    ).toThrow(/attrDocs.*titel|titel.*attrDocs/);
  });
});
