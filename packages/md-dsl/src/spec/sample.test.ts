import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintDocument } from "../lint/lint.ts";

/**
 * docs/dsl/完整样例.md 质量门（T1.7）：手写文档，三个 ```markdown 代码块
 * 分别是三种 kind 的完整文档，必须全部 lintDocument 0 issue——
 * 既是给老师的可信样例，也是复制给 AI 的 few-shot，任何退化都在这里被拦下。
 */

const docPath = fileURLToPath(
  new URL("../../../../docs/dsl/完整样例.md", import.meta.url),
);
const doc = readFileSync(docPath, "utf8");

function markdownBlocks(text: string): string[] {
  return [...text.matchAll(/```markdown\r?\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("docs/dsl/完整样例.md", () => {
  it("文档结构与三节标题齐全", () => {
    expect(doc).toContain("## 一、练习（kind: practice）");
    expect(doc).toContain("## 二、讲义（kind: lecture）");
    expect(doc).toContain("## 三、混合（kind: mixed）");
  });

  it("恰有三个 ```markdown 代码块，kind 依次为 practice / lecture / mixed", () => {
    const blocks = markdownBlocks(doc);
    expect(blocks).toHaveLength(3);
    const kinds = blocks.map(
      (block) => lintDocument(block).parsed.frontmatter?.kind,
    );
    expect(kinds).toEqual(["practice", "lecture", "mixed"]);
  });

  it("每个代码块 lint 0 issue（验收：完整样例可用作 few-shot）", () => {
    for (const [index, block] of markdownBlocks(doc).entries()) {
      const { issues } = lintDocument(block);
      expect(
        issues,
        `第 ${index + 1} 个样例块应 0 issue，实际：${issues
          .map((i) => `${i.code}@${i.line}`)
          .join("、")}`,
      ).toEqual([]);
    }
  });

  it("覆盖面抽查：七种题型与主要指令都在样例中出现", () => {
    const all = markdownBlocks(doc).join("\n");
    for (const keyword of [
      "type=judge",
      "type=choice",
      "type=multi",
      "type=fill",
      "type=solve",
      "type=apply",
      "type=find-error",
      ":::hint",
      ":::answer",
      ":::solution",
      ":::example",
      ":::step",
      ":::fold",
      ":::tip",
      ":::warning",
      ":::box",
      ":::col",
      ":mark[",
      "::graph",
      "::image",
      "[[0.5|1/2]]",
    ]) {
      expect(all, `完整样例应包含 ${keyword}`).toContain(keyword);
    }
  });
});
