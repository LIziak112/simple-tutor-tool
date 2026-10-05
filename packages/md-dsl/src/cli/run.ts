import { readFileSync } from "node:fs";
import { relative } from "node:path";
import process from "node:process";
import { lintDocument } from "../lint/lint.ts";
import { collectMarkdownFiles } from "./files.ts";
import { exitCodeFor, type FileLintResult, renderReport } from "./report.ts";

/**
 * tutor-lint CLI 主流程（T1.7）：收集 *.md → 逐文件 lintDocument →
 * renderReport 输出 → 退出码 0/1/2。
 *
 * 入口有两个，共用本模块（行为永远一致，仅用法文案不同）：
 * - 仓库 CLI：scripts/tutor-lint.ts（`pnpm tutor-lint …`）；
 * - dsl-kit 独立脚本：scripts/tutor-lint-standalone.ts 经 esbuild 打包为
 *   dsl-kit/tutor-lint.mjs（单文件零依赖，详见 scripts/bundle-standalone.ts）。
 *
 * 退出码：0 无 error；1 存在 error；2 用法错误 / 路径不存在 / 文件不可读。
 */

/** 展示路径：cwd 内用相对路径，分隔符统一为 /（Windows 与 CI 输出一致） */
function displayPathOf(absolute: string): string {
  const rel = relative(process.cwd(), absolute);
  return (rel === "" || rel.startsWith("..") ? absolute : rel).replaceAll(
    "\\",
    "/",
  );
}

export function runTutorLint(argv: readonly string[], usage: string): never {
  if (argv.length === 0) {
    console.error(usage);
    process.exit(2);
  }

  const { files, missing } = collectMarkdownFiles([...argv]);
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
}
