import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintDocument } from "./lint.ts";
import { LINT_RULES } from "./rules.ts";

/**
 * LINT_RULES 同步测试（T1.7）：清单是 gen:spec 渲染「lint 错误码」章节的唯一数据源，
 * 必须与实现中实际出现的 code 保持同步——扫描 v2/ 与 lint/ 的非测试源码，
 * 任何形如 UPPER_SNAKE 的字符串字面量（≥5 字符）都必须已被清单收录。
 */

const srcDirs = ["../v2", "."] as const;

function listSourceFiles(dir: string): string[] {
  const abs = fileURLToPath(new URL(dir, import.meta.url));
  return readdirSync(abs)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `${abs}/${name}`);
}

describe("LINT_RULES 同步", () => {
  it("源码中出现的全部 code 字面量都被清单收录", () => {
    const documented = new Set(LINT_RULES.map((rule) => rule.code));
    const found = new Set<string>();
    for (const dir of srcDirs) {
      for (const file of listSourceFiles(dir)) {
        for (const match of readFileSync(file, "utf8").matchAll(
          /"([A-Z][A-Z0-9_]{4,})"/g,
        )) {
          const code = match[1];
          if (code === undefined) continue;
          found.add(code);
        }
      }
    }
    const undocumented = [...found].filter((code) => !documented.has(code));
    expect(
      undocumented,
      `以下 code 出现在源码但未登记进 LINT_RULES：${undocumented.join("、")}`,
    ).toEqual([]);
  });

  it("清单自身合法：code 形态正确且无重复", () => {
    const seen = new Set<string>();
    for (const rule of LINT_RULES) {
      expect(rule.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(seen.has(rule.code), `重复登记：${rule.code}`).toBe(false);
      seen.add(rule.code);
      expect(rule.description.length).toBeGreaterThan(4);
    }
  });

  it("覆盖反例夹具中实际触发的全部 code（lint 输出 ⊆ 清单）", () => {
    const documented = new Set(LINT_RULES.map((rule) => rule.code));
    const lintDir = fileURLToPath(
      new URL("../../../../samples/lint/", import.meta.url),
    );
    const emitted = new Set<string>();
    for (const name of readdirSync(lintDir).filter((n) => n.endsWith(".md"))) {
      for (const issue of lintDocument(
        readFileSync(`${lintDir}${name}`, "utf8"),
      ).issues) {
        emitted.add(issue.code);
      }
    }
    expect(emitted.size).toBeGreaterThan(0);
    const undocumented = [...emitted].filter((code) => !documented.has(code));
    expect(
      undocumented,
      `夹具触发的 code 未登记进 LINT_RULES：${undocumented.join("、")}`,
    ).toEqual([]);
  });
});
