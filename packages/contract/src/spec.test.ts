import { describe, expect, it } from "vitest";
import {
  specFileContentTypes,
  specFileNames,
  specFileNameSchema,
} from "./spec.ts";

/**
 * spec 文件契约测试（T1.13）：/api/public/spec/:file 的文件名枚举与
 * Content-Type 映射是前后端共用的唯一事实来源（AGENTS.md 契约优先）。
 */

describe("spec 文件名枚举与 Content-Type（T1.13）", () => {
  it("枚举恰好包含四个文件，与架构文档 §3 /spec 路由一致", () => {
    expect([...specFileNames]).toEqual([
      "rules.md",
      "example.md",
      "prompt.md",
      "schema.json",
    ]);
  });

  it("schema 只接受四个合法文件名，其余拒绝", () => {
    for (const name of specFileNames) {
      expect(specFileNameSchema.safeParse(name).success).toBe(true);
    }
    for (const bad of [
      "",
      "rules",
      "规范.md",
      "../规范.md",
      "schema.content.json",
      "rules.md/",
    ]) {
      expect(specFileNameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("每个文件名都有 Content-Type：md 为 text/markdown，json 为 application/json", () => {
    for (const name of specFileNames) {
      expect(typeof specFileContentTypes[name]).toBe("string");
      expect(specFileContentTypes[name].length).toBeGreaterThan(0);
    }
    expect(specFileContentTypes["rules.md"]).toBe("text/markdown; charset=utf-8");
    expect(specFileContentTypes["example.md"]).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(specFileContentTypes["prompt.md"]).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(specFileContentTypes["schema.json"]).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("映射覆盖全部枚举值（Record 完备性）", () => {
    expect(Object.keys(specFileContentTypes).sort()).toEqual(
      [...specFileNames].sort(),
    );
  });
});
