// 分层测试兜底（2026-10-25）——单测档：兜底清单未命中时透传 vitest --changed <ref>
// （按 import 模块图选受影响测试；经 pnpm run test 透传，test 脚本演进不漂移）。
//
// 用法：node scripts/test-affected.mjs <ref>
//   ref = HEAD        → 未提交改动（快档，pnpm test:quick）
//   ref = origin/main → 相对 main 的全部改动（受影响档，pnpm test:affected）
// 环境变量 AFFECTED_DRY_RUN=1 只打印决策不执行（自检/排查用）。
import {
  collectChangedFiles,
  hitForceFull,
  runIfMain,
  runOrDryRun,
} from "./affected-lib.mjs";

function main() {
  const ref = process.argv[2] ?? "HEAD";
  const hit = hitForceFull(collectChangedFiles(ref));
  // --changed 经 pnpm 透传给 test 脚本（vitest run --passWithNoTests --changed <ref>）
  const argv = hit
    ? ["pnpm", "run", "test"]
    : ["pnpm", "run", "test", "--changed", ref];

  console.log(
    hit
      ? `[test-affected] 基线 ${ref}：命中兜底 ${hit} → 全量`
      : `[test-affected] 基线 ${ref}：无兜底命中 → --changed`,
  );
  return runOrDryRun("test-affected", argv);
}

runIfMain(import.meta.url, main);
