// e2e 受影响档兜底（2026-10-25）：Playwright 无法按 import 图选用例——e2e spec
// 不导入应用源码，应用代码变更映射不到任何 spec。取最保守的可推导集合：
//   1) 命中与单测同一张兜底清单（迁移/契约/测试基建等，见 affected-lib.mjs）
//      → 全量 pnpm e2e；
//   2) e2e/ 下非 spec 文件（helpers、断言工具、global-setup 等）变动 → 全量
//      （几乎被全部 spec 复用，受影响面推不出）；
//   3) 只有 e2e/**/*.spec.ts 变动 → 只跑变动的 spec（pnpm e2e 支持追加 spec 路径）；
//   4) e2e 无关变动 → 跳过（全量由 PR CI 与每晚 schedule 兜底）。
//
// 用法：node scripts/e2e-affected.mjs [ref]（默认 origin/main）
// 环境变量 AFFECTED_DRY_RUN=1 只打印决策不执行。
import {
  CMD_LENGTH_LIMIT,
  collectChangedFiles,
  existing,
  hitForceFull,
  runIfMain,
  runOrDryRun,
  toCommandLine,
} from "./affected-lib.mjs";

export function decideE2e(changed) {
  const forceFull = hitForceFull(changed);
  if (forceFull) {
    return { mode: "full", reason: `命中兜底文件 ${forceFull}` };
  }
  const e2eChanged = changed.filter((path) => path.startsWith("e2e/"));
  const infra = e2eChanged.find((path) => !/\.spec\.ts$/.test(path));
  if (infra) {
    return { mode: "full", reason: `e2e 基建文件 ${infra} 变动` };
  }
  if (e2eChanged.length > 0) {
    return { mode: "specs", specs: e2eChanged, reason: "仅 spec 变动" };
  }
  return { mode: "skip", reason: "无 e2e 相关变动" };
}

function main() {
  const ref = process.argv[2] ?? "origin/main";
  const decision = decideE2e(collectChangedFiles(ref));
  console.log(
    `[e2e-affected] 基线 ${ref}：${decision.mode}（${decision.reason}）`,
  );
  if (decision.mode === "skip") {
    console.log(
      "[e2e-affected] 跳过本地 e2e；全量由 PR CI 与每晚 schedule 兜底",
    );
    return 0;
  }
  if (decision.mode === "full") {
    return runOrDryRun("e2e-affected", ["pnpm", "run", "e2e"]);
  }

  // 已删除的 spec 过滤掉；剩余超长时回退全量——分批跑 playwright 会重复启动
  // webServer（每批 30s+），不如一次全量省
  const specs = existing(decision.specs);
  if (specs.length === 0) {
    console.log("[e2e-affected] 变动的 spec 均已删除，跳过；全量由 PR CI 兜底");
    return 0;
  }
  const argv = ["pnpm", "run", "e2e", ...specs];
  if (toCommandLine(argv).length > CMD_LENGTH_LIMIT) {
    console.log(
      `[e2e-affected] 变动 spec ${specs.length} 个超出命令行上限，回退全量`,
    );
    return runOrDryRun("e2e-affected", ["pnpm", "run", "e2e"]);
  }
  return runOrDryRun("e2e-affected", argv);
}

runIfMain(import.meta.url, main);
