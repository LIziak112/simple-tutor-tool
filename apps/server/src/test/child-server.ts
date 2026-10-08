import {
  type ChildProcess,
  type StdioOptions,
  spawn,
} from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 真实子进程跑 src/index.ts 的测试基建（2026-10-08 随启动错误加固立项）：
 * 以 node + tsx cli 启动（与 playwright.config.ts 的 webServer command 同源），
 * 供进程级回归测试复用（index-shutdown.test.ts / index-startup-errors.test.ts）。
 * 信号处理、端口冲突等行为只存在于真实进程层，app.request() 级测试无法替代。
 */

/** apps/server 目录（本文件位于 src/test/ 下，需回退两级） */
export const serverDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** tsx 的 cli 入口（与 playwright.config.ts 的 webServer command 同源） */
export const tsxCli = join(serverDir, "node_modules", "tsx", "dist", "cli.mjs");

/** 以真实子进程启动服务端；stdio 由调用方决定（收 stderr 断言用 pipe，平时 ignore/inherit） */
export function spawnServerForTest(opts: {
  port: number;
  dataDir: string;
  stdio: StdioOptions;
}): ChildProcess {
  const { port, dataDir, stdio } = opts;
  return spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio,
  });
}

/** 尽力删除测试用 DATA_DIR：Windows 下子进程退出后句柄可能延迟释放
 * （杀毒/索引器扫描临时目录），rmSync 立即删除会 EPERM——重试几轮，
 * 仍失败则容忍（测试本体已过，临时目录留给系统清理，不让清理竞态打挂用例） */
export async function removeDataDirWithRetry(dataDir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i >= 9 || (error as NodeJS.ErrnoException).code !== "EPERM") {
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
  }
}
