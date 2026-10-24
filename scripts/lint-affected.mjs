// lint 受影响档（2026-10-25）：biome 原生 --changed 只看「已提交差异」，官方语义
// 明确不含 staged/unstaged、面向 CI——修复循环必须覆盖未提交与未跟踪文件，不能
// 直接用。这里自己收集变更清单（与单测档同一来源：diff + 未跟踪），把存在的
// 文件显式传给 biome；biome 对不支持或被配置排除的路径只提示 ignored、不报错，
// 无需复刻排除清单。兜底清单命中（biome.json、依赖锁等）→ 全量 pnpm lint。
// 用法：node scripts/lint-affected.mjs [ref]（默认 origin/main）
// 环境变量 TEST_AFFECTED_DRY_RUN=1 只打印决策不执行。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectChangedFiles,
  hitForceFull,
  runArgv,
} from "./test-affected.mjs";

function main() {
  const ref = process.argv[2] ?? "origin/main";
  const changed = collectChangedFiles(ref);
  const hit = hitForceFull(changed);
  console.log(
    `[lint-affected] 基线 ${ref}，变更 ${changed.length} 个文件：` +
      (hit ? `命中兜底 ${hit} → 全量` : "无兜底命中 → 只查变更文件"),
  );
  if (process.env.TEST_AFFECTED_DRY_RUN === "1") {
    return 0;
  }
  if (hit) {
    return runArgv(["pnpm", "run", "lint"]);
  }
  // 已删除的文件不再存在，显式传不存在路径会让 biome 报错，先过滤掉
  const paths = changed.filter((path) => existsSync(path));
  if (paths.length === 0) {
    console.log("[lint-affected] 无可检查文件，跳过");
    return 0;
  }
  return runArgv(["pnpm", "exec", "biome", "check", ...paths]);
}

// 直接执行时跑 main；被其他模块导入复用时不跑。
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  process.exit(main());
}
