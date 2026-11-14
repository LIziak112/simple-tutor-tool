// CI 复用本机选测规则；仅显式说明文档白名单可跳过应用验证。
import { appendFileSync } from "node:fs";
import {
  collectChangedFiles,
  existing,
  hitForceFull,
  runArgv,
  runIfMain,
} from "./affected-lib.mjs";
import { decideE2e } from "./e2e-affected.mjs";

function isDocumentation(path) {
  return (
    /^(AGENTS|CONTRIBUTING|README(?:\.en)?)\.md$/.test(path) ||
    /^docs\/(约定|审查报告|superpowers\/plans)\/.*\.md$/.test(path) ||
    /^docs\/(README|开发任务清单|技术架构与实施方案)\.md$/.test(path) ||
    /^\.(claude|codex)\/skills\/[^/]+\/SKILL\.md$/.test(path) ||
    /^\.agents\/skills\/(?:ownclass-code-review|requesting-code-review)\/(?:SKILL\.md|LICENSE)$/.test(
      path,
    ) ||
    path === ".agents/skills/ownclass-code-review/references/checklist.md" ||
    path === ".agents/skills/requesting-code-review/code-reviewer.md"
  );
}

export function planCi(files, forceFull = false) {
  const run = forceFull || files.some((path) => !isDocumentation(path));
  // 根配置和未知根路径无法由 import 图可靠追踪，保守全量。
  const full =
    forceFull ||
    Boolean(hitForceFull(files)) ||
    files.some(
      (path) => !isDocumentation(path) && !/^(apps|packages|e2e)\//.test(path),
    );
  return {
    run,
    full,
    e2e: full ? { mode: "full", reason: "CI 全量兜底" } : decideE2e(files),
  };
}

function main() {
  const [mode, ref] = process.argv.slice(2);
  if (!["plan", "unit", "e2e"].includes(mode) || !ref) {
    throw new Error("用法：node scripts/ci-scope.mjs plan|unit|e2e <基点 SHA>");
  }
  const plan = planCi(collectChangedFiles(ref), process.env.CI_FULL === "true");
  console.log(JSON.stringify(plan));
  if (mode === "plan") {
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `run=${plan.run}\n`);
    }
    return 0;
  }
  if (!plan.run) return 0;
  if (mode === "unit") {
    return runArgv(
      plan.full ? ["pnpm", "test"] : ["pnpm", "test", "--changed", ref],
    );
  }
  const base = [
    "pnpm",
    "exec",
    "playwright",
    "test",
    "--project=chromium",
    "--project=webkit",
  ];
  const decision = plan.e2e;
  if (decision.mode === "full") return runArgv(base);
  if (decision.mode === "grep")
    return runArgv([...base, "--grep", decision.tags.join("|")]);
  const specs = existing(decision.specs);
  if (specs.length === 0) throw new Error("E2E 选测清单为空，拒绝静默通过");
  return runArgv([...base, ...specs]);
}

runIfMain(import.meta.url, main);
