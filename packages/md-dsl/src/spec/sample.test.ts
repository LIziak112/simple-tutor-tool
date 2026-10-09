import { describe, expect, it } from "vitest";
import {
  directiveNamesOf,
  fullSampleBlocks,
  fullSampleDocText,
  missingDirectives,
} from "../../../../test-support/dsl-samples.ts";
import { lintDocument } from "../lint/lint.ts";

/**
 * docs/dsl/完整样例.md 质量门（T1.7）：手写文档，三个 ```markdown 代码块
 * 分别是三种 kind 的完整文档，必须全部 lintDocument 0 issue——
 * 既是给老师的可信样例，也是复制给 AI 的 few-shot，任何退化都在这里被拦下。
 * T7.9 起：代码块从文档 AST（lang=markdown 的 code 节点）提取；指令覆盖从
 * 子串抽查升级为 AST 精确主名集合 == listDirectives 主名集合（说明文字、
 * 行内代码与代码块里的指令字样不再能伪造覆盖）。
 */

const doc = fullSampleDocText();
const blocks = fullSampleBlocks(doc);
const blockMarkdowns = blocks.map((block) => block.markdown);
/** 每块只跑一轮 lintDocument，kind 与 issue 两类断言共用 */
const blockLints = blockMarkdowns.map((markdown) => lintDocument(markdown));

/** 多文档主名并集（正向覆盖与反向 fixture 共用同一收集口径） */
function coveredUnionOf(
  markdowns: readonly string[],
  options?: Parameters<typeof directiveNamesOf>[1],
): Set<string> {
  const covered = new Set<string>();
  for (const markdown of markdowns) {
    for (const name of directiveNamesOf(markdown, options)) covered.add(name);
  }
  return covered;
}

describe("docs/dsl/完整样例.md", () => {
  it("文档结构与三节标题齐全", () => {
    expect(doc).toContain("## 一、练习（kind: practice）");
    expect(doc).toContain("## 二、讲义（kind: lecture）");
    expect(doc).toContain("## 三、混合（kind: mixed）");
  });

  it("AST 恰有三个 markdown 样例代码块，kind 依次为 practice / lecture / mixed", () => {
    expect(blocks).toHaveLength(3);
    const kinds = blockLints.map((lint) => lint.parsed.frontmatter?.kind);
    expect(kinds).toEqual(["practice", "lecture", "mixed"]);
  });

  it("每个样例块 lint 0 issue（验收：完整样例可用作 few-shot）", () => {
    for (const [index, lint] of blockLints.entries()) {
      expect(
        lint.issues,
        `第 ${index + 1} 个样例块应 0 issue，实际：${lint.issues
          .map((i) => `${i.code}@${i.line}`)
          .join("、")}`,
      ).toEqual([]);
    }
  });

  it("七种题型在样例题目的 type 属性中全部出现", () => {
    const all = blockMarkdowns.join("\n");
    for (const keyword of [
      "type=judge",
      "type=choice",
      "type=multi",
      "type=fill",
      "type=solve",
      "type=apply",
      "type=find-error",
    ]) {
      expect(all, `完整样例应包含 ${keyword}`).toContain(keyword);
    }
  });

  it("AST 精确指令覆盖：三个样例块的主名并集 == 注册表主名集合（不写死数量）", () => {
    expect(
      missingDirectives(coveredUnionOf(blockMarkdowns)),
      "完整样例指令覆盖缺口（新注册指令需同步补样例）",
    ).toEqual([]);
  });
});

describe("指令覆盖断言的反向 fixture（防子串伪造，T7.9）", () => {
  /**
   * 伪造载体三连：说明文字行内代码、围栏代码块、以及"只有 steps/col 容器
   * 本体但缺 step/columns"的正文。子串口径会把它们计入覆盖；AST 口径不会。
   */
  const SUBSTRING_TRAP = [
    "说明文字提到 `:::step`、`:::columns` 与 `::graph` 字样，但它们只是行内代码。",
    "",
    "```text",
    "代码块里也有 :::step、:::columns、::graph 与 [[0.5|1/2]]，都不是真实指令。",
    "```",
    "",
    "::::steps",
    "只有 steps 容器本身，正文里没有任何 step 子节点。",
    "::::",
    "",
    "::::columns",
    ":::col",
    "只有 columns 与 col 容器本体。",
    ":::",
    "::::",
    "",
  ].join("\n");

  it("行内代码、代码块与说明文字里的指令字样不计入覆盖；真实容器照常计入", () => {
    const names = directiveNamesOf(SUBSTRING_TRAP);
    expect(names.has("step")).toBe(false);
    expect(names.has("graph")).toBe(false);
    expect(names.has("blank")).toBe(false);
    // fixture 里真实存在的容器指令必须被计入（收集器不是一刀切丢弃）
    expect(names.has("steps")).toBe(true);
    expect(names.has("columns")).toBe(true);
    expect(names.has("col")).toBe(true);
  });

  it("同一覆盖断言在 fixture 上应报告 step/graph/blank 缺口（断言能失败）", () => {
    const missing = missingDirectives(directiveNamesOf(SUBSTRING_TRAP));
    expect(missing).toContain("step");
    expect(missing).toContain("graph");
    expect(missing).toContain("blank");
    expect(missing).not.toContain("steps");
    expect(missing).not.toContain("columns");
    expect(missing).not.toContain("col");
  });

  it("blank 语法糖 [[…]] 经现有转换计入指令覆盖（fixture 无 blank 字面量）", () => {
    const names = directiveNamesOf(
      "计算：$1+1=$ [[2]]，写成小数是 [[0.5|1/2]]。",
    );
    expect(names.has("blank")).toBe(true);
  });

  it("删除真实 step 节点但保留 steps 时，覆盖缺口恰为 step（子串口径会连 steps 一起丢）", () => {
    const covered = coveredUnionOf(blockMarkdowns, {
      dropDirectives: ["step"],
    });
    expect(covered.has("steps"), "steps 容器不受 step 删除影响").toBe(true);
    expect(missingDirectives(covered)).toEqual(["step"]);
  });
});
