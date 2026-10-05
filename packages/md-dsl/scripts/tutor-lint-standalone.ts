/**
 * dsl-kit 独立校验脚本的打包入口：scripts/bundle-standalone.ts 用 esbuild 把
 * 本文件（连同 linter 全部依赖）打进仓库根 dsl-kit/tutor-lint.mjs 单文件——
 * 零外部依赖，任何装有 Node（≥20）的机器可直接 `node tutor-lint.mjs …` 运行。
 * 用户拿到 dsl-kit 文件夹即拥有与仓库同版本的校验器，供其 AI 工具复校使用。
 *
 * 主流程与仓库 CLI 共用 src/cli/run.ts（行为永远一致），仅用法文案不同。
 */
import process from "node:process";
import { runTutorLint } from "../src/cli/run.ts";

runTutorLint(
  process.argv.slice(2),
  "用法：node tutor-lint.mjs <文件或目录>…（目录递归检查 *.md）",
);
