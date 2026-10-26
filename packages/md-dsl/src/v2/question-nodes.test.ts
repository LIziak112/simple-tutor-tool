import {
  QUESTION_NODES_VERSION,
  type QuestionNode,
  questionNodeSchema,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { studentStemMd } from "./public-stem.ts";
import { questionNodesOf } from "./question-nodes.ts";

/**
 * 题面语义节点枚举自测（LR-4，学习记录模型设计稿 §5.1）：
 * - 预序枚举块级节点，键按「同类节点 0 起序号」稳定生成；
 * - 教师原文与学生公开投影**同一键序列**（stripOptionListMd 幂等 + [[…]] 只动
 *   行内文本不改块结构）——锚点跨角色可互认的前提，设计稿点名的单测锁定；
 * - 选项节点按序号键 options/option/<n>，label 按字母序；
 * - 输出逐节点过契约 questionNodeSchema（单一事实来源，AGENTS 第 1 条）。
 */

const TEACHER_STEM = [
  "先化简再计算：",
  "",
  "$$\frac{1}{2} + \frac{1}{3}$$",
  "",
  "- [ ] A. 5/6",
  "- [x] B. 2/5",
  "",
  "把过程写在下方。",
].join("\n");

const OPTIONS = ["5/6", "2/5"];

describe("questionNodesOf（LR-4 题面语义节点枚举）", () => {
  it("版本常量来自契约单源", () => {
    expect(QUESTION_NODES_VERSION).toBe(1);
  });

  it("纯段落题面：root + stem/p/0", () => {
    const nodes = questionNodesOf({ stemMd: "计算 1+1。" });
    expect(nodes.map((node) => node.key)).toEqual(["root", "stem/p/0"]);
    expect(nodes[0]?.kind).toBe("root");
    expect(nodes[1]?.kind).toBe("paragraph");
    expect(nodes[1]?.text).toBe("计算 1+1。");
  });

  it("块级类型映射：heading / math-block / table / code / list-item / other", () => {
    const stem = [
      "# 一、复习",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```js",
      "let x = 1;",
      "```",
      "",
      "- 普通列表项",
      "",
      "> 引用块",
    ].join("\n");
    const nodes = questionNodesOf({ stemMd: stem });
    expect(nodes.map((node) => node.kind)).toEqual([
      "root",
      "heading",
      "table",
      "code",
      "list-item",
      "other",
    ]);
    expect(nodes.map((node) => node.key)).toEqual([
      "root",
      "stem/heading/0",
      "stem/table/0",
      "stem/code/0",
      "stem/list-item/0",
      "stem/other/0",
    ]);
  });

  it("同类节点按预序 0 起编号（stem/p/0、stem/p/1）", () => {
    const stem = ["第一段。", "", "第二段。", "", "第三段。"].join("\n");
    const nodes = questionNodesOf({ stemMd: stem });
    expect(nodes.map((node) => node.key)).toEqual([
      "root",
      "stem/p/0",
      "stem/p/1",
      "stem/p/2",
    ]);
  });

  it("选项节点：options/option/<n>，label 按字母序", () => {
    const nodes = questionNodesOf({
      stemMd: "选择正确答案。",
      options: OPTIONS,
    });
    const optionNodes = nodes.filter((node) => node.kind === "option");
    expect(optionNodes.map((node) => node.key)).toEqual([
      "options/option/0",
      "options/option/1",
    ]);
    expect(optionNodes.map((node) => node.label)).toEqual(["A", "B"]);
    expect(optionNodes.map((node) => node.text)).toEqual(OPTIONS);
  });

  it("教师原文与学生公开投影枚举出同一键序列（锚点跨角色互认前提）", () => {
    const teacherNodes = questionNodesOf({
      stemMd: TEACHER_STEM,
      options: OPTIONS,
    });
    const studentStem = studentStemMd({
      stemMd: TEACHER_STEM,
      options: OPTIONS,
    });
    const studentNodes = questionNodesOf({
      stemMd: studentStem,
      options: OPTIONS,
    });
    expect(teacherNodes.map((node) => node.key)).toEqual(
      studentNodes.map((node) => node.key),
    );
    // 学生投影确实剥掉了选项任务列表：教师侧的块结构与学生侧一致
    expect(teacherNodes.map((node) => node.kind)).not.toContain("list-item");
  });

  it("含 [[答案]] 标记的题面：脱敏只动行内文本，键序列不变", () => {
    const teacher = "填空：$[[1,2]]$ 与 [[3]]。";
    const teacherNodes = questionNodesOf({ stemMd: teacher });
    const studentNodes = questionNodesOf({
      stemMd: studentStemMd({ stemMd: teacher }),
    });
    expect(teacherNodes.map((node) => node.key)).toEqual(
      studentNodes.map((node) => node.key),
    );
    expect(teacherNodes).toHaveLength(2);
  });

  it("nodes[].text 恒为公开投影：教师原文含 [[参考答案]] 时 text 不带答案原文", () => {
    const teacher =
      "填空题：一元二次方程 $x^2=4$ 的解是 [[2,-2]]，判断 $\\sqrt{2}$ 是否有理。";
    const nodes = questionNodesOf({ stemMd: teacher });
    const nonEmptyMarker = /\[\[[^[\]]+\]\]/;
    for (const node of nodes) {
      if (node.text === undefined) continue;
      expect(nonEmptyMarker.test(node.text)).toBe(false);
      expect(node.text.includes("2,-2")).toBe(false);
    }
    // 键序列与「先手工脱敏再枚举」完全一致（studentStemMd 幂等）
    const manual = studentStemMd({ stemMd: teacher });
    expect(nodes.map((node) => node.key)).toEqual(
      questionNodesOf({ stemMd: manual }).map((node) => node.key),
    );
  });

  it("确定性：同输入两次枚举结果逐字段一致", () => {
    const first = questionNodesOf({ stemMd: TEACHER_STEM, options: OPTIONS });
    const second = questionNodesOf({ stemMd: TEACHER_STEM, options: OPTIONS });
    expect(first).toEqual(second);
  });

  it("输出逐节点过契约 questionNodeSchema；text 截断不超上限", () => {
    const nodes: QuestionNode[] = questionNodesOf({
      stemMd: TEACHER_STEM,
      options: OPTIONS,
    });
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(questionNodeSchema.safeParse(node).success).toBe(true);
    }
    const long = "很".repeat(500);
    const longNodes = questionNodesOf({ stemMd: long });
    expect((longNodes[1]?.text ?? "").length).toBeLessThanOrEqual(200);
  });
});
