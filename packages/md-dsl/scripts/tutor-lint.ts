/**
 * tutor-lint CLI 入口（T1.7）：`pnpm tutor-lint <文件或目录>…`。
 * 依据：docs/技术架构与实施方案.md §5.1（同一个 linter 以 CLI 形式提供）、
 * docs/开发任务清单.md T1.7（彩色输出 issues，有 error 时退出码 1）。
 *
 * - Node 24 原生类型剥离直接运行（相对导入带 .ts 扩展名，零额外依赖）；
 * - 支持一次传多个文件与目录，目录递归检查 *.md（跳过 node_modules/隐藏目录）；
 * - 彩色用原生 ANSI 转义码，仅 stdout 为 TTY 且未设 NO_COLOR 时开启（CI 日志干净）；
 * - 退出码：0 无 error；1 存在 error；2 用法错误 / 路径不存在 / 文件不可读。
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import process from "node:process";
import { collectMarkdownFiles } from "../src/cli/files.ts";
import {
  exitCodeFor,
  type FileLintResult,
  renderReport,
} from "../src/cli/report.ts";
import { lintDocument } from "../src/lint/lint.ts";

const USAGE = "用法：pnpm tutor-lint <文件或目录>…（目录递归检查 *.md）";

/** 展示路径：cwd 内用相对路径，分隔符统一为 /（Windows 与 CI 输出一致） */
function displayPathOf(absolute: string): string {
  const rel = relative(process.cwd(), absolute);
  return (rel === "" || rel.startsWith("..") ? absolute : rel).replaceAll(
    "\\",
    "/",
  );
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

const { files, missing } = collectMarkdownFiles(args);
if (missing.length > 0) {
  for (const path of missing) {
    console.error(`路径不存在：${path}`);
  }
  process.exit(2);
}

const results: FileLintResult[] = [];
for (const file of files) {
  let md: string;
  try {
    md = readFileSync(file, "utf8");
  } catch (err) {
    console.error(
      `无法读取文件 ${file}：${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  results.push({
    displayPath: displayPathOf(file),
    issues: lintDocument(md).issues,
  });
}

console.log(
  renderReport(
    results,
    process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
  ),
);
process.exit(exitCodeFor(results));
