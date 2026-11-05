import assert from "node:assert/strict";
import { test } from "node:test";
import { planCi } from "./ci-scope.mjs";

test("说明文档跳过应用验证，混合改动不跳过", () => {
  assert.equal(planCi(["AGENTS.md", "docs/约定/工程验证说明.md"]).run, false);
  assert.equal(
    planCi(["README.md", "apps/web/src/features/annotation/a.ts"]).run,
    true,
  );
  assert.equal(planCi([]).run, false);
});

test("文件系统夹具与未知路径不作为纯说明文档", () => {
  for (const path of [
    "docs/待处理的问题/练习六第8题修正题源.md",
    "docs/dsl/完整样例.md",
    ".claude/skills/lecture-practice/samples/a.md",
    "new-config.json",
  ]) {
    assert.equal(planCi([path]).run, true);
  }
});

test("普通功能改动按面选测并恒含冒烟", () => {
  const plan = planCi(["apps/web/src/features/annotation/a.ts"]);
  assert.equal(plan.full, false);
  assert.equal(plan.e2e.mode, "grep");
  assert.ok(plan.e2e.tags.includes("@annotation"));
  assert.ok(plan.e2e.tags.includes("@smoke"));
});

test("高风险基础文件与工作流变更全量兜底", () => {
  for (const path of [
    "packages/contract/src/a.ts",
    "scripts/x.mjs",
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-lock.yaml",
    "apps/server/src/db/migrations/deleted.sql",
  ]) {
    const plan = planCi([path]);
    assert.equal(plan.run, true);
    assert.equal(plan.full, true);
  }
});

test("定时、手动与 main 推送可强制完整回归", () => {
  assert.equal(planCi(["README.md"], true).full, true);
  assert.equal(planCi([], true).run, true);
});

test("未知应用路径保留 E2E 全量；仅 spec 选测保留冒烟", () => {
  assert.equal(planCi(["apps/web/src/lib/shared.ts"]).e2e.mode, "full");
  const plan = planCi(["e2e/password-login.spec.ts"]);
  assert.equal(plan.e2e.mode, "specs");
  assert.ok(plan.e2e.specs.includes("e2e/password-login.spec.ts"));
  assert.ok(plan.e2e.specs.length > 1);
});

test("技能说明跳过，运行脚本和生成内容不跳过", () => {
  assert.equal(planCi([".claude/skills/task-workflow/SKILL.md"]).run, false);
  assert.equal(
    planCi([".claude/skills/lecture-practice/scripts/run.cjs"]).full,
    true,
  );
  assert.equal(planCi(["dsl-kit/tutor-lint.mjs"]).full, true);
});
