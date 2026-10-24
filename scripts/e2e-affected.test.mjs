// e2e-affected 决策函数单测：选测语义的回归网（纯函数，不碰 git/playwright）
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALL_TAGS,
  decideE2e,
  FEATURE_DIR_TAGS,
  ROUTE_TAGS,
  SMOKE_SPECS,
  SPEC_TAGS,
} from "./e2e-affected.mjs";

describe("decideE2e 选测决策", () => {
  it("无任何命中 → 只跑冒烟", () => {
    expect(decideE2e([])).toEqual({
      mode: "grep",
      tags: ["@smoke"],
      reason: "无应用源码命中，仅冒烟",
    });
    expect(decideE2e(["docs/架构.md", "README.md"])).toEqual({
      mode: "grep",
      tags: ["@smoke"],
      reason: "无应用源码命中，仅冒烟",
    });
  });

  it("功能面源码 → @smoke + 对应标签（深层路径按首目录归属）", () => {
    expect(decideE2e(["apps/web/src/features/annotation/Overlay.tsx"])).toEqual(
      {
        mode: "grep",
        tags: ["@smoke", "@annotation"],
        reason: "命中 apps/web/src/features/annotation/Overlay.tsx",
      },
    );
    expect(decideE2e(["apps/server/src/routes/student-ai.ts"])).toEqual({
      mode: "grep",
      tags: ["@smoke", "@ai"],
      reason: "命中 apps/server/src/routes/student-ai.ts",
    });
  });

  it("多面命中取并集且 @smoke 恒居首", () => {
    const decision = decideE2e([
      "apps/web/src/features/admin/ui.tsx",
      "apps/server/src/routes/student-annotations.ts",
    ]);
    expect(decision.mode).toBe("grep");
    expect(decision.tags[0]).toBe("@smoke");
    expect(new Set(decision.tags)).toEqual(
      new Set(["@smoke", "@admin", "@annotation"]),
    );
  });

  it("routes 单测文件视同同名实现文件", () => {
    expect(
      decideE2e(["apps/server/src/routes/teacher-analytics.test.ts"]),
    ).toEqual({
      mode: "grep",
      tags: ["@smoke", "@insights"],
      reason: "命中 apps/server/src/routes/teacher-analytics.test.ts",
    });
  });

  it("仅 spec 变动 → 直跑变动 spec ∪ 冒烟 spec（文件参数，恒含冒烟）", () => {
    const decision = decideE2e(["e2e/mcp-smoke.spec.ts"]);
    expect(decision.mode).toBe("specs");
    expect(decision.specs).toEqual([
      "e2e/full-chain.spec.ts",
      "e2e/student-course-practice.spec.ts",
      "e2e/password-login.spec.ts",
      "e2e/mcp-smoke.spec.ts",
    ]);
    // 冒烟 spec 自身变动时不重复列出
    const smokeOnly = decideE2e(["e2e/full-chain.spec.ts"]);
    expect(smokeOnly.mode).toBe("specs");
    expect(smokeOnly.specs).toEqual([...SMOKE_SPECS]);
  });

  it("spec 与功能面源码同时变动 → 标签并集（grep 档）", () => {
    const decision = decideE2e([
      "e2e/mcp-smoke.spec.ts",
      "apps/web/src/features/annotation/Overlay.tsx",
    ]);
    expect(decision.mode).toBe("grep");
    expect(new Set(decision.tags)).toEqual(
      new Set(["@smoke", "@mcp", "@annotation"]),
    );
  });

  it("兜底清单 → 全量", () => {
    for (const path of [
      "packages/contract/src/contract.ts",
      "packages/md-dsl/src/directives.ts",
      "apps/server/src/db/schema.ts",
      "apps/server/src/db/migrations/0001.sql",
      "apps/server/src/app.ts",
      "e2e/helpers.ts",
      "e2e/global-setup.ts",
      "e2e/fake-ai-provider.ts",
      "e2e/fixtures/ai-review-samples.md",
      "e2e/navigation-ring.ts",
      "e2e/review-resource-probe.ts",
      "playwright.config.ts",
      "scripts/affected-lib.mjs",
      "pnpm-lock.yaml",
    ]) {
      expect(decideE2e([path]), path).toEqual({
        mode: "full",
        reason: expect.stringContaining(path),
      });
    }
  });

  it("e2e/ 目录 default-deny：未登记路径（含嵌套、非 ts、新 spec）一律全量", () => {
    for (const path of [
      "e2e/brand-new.spec.ts",
      "e2e/package.json",
      "e2e/page-objects/login.ts",
      "e2e/tsconfig.json",
    ]) {
      expect(decideE2e([path]).mode, path).toBe("full");
    }
  });

  it("映射表外的应用源码（跨功能面共享）→ 全量", () => {
    for (const path of [
      "apps/web/src/features/markdown/render.tsx",
      "apps/web/src/features/shared/ui.tsx",
      "apps/web/src/lib/api.ts",
      "apps/web/src/pages/Home.tsx",
      "apps/web/vite.config.ts",
      "apps/server/src/services/grading.ts",
      "apps/server/src/routes/public.ts",
      "apps/server/src/routes/auth.test.ts",
      "apps/web/public/icon.png",
    ]) {
      expect(decideE2e([path]).mode, path).toBe("full");
    }
  });

  it("兜底与功能面同时命中时兜底优先", () => {
    const decision = decideE2e([
      "apps/web/src/features/annotation/x.tsx",
      "packages/contract/src/y.ts",
    ]);
    expect(decision.mode).toBe("full");
  });
});

describe("标签登记完整性", () => {
  it("SPEC_TAGS 每个标签都在 ALL_TAGS 里且非空", () => {
    for (const [spec, tags] of Object.entries(SPEC_TAGS)) {
      expect(tags.length, spec).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(ALL_TAGS, `${spec} 的 ${tag}`).toContain(tag);
      }
    }
  });

  it("e2e 目录下每个 spec 文件都已登记（防新 spec 漏标签）", () => {
    const specs = readdirSync(new URL("../e2e", import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
      .map((entry) => entry.name);
    expect(specs.length).toBeGreaterThan(50);
    for (const spec of specs) {
      expect(SPEC_TAGS[spec], spec).toBeDefined();
    }
  });

  it("spec 文件内的 tag 声明与 SPEC_TAGS 登记一致（grep 档的正确性根基）", () => {
    const specs = readdirSync(new URL("../e2e", import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
      .map((entry) => entry.name);
    for (const spec of specs) {
      const source = readFileSync(
        new URL(`../e2e/${spec}`, import.meta.url),
        "utf8",
      );
      const declared = new Set();
      for (const match of source.matchAll(/tag: \[([^\]]*)\]/g)) {
        for (const item of match[1].split(",")) {
          const tag = item.trim().replaceAll('"', "").replaceAll("'", "");
          if (tag) {
            declared.add(tag);
          }
        }
      }
      expect([...declared].sort(), spec).toEqual([...SPEC_TAGS[spec]].sort());
    }
  });

  it("每个顶层 test/describe 调用都带 tag（防已登记 spec 里新增用例漏标）", () => {
    const specs = readdirSync(new URL("../e2e", import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
      .map((entry) => entry.name);
    for (const spec of specs) {
      const lines = readFileSync(
        new URL(`../e2e/${spec}`, import.meta.url),
        "utf8",
      ).split("\n");
      for (let i = 0; i < lines.length; i++) {
        // 顶层调用（缩进 0，首参为标题字符串；test.skip(condition, …) 形态不匹配）
        if (!/^test(\.\w+)*\s*\(\s*["'`]/.test(lines[i])) {
          continue;
        }
        // biome 可能把 tag 参数拆到后续行，看 4 行窗口
        const window = lines.slice(i, i + 4).join("\n");
        expect(window.includes("tag:"), `${spec}:${i + 1} 顶层调用缺 tag`).toBe(
          true,
        );
      }
    }
  });

  it("FEATURE_DIR_TAGS 与 ROUTE_TAGS 的每个值非空且都在 ALL_TAGS 里（空数组会让命中静默落成仅冒烟）", () => {
    for (const [table, name] of [
      [FEATURE_DIR_TAGS, "FEATURE_DIR_TAGS"],
      [ROUTE_TAGS, "ROUTE_TAGS"],
    ]) {
      for (const [key, tags] of Object.entries(table)) {
        expect(tags.length, `${name}[${key}]`).toBeGreaterThan(0);
        for (const tag of tags) {
          expect(ALL_TAGS, `${name}[${key}] 的 ${tag}`).toContain(tag);
        }
      }
    }
  });

  it("SMOKE_SPECS 与 @smoke 登记一致（恒含冒烟的数据源）", () => {
    expect(SMOKE_SPECS).toEqual([
      "e2e/full-chain.spec.ts",
      "e2e/student-course-practice.spec.ts",
      "e2e/password-login.spec.ts",
    ]);
  });
});
