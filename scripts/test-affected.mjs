// 分层测试兜底（2026-10-25）：vitest --changed 按 import 模块图选测试，看不见
// 被 fs 读进来的输入（samples 样例、迁移 SQL、契约导出）与测试基建（vitest /
// tsconfig / biome / playwright 配置）。这些文件一变，受影响面无法静态推导，
// 直接全量；其余情况透传 vitest --changed <ref>。
//
// 用法：node scripts/test-affected.mjs <ref>
//   ref = HEAD        → 未提交改动（快档，pnpm test:quick）
//   ref = origin/main → 相对 main 的全部改动（受影响档，pnpm test:affected）
// 环境变量 TEST_AFFECTED_DRY_RUN=1 只打印决策不执行（自检/排查用）。
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 命中任一 → 全量。路径为仓库根相对路径（脚本约定在根目录执行）。
export const FORCE_FULL_PATTERNS = [
  // 依赖锁与测试/构建配置：影响所有测试的装载与转译方式
  /^pnpm-lock\.yaml$/,
  /(^|\/)vitest\.config\.[cm]?ts$/,
  /(^|\/)vitest\.workspace\.[cm]?ts$/,
  /^playwright\.config\.[cm]?ts$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^biome\.jsonc?$/,
  // 被 fs 读进来的输入：import 图追不到
  /^apps\/server\/src\/db\/migrations\//,
  /^apps\/server\/src\/db\/schema\.ts$/,
  /^packages\/contract\//,
  /^samples\//,
  /^test-support\//,
  // 测试基建入口
  /^apps\/web\/src\/test\/setup\.ts$/,
  /^e2e\/helpers\.ts$/,
  /^e2e\/global-setup\.ts$/,
  // 兜底脚本自身变动后，旧档位的结论不可信
  /^scripts\//,
];

export function gitLines(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`git ${args.join(" ")} 失败：${result.stderr.trim()}`);
    process.exit(1);
  }
  return result.stdout.split("\n").filter(Boolean);
}

// 变更清单 = diff（ref 到工作树，含已提交/已暂存/未暂存，不含未跟踪）+ 未跟踪新文件。
// 未跟踪必须并入：新增迁移或契约文件同样逃过 --changed 的视野。
export function collectChangedFiles(ref) {
  return [
    ...gitLines(["diff", "--name-only", ref]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ];
}

export function hitForceFull(changed) {
  return changed.find((path) =>
    FORCE_FULL_PATTERNS.some((pattern) => pattern.test(path)),
  );
}

// 经 shell 执行（Windows 上 pnpm 是 .cmd，必须走 shell）；含空白/特殊字符的参数加引号。
export function runArgv(argv) {
  const line = argv
    .map((arg) => (/[^\w@%+=:,./-]/.test(arg) ? `"${arg}"` : arg))
    .join(" ");
  const result = spawnSync(line, { stdio: "inherit", shell: true });
  return result.status ?? 1;
}

function main() {
  const ref = process.argv[2] ?? "HEAD";
  const changed = collectChangedFiles(ref);
  const hit = hitForceFull(changed);
  const argv = hit
    ? ["pnpm", "run", "test"]
    : ["pnpm", "exec", "vitest", "run", "--changed", ref, "--passWithNoTests"];

  console.log(
    `[test-affected] 基线 ${ref}，变更 ${changed.length} 个文件：` +
      (hit ? `命中兜底 ${hit} → 全量` : "无兜底命中 → --changed"),
  );
  if (process.env.TEST_AFFECTED_DRY_RUN === "1") {
    console.log(`[test-affected] DRY_RUN 将执行：${argv.join(" ")}`);
    return 0;
  }
  return runArgv(argv);
}

// 直接执行时跑 main；被 e2e-affected.mjs 导入复用时不跑。
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  process.exit(main());
}
