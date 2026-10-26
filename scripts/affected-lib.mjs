// 分层测试共享库（2026-10-25）：三档包装脚本（test-affected / lint-affected /
// e2e-affected）的公共机制——变更收集（diff + 未跟踪）、兜底清单、跨平台 shell
// 执行、命令行长度约束、DRY_RUN 与 main 守卫。放在 scripts/ 下即受兜底清单的
// scripts/ 前缀约束：改本文件 → 各档直接全量。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 命中任一 → 各档全量。路径为仓库根相对路径（runIfMain 已先 chdir 到仓库根）。
// vitest --changed 只按 import 模块图选测试，这些文件是被 fs 读进来的输入或
// 测试基建，import 图看不见；变更面无法静态推导，只能全量。
const FORCE_FULL_PATTERNS = [
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

// git 输出恒带 core.quotepath=false：默认 true 会把非 ASCII 路径转成带引号的
// 八进制转义串（本仓库 samples/v2 即有中文命名样例、docs 有中文目录），兜底
// 正则与 existsSync 全部失配，全量被静默绕过。
function gitLines(args) {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    encoding: "utf8",
  });
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
  // cmd.exe 会在引号内部展开 %VAR%，且命令行上下文无法转义——直接拒绝，
  // 不让 biome/playwright 静默收到被展开后的错误路径
  const risky = argv.find((arg) => arg.includes("%"));
  if (risky) {
    console.error(`[runArgv] 参数含 %，无法安全经 cmd 传递：${risky}`);
    return 1;
  }
  const result = spawnSync(toCommandLine(argv), {
    stdio: "inherit",
    shell: true,
  });
  if (result.error) {
    console.error(`[runArgv] 启动失败：${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

// DRY_RUN 时打印将执行的完整命令并返回 0，否则执行。三档统一走这里，
// 避免各入口自抄一份 dry-run 分支
export function runOrDryRun(tag, argv) {
  if (isDryRun()) {
    console.log(`[${tag}] DRY_RUN 将执行：${toCommandLine(argv)}`);
    return 0;
  }
  return runArgv(argv);
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

// 直接执行时先回到仓库根再跑 main：兜底正则与 existsSync 都按仓库根相对路径
// 工作，子目录手工运行时 git 输出相对 cwd 的路径会静默失配。
export function runIfMain(importMetaUrl, main) {
  const entry = process.argv[1];
  if (entry && fileURLToPath(importMetaUrl) === resolve(entry)) {
    const root = gitLines(["rev-parse", "--show-toplevel"])[0];
    if (!root) {
      console.error("无法定位仓库根目录（git rev-parse --show-toplevel）");
      process.exit(1);
    }
    process.chdir(root);
    process.exit(main());
  }
}
