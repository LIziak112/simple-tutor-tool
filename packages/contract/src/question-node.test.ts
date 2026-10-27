import { describe, expect, it } from "vitest";
import {
  QUESTION_NODES_VERSION,
  questionNodeKeySchema,
  questionNodeKindSchema,
  questionNodeSchema,
} from "./question-node.ts";

/**
 * 题面语义节点契约自测（LR-4，学习记录模型设计稿 §5.1）：
 * 键格式三类（root / stem/<kind>/<n> / options/option/<n>）、kind 枚举、
 * 节点可选字段与版本常量。枚举函数本身在 @tutor/md-dsl（question-nodes.ts），
 * 其「教师原文与学生投影同键序列」断言见该包 question-nodes.test.ts。
 */
describe("question-node 契约（LR-4）", () => {
  it("QUESTION_NODES_VERSION 从 1 起", () => {
    expect(QUESTION_NODES_VERSION).toBe(1);
  });

  it("键格式：root / stem/<kind>/<n> / options/option/<n>", () => {
    expect(questionNodeKeySchema.safeParse("root").success).toBe(true);
    expect(questionNodeKeySchema.safeParse("stem/p/0").success).toBe(true);
    expect(questionNodeKeySchema.safeParse("stem/math-block/12").success).toBe(
      true,
    );
    expect(questionNodeKeySchema.safeParse("stem/list-item/3").success).toBe(
      true,
    );
    expect(questionNodeKeySchema.safeParse("options/option/2").success).toBe(
      true,
    );
    // 拒绝：大写 kind、负序号、空 kind、root 带后缀、未知前缀
    expect(questionNodeKeySchema.safeParse("stem/P/0").success).toBe(false);
    expect(questionNodeKeySchema.safeParse("stem/p/-1").success).toBe(false);
    expect(questionNodeKeySchema.safeParse("stem//0").success).toBe(false);
    expect(questionNodeKeySchema.safeParse("root/x").success).toBe(false);
    expect(questionNodeKeySchema.safeParse("hint/p/0").success).toBe(false);
  });

  it("节点形状：kind 枚举、order 必填、text/label 可选", () => {
    expect(
      questionNodeSchema.safeParse({
        key: "stem/p/0",
        kind: "paragraph",
        order: 1,
      }).success,
    ).toBe(true);
    expect(
      questionNodeSchema.safeParse({
        key: "options/option/0",
        kind: "option",
        order: 5,
        text: "2",
        label: "A",
      }).success,
    ).toBe(true);
    expect(
      questionNodeSchema.safeParse({
        key: "root",
        kind: "root",
        order: 0,
      }).success,
    ).toBe(true);
    // kind 必须在枚举内；order 非负整数
    expect(
      questionNodeSchema.safeParse({
        key: "stem/p/0",
        kind: "sentence",
        order: 0,
      }).success,
    ).toBe(false);
    expect(
      questionNodeSchema.safeParse({
        key: "stem/p/0",
        kind: "paragraph",
        order: -1,
      }).success,
    ).toBe(false);
  });

  it("kind 枚举覆盖设计稿词表", () => {
    for (const kind of [
      "root",
      "paragraph",
      "heading",
      "list-item",
      "option",
      "image",
      "math-block",
      "table",
      "code",
      "blank",
      "figure",
      "other",
    ] as const) {
      expect(questionNodeKindSchema.safeParse(kind).success).toBe(true);
    }
  });
});
