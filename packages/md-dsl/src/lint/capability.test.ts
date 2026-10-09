import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintDocument } from "./lint.ts";
import { LINT_RULES } from "./rules.ts";

/**
 * T7.7 能力启用集 lint 规则测试（方案 §4.5）：
 * - 无启用集上下文（缺省/CLI）不产生任何新 issue——既有样例零新增 warning；
 * - steps 关闭 → 每个 :::steps 容器一条 CAPABILITY_DISABLED（warning）；
 * - ink 关闭 → 每道手写题型（solve/apply/find-error）一条；
 * - choice/fill 等正式作答题型永不触发；正文仍可正常教学（warning 不阻断导入）。
 */

const LECTURE_STEPS_MD = `---
kind: lecture
title: 逐步揭晓示例
---

# 第1讲 示例

:::steps
:::step{title="第一步"}
先看条件。
:::
:::step{title="第二步"}
再代公式。
:::
:::

第二处独立容器：

:::steps
:::step{title="另一处"}
内容。
:::
:::
`;

const PRACTICE_MD = `---
kind: practice
unit: 手写与客观混合
---

::::question{type=solve difficulty=2}
计算 $1+1$。

:::answer
$2$
:::
::::

::::question{type=judge difficulty=1}
$1+1=2$。[[正确]]
::::
`;

describe("CAPABILITY_DISABLED（T7.7 辅助能力回退提示）", () => {
  it("无启用集上下文：不产生任何 CAPABILITY_DISABLED（CLI/缺省全启用）", () => {
    const lecture = lintDocument(LECTURE_STEPS_MD);
    expect(lecture.issues.filter((i) => i.code === "CAPABILITY_DISABLED")).toEqual([]);
    const practice = lintDocument(PRACTICE_MD);
    expect(
      practice.issues.filter((i) => i.code === "CAPABILITY_DISABLED"),
    ).toEqual([]);
  });

  it("空数组上下文（显式全关）：讲义两处 steps 各一条 warning，行号指向容器起始", () => {
    const result = lintDocument(LECTURE_STEPS_MD, {
      enabledCapabilities: [],
    });
    const hits = result.issues.filter((i) => i.code === "CAPABILITY_DISABLED");
    expect(hits).toHaveLength(2);
    for (const issue of hits) {
      expect(issue.level).toBe("warning");
      expect(issue.message).toContain("逐步揭晓");
      expect(issue.message).toContain("完整展开");
    }
    // 行号：两处 :::steps 容器的起始行（第 8 行与第 19 行）
    expect(hits.map((i) => i.line).sort((a, b) => a - b)).toEqual([8, 19]);
  });

  it("ink 关闭：每道手写题一条 warning（客观题不触发）；steps 启用不报", () => {
    const result = lintDocument(PRACTICE_MD, {
      enabledCapabilities: ["steps"],
    });
    const hits = result.issues.filter((i) => i.code === "CAPABILITY_DISABLED");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.level).toBe("warning");
    expect(hits[0]?.message).toContain("手写");
    expect(hits[0]?.message).toContain("最终答案");
    // 行号：solve 题容器起始行（第 6 行）
    expect(hits[0]?.line).toBe(6);
  });

  it("全启用上下文：两类文档都零触发", () => {
    const lecture = lintDocument(LECTURE_STEPS_MD, {
      enabledCapabilities: ["steps", "ink"],
    });
    expect(
      lecture.issues.filter((i) => i.code === "CAPABILITY_DISABLED"),
    ).toEqual([]);
    const practice = lintDocument(PRACTICE_MD, {
      enabledCapabilities: ["steps", "ink"],
    });
    expect(
      practice.issues.filter((i) => i.code === "CAPABILITY_DISABLED"),
    ).toEqual([]);
  });

  it("规则在 rules.ts 登记（gen:spec 文档数据源）", () => {
    const entry = LINT_RULES.find((rule) => rule.code === "CAPABILITY_DISABLED");
    expect(entry?.level).toBe("warning");
    expect(entry?.description).toContain("辅助能力");
  });

  it("既有样例在关闭上下文下也只增回退提示、不产生 error（正文仍可教学导入）", () => {
    const sampleDir = fileURLToPath(
      new URL("../../../../samples/v2/", import.meta.url),
    );
    const md = readFileSync(`${sampleDir}练习样例.md`, "utf8");
    const result = lintDocument(md, { enabledCapabilities: [] });
    const errors = result.issues.filter((i) => i.level === "error");
    expect(errors).toEqual([]);
    // 练习样例含三道手写题（solve/apply/find-error）
    expect(
      result.issues.filter((i) => i.code === "CAPABILITY_DISABLED").length,
    ).toBeGreaterThanOrEqual(3);
  });
});
