// e2e-affected 决策函数单测：选测语义的回归网（纯函数，不碰 git/playwright）
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_TAGS, decideE2e, SPEC_TAGS } from "./e2e-affected.mjs";

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

  it("spec 变动并入自身标签；未登记的 spec 兜底全量", () => {
    expect(decideE2e(["e2e/mcp-smoke.spec.ts"])).toEqual({
      mode: "grep",
      tags: ["@smoke", "@mcp"],
      reason: "命中 e2e/mcp-smoke.spec.ts",
    });
    expect(decideE2e(["e2e/brand-new.spec.ts"]).mode).toBe("full");
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
      "e2e/annotation-assertions.ts",
      "e2e/fixtures/ai-review-samples.md",
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
});
