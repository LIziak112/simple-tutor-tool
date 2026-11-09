#!/usr/bin/env node
// 启用仓库内 git 钩子：把 core.hooksPath 指向 .githooks（pre-commit 文件规模闸门，AGENTS.md §五）。
// 由根 package.json 的 prepare 在 pnpm install 时自动执行；也可手动 pnpm hooks:install。
// 不是 git 检出（Docker 构建上下文已剔除 .git、源码压缩包）、找不到 git 可执行文件、
// 或开发者已自行设置了别的 hooksPath 时：打印一行说明后退出 0，不影响安装、不覆盖个人配置。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = ".githooks";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const say = (msg) => console.log(`setup-git-hooks：${msg}`);

// 主检出的 .git 是目录，linked worktree 的 .git 是文件，两者都算 git 检出
if (!existsSync(join(root, ".git"))) {
  say("不是 git 检出，跳过");
  process.exit(0);
}
const git = (...args) =>
  spawnSync("git", args, { cwd: root, encoding: "utf8" });
if (git("--version").error) {
  say("找不到 git，跳过");
  process.exit(0);
}
const current = git("config", "--get", "core.hooksPath");
const value = current.status === 0 ? current.stdout.trim() : "";
if (value === HOOKS_DIR) process.exit(0);
if (value) {
  say(
    `core.hooksPath 已是 ${value}，不覆盖；要启用仓库钩子请手动执行 git config core.hooksPath ${HOOKS_DIR}`,
  );
  process.exit(0);
}
const set = git("config", "core.hooksPath", HOOKS_DIR);
if (set.status !== 0) {
  say(`设置失败（${(set.stderr ?? "").trim()}），跳过`);
  process.exit(0);
}
say(`已把 core.hooksPath 指向 ${HOOKS_DIR}（pre-commit 文件规模闸门生效）`);
