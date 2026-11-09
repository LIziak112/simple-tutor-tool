#!/usr/bin/env node
// 文件规模闸门（AGENTS.md §五「文件规模与拆分」）命令行入口。策略在 file-size-policy.mjs，
// 钩子适配在 file-size-hooks.mjs；本文件只做 git 取数、模式分发与输出。
//   node scripts/file-size-guard.mjs check --staged          pre-commit：只看暂存区内容，软硬都报
//   node scripts/file-size-guard.mjs check --base <ref>      CI：全仓硬线 + 基线棘轮，软线只报相对 ref 的改动文件
//   node scripts/file-size-guard.mjs check [--all]           本地全仓：硬线 + 基线，软线只汇总数量
//   node scripts/file-size-guard.mjs check <路径…>           只看这些文件，软硬都报
//   node scripts/file-size-guard.mjs baseline [--write]      按当前仓库重算历史基线（新增 / 调高须在 PR 说明理由）
//   node scripts/file-size-guard.mjs hook <cursor|claude|codex>   编辑钩子入口：stdin 读钩子 JSON
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleHook } from "./file-size-hooks.mjs";
import {
  BASELINE_FILE,
  countLines,
  DOC_PATH,
  HARD_LIMIT,
  isChecked,
  loadBaseline,
  runCheck,
  SOFT_LIMIT,
  toRepoPath,
} from "./file-size-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLAVORS = ["cursor", "claude", "codex"];

function usage(code) {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  console.error(
    text
      .split("\n")
      .filter((l) => l.startsWith("//   node "))
      .join("\n"),
  );
  process.exit(code);
}

// git 输出恒带 core.quotepath=false 且以 NUL 分隔：仓库里有中文路径，默认的八进制转义会让路径失配
function git(args) {
  const r = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`git ${args.join(" ")} 失败：${(r.stderr ?? "").trim()}`);
    process.exit(1);
  }
  return r.stdout;
}
const gitList = (args) =>
  git([...args, "-z"])
    .split("\0")
    .filter(Boolean);
const trackedFiles = () => gitList(["ls-files"]);

const readWorkTree = (rel) => {
  const abs = join(root, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
};
const readIndex = (rel) => {
  const r = spawnSync("git", ["show", `:${rel}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
};

function loadBaselineOrExit() {
  try {
    return loadBaseline(root);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}

function cmdCheck(args) {
  const baseline = loadBaselineOrExit();
  let files;
  let focus = null;
  let read = readWorkTree;
  let sweep = false;
  if (args[0] === "--staged") {
    files = gitList(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
    read = readIndex;
  } else if (args[0] === "--base") {
    if (!args[1]) usage(2);
    files = trackedFiles();
    sweep = true;
    focus = new Set(
      gitList(["diff", "--name-only", "--diff-filter=ACMR", args[1]]),
    );
  } else if (args.length === 0 || args[0] === "--all") {
    files = trackedFiles();
    sweep = true;
    focus = new Set();
  } else {
    files = args.map((p) => toRepoPath(root, p, process.cwd())).filter(Boolean);
  }
  const { errors, warnings, stats } = runCheck({
    files,
    focus,
    baseline,
    readContent: read,
    sweep,
  });
  const gh = Boolean(process.env.GITHUB_ACTIONS);
  for (const w of warnings) {
    console.warn(`⚠️ ${w.message}`);
    if (gh)
      console.log(
        `::warning file=${w.rel},line=1,title=文件规模软线::${w.message}`,
      );
  }
  for (const e of errors) {
    console.error(`❌ ${e.message}`);
    if (gh)
      console.log(
        `::error file=${e.rel},line=1,title=文件规模硬线::${e.message}`,
      );
  }
  if (errors.length + warnings.length > 0)
    console.log(`细则：AGENTS.md §五 / ${DOC_PATH}`);
  const head =
    errors.length > 0 ? "❌ 文件规模闸门未通过" : "✅ 文件规模闸门通过";
  console.log(
    `${head}（受检 ${stats.checked} 个代码文件；软线 ${SOFT_LIMIT} 行以上 ${stats.overSoft} 个；硬线 ${HARD_LIMIT} 行；历史基线 ${Object.keys(baseline).length} 条）`,
  );
  process.exit(errors.length > 0 ? 1 : 0);
}

function cmdBaseline(args) {
  const current = loadBaselineOrExit();
  const next = {};
  for (const rel of trackedFiles()) {
    const text = readWorkTree(rel);
    if (text === null || !isChecked(rel, text)) continue;
    const lines = countLines(text);
    if (lines > HARD_LIMIT) next[rel] = lines;
  }
  const sorted = Object.fromEntries(
    Object.keys(next)
      .sort()
      .map((k) => [k, next[k]]),
  );
  const changes = { 新增: [], 调高: [], 调低: [], 移除: [] };
  for (const [rel, lines] of Object.entries(sorted)) {
    if (!(rel in current)) changes.新增.push(`${rel} ${lines}`);
    else if (lines > current[rel])
      changes.调高.push(`${rel} ${current[rel]} → ${lines}`);
    else if (lines < current[rel])
      changes.调低.push(`${rel} ${current[rel]} → ${lines}`);
  }
  for (const rel of Object.keys(current))
    if (!(rel in sorted)) changes.移除.push(rel);
  for (const [kind, list] of Object.entries(changes))
    for (const item of list) console.log(`${kind}：${item}`);
  if (changes.新增.length + changes.调高.length > 0)
    console.warn(
      "⚠️ 基线只降不升：新增 / 调高的条目必须在 PR 写明理由，评审确认后才可合入",
    );
  if (args.includes("--write")) {
    writeFileSync(
      join(root, BASELINE_FILE),
      `${JSON.stringify(sorted, null, 2)}\n`,
    );
    console.log(`已写入 ${BASELINE_FILE}（${Object.keys(sorted).length} 条）`);
  } else {
    console.log(JSON.stringify(sorted, null, 2));
  }
}

function cmdHook(flavor) {
  if (!FLAVORS.includes(flavor)) usage(2);
  const allow = flavor === "cursor" ? { permission: "allow" } : null;
  let out = allow;
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    out = handleHook(flavor, input, { root, baseline: loadBaseline(root) });
  } catch (e) {
    // 钩子自身出错一律放行：硬闸门在 pre-commit / CI
    console.error(`file-size-guard hook：${e.message}（已放行）`);
    out = allow;
  }
  if (out !== null) process.stdout.write(JSON.stringify(out));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "check") cmdCheck(rest);
else if (cmd === "baseline") cmdBaseline(rest);
else if (cmd === "hook") cmdHook(rest[0]);
else usage(cmd === undefined || cmd === "--help" || cmd === "-h" ? 0 : 2);
