import { describe, expect, it } from "vitest";
import { frontmatterSchema } from "./content.ts";
import { teachingPackSchema } from "./teaching-pack.ts";

/** T7.8 / 方案 §4.6：教学包声明的最小契约——依赖声明，不是能力定义 */
describe("teachingPackSchema", () => {
  it('缺省值：formatVersion=1、version="1"、directives/validators=[]', () => {
    const parsed = teachingPackSchema.parse({ name: "有理数填空练习" });
    expect(parsed).toEqual({
      formatVersion: 1,
      name: "有理数填空练习",
      version: "1",
      directives: [],
      validators: [],
    });
  });

  it("完整声明原样保留（引用数组不去重不改序）", () => {
    const parsed = teachingPackSchema.parse({
      formatVersion: 1,
      name: "混合练习",
      version: "v2.1",
      directives: ["steps", "blank"],
      validators: ["fill", "solve"],
    });
    expect(parsed).toEqual({
      formatVersion: 1,
      name: "混合练习",
      version: "v2.1",
      directives: ["steps", "blank"],
      validators: ["fill", "solve"],
    });
  });

  it("name 必填非空；version 非空；formatVersion 只接受 1", () => {
    expect(teachingPackSchema.safeParse({}).success).toBe(false);
    expect(teachingPackSchema.safeParse({ name: "" }).success).toBe(false);
    expect(
      teachingPackSchema.safeParse({ name: "x", version: "" }).success,
    ).toBe(false);
    expect(
      teachingPackSchema.safeParse({ name: "x", formatVersion: 2 }).success,
    ).toBe(false);
  });

  it("directives/validators 数组元素非空字符串；传对象/数字拒绝", () => {
    expect(
      teachingPackSchema.safeParse({ name: "x", directives: [""] }).success,
    ).toBe(false);
    expect(
      teachingPackSchema.safeParse({ name: "x", validators: [1] }).success,
    ).toBe(false);
    expect(
      teachingPackSchema.safeParse({ name: "x", directives: {} }).success,
    ).toBe(false);
  });

  it("未知键拒绝（strictObject：拼写错误 fail fast，不静默丢弃声明）", () => {
    expect(
      teachingPackSchema.safeParse({ name: "x", directive: ["steps"] }).success,
    ).toBe(false);
    expect(
      teachingPackSchema.safeParse({ name: "x", validator: ["fill"] }).success,
    ).toBe(false);
  });
});

describe("frontmatter 接入 teachingPack（T7.8）", () => {
  it("frontmatter.teachingPack 解析并保留（缺省值生效）", () => {
    const parsed = frontmatterSchema.parse({
      kind: "practice",
      unit: "有理数",
      teachingPack: { name: "有理数填空练习", directives: ["blank"] },
    });
    expect(parsed.teachingPack).toEqual({
      formatVersion: 1,
      name: "有理数填空练习",
      version: "1",
      directives: ["blank"],
      validators: [],
    });
  });

  it("普通 MD 不受影响：无 teachingPack 时字段缺省（undefined）", () => {
    const parsed = frontmatterSchema.parse({ kind: "lecture" });
    expect(parsed.teachingPack).toBeUndefined();
    expect(parsed.kind).toBe("lecture");
  });

  it("teachingPack 内部结构非法时整体拒绝（调用方转 INVALID_FRONTMATTER）", () => {
    expect(
      frontmatterSchema.safeParse({
        kind: "practice",
        teachingPack: { version: "1" },
      }).success,
    ).toBe(false);
    expect(
      frontmatterSchema.safeParse({
        kind: "practice",
        teachingPack: "有理数练习",
      }).success,
    ).toBe(false);
  });

  it("frontmatter 其他未知顶层键仍被剥离（z.object 既有口径不变）", () => {
    const parsed = frontmatterSchema.parse({
      kind: "practice",
      unknownTop: 1,
    });
    expect(parsed).toEqual({ kind: "practice", dsl: 2 });
  });
});
