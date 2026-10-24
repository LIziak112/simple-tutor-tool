// lint 受影响档（2026-10-25）：biome 原生 --changed 只看「已提交差异」，官方语义
// 明确不含 staged/unstaged、面向 CI——修复循环必须覆盖未提交与未跟踪文件，不能
// 直接用。这里自己收集变更清单（diff + 未跟踪），把存在的文件显式传给 biome；
// biome 对不支持或被配置排除的路径只提示 ignored、不报错，无需复刻排除清单。
// 兜底清单命中（biome.json、依赖锁等）→ 全量 pnpm lint。
// 文件列表超过 cmd.exe 命令行上限时自动分批（biome 启动快，多批无妨）。
//
// 用法：node scripts/lint-affected.mjs [ref]（默认 origin/main）
// 环境变量 AFFECTED_DRY_RUN=1 只打印决策不执行。
import {
  collectChangedFiles,
  existing,
  hitForceFull,
  isDryRun,
  packChunks,
  runArgv,
  runIfMain,
} from "./affected-lib.mjs";

function main() {
  const ref = process.argv[2] ?? "origin/main";
  const changed = collectChangedFiles(ref);
  const hit = hitForceFull(changed);
  console.log(
    hit
      ? `[lint-affected] 基线 ${ref}：命中兜底 ${hit} → 全量`
      : `[lint-affected] 基线 ${ref}：无兜底命中 → 只查变更文件`,
  );
  if (hit) {
    if (isDryRun()) {
      console.log("[lint-affected] DRY_RUN 将执行：pnpm run lint");
      return 0;
    }
    return runArgv(["pnpm", "run", "lint"]);
  }

  const base = ["pnpm", "exec", "biome", "check"];
  const paths = existing(changed);
  if (paths.length === 0) {
    console.log("[lint-affected] 无可检查文件，跳过");
    return 0;
  }
  const chunks = packChunks(base, paths);
  if (isDryRun()) {
    console.log(
      `[lint-affected] DRY_RUN 将执行：biome check ${paths.length} 个文件（${chunks.length} 批）`,
    );
    return 0;
  }
  for (const chunk of chunks) {
    const code = runArgv([...base, ...chunk]);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
}

runIfMain(import.meta.url, main);
