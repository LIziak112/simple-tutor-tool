// 分层测试共享库（2026-10-25）：三档包装脚本（test-affected / lint-affected /
// e2e-affected）的公共机制——变更收集（diff + 未跟踪）、兜底清单、跨平台 shell
// 执行、命令行长度约束、DRY_RUN 与 main 守卫。放在 scripts/ 下即受兜底清单的
// scripts/ 前缀约束：改本文件 → 各档直接全量。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 命中任一 → 各档全量。路径为仓库根相对路径（脚本约定在根目录执行）。
// vitest --changed 只按 import 模块图选测试，这些文件是被 fs 读进来的输入或
// 测试基建，import 图看不见；变更面无法静态推导，只能全量。
export const FORCE_FULL_PATTERNS = [
  // 依赖锁与测试/构建配置：影响所有测试的装载与转译方式
  /^pnpm-lock\.yaml$/,
  /(^|\/)vitest\.(config|workspace)\.[cm]?ts$/,
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
// 注意：不能在这里过滤掉已删除文件——删除迁移/契约同样必须触发兜底全量。
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

// 传给下游命令（biome / playwright）前剔除已删除文件，避免路径不存在报错
export function existing(paths) {
  return paths.filter((path) => existsSync(path));
}

export function isDryRun() {
  return process.env.AFFECTED_DRY_RUN === "1";
}

// 含空白/特殊字符的参数加引号；Windows 上 pnpm 是 .cmd，必须经 shell 执行。
export function toCommandLine(argv) {
  return argv
    .map((arg) => (/[^\w@%+=:,./-]/.test(arg) ? `"${arg}"` : arg))
    .join(" ");
}

export function runArgv(argv) {
  const result = spawnSync(toCommandLine(argv), {
    stdio: "inherit",
    shell: true,
  });
  return result.status ?? 1;
}

// cmd.exe 单条命令约 8191 字符上限，留余量；超限的文件列表必须分批或升级全量
export const CMD_LENGTH_LIMIT = 7000;

// 把 paths 按 base + 文件参数拼出的命令行长度装进尽量少的批（每批至少 1 个文件）。
export function packChunks(base, paths) {
  const chunks = [];
  let current = [];
  for (const path of paths) {
    const grown = toCommandLine([...base, ...current, path]).length;
    if (current.length > 0 && grown > CMD_LENGTH_LIMIT) {
      chunks.push(current);
      current = [path];
    } else {
      current.push(path);
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

// 直接执行时跑 main；被其他模块导入复用时不跑。
export function runIfMain(importMetaUrl, main) {
  const entry = process.argv[1];
  if (entry && fileURLToPath(importMetaUrl) === resolve(entry)) {
    process.exit(main());
  }
}
