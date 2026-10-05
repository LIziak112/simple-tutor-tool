/**
 * tutor-lint CLI 入口（T1.7）：`pnpm tutor-lint <文件或目录>…`。
 * 依据：docs/技术架构与实施方案.md §5.1（同一个 linter 以 CLI 形式提供）、
 * docs/开发任务清单.md T1.7（彩色输出 issues，有 error 时退出码 1）。
 *
 * Node 24 原生类型剥离直接运行（相对导入带 .ts 扩展名，零额外依赖）；
 * 主流程在 src/cli/run.ts（与 dsl-kit 独立打包入口共用），本入口保持极薄，
 * scripts 路径稳定供 bin.test.ts 子进程冒烟测试使用。
 */
import process from "node:process";
import { runTutorLint } from "../src/cli/run.ts";

runTutorLint(
  process.argv.slice(2),
  "用法：pnpm tutor-lint <文件或目录>…（目录递归检查 *.md）",
);
