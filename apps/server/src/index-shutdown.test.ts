import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 入口进程的优雅退出测试（T2.13 修复迭代）：
 * 以真实子进程跑 src/index.ts（与 E2E webServer 同一启动形态：node + tsx cli），
 * 就绪后发 SIGTERM，断言进程快速退出——regression 防 E2E teardown 挂死
 * （CI 实测：无信号处理时 pnpm/tsx 链不退，Playwright 等满 globalTimeout）。
 * 不用 app.request() 级测试替代：信号处理只存在于真实进程层。
 */

/** apps/server 目录（测试文件位于 src/ 下） */
const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** tsx 的 cli 入口（与 playwright.config.ts 的 webServer command 同源） */
const tsxCli = join(serverDir, "node_modules", "tsx", "dist", "cli.mjs");

/** 找一个空闲 TCP 端口（listen(0) 由内核分配，close 后交给被测进程用） */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("无法获取空闲端口")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** 轮询 health 直到就绪（tsx 冷启动 + 迁移需数秒） */
async function waitReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/public/health`);
      if (res.ok) return;
    } catch {
      // 尚未监听：继续轮询
    }
    if (Date.now() > deadline) throw new Error("服务在时限内未就绪");
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
  }
}

describe("入口进程优雅退出", () => {
  it("收到 SIGTERM 后进程在数秒内退出（不挂死）", async () => {
    const port = await findFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), "tutor-shutdown-test-"));
    const child = spawn(process.execPath, [tsxCli, "src/index.ts"], {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      // stderr 透出便于排错；stdout（pino 日志）忽略防刷屏
      stdio: ["ignore", "ignore", "inherit"],
    });
    try {
      await waitReady(port, 30_000);
      const start = Date.now();
      const exitInfo = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.kill("SIGTERM");
      });
      const elapsed = Date.now() - start;
      // Windows 上 child.kill("SIGTERM") 被 Node 映射为无条件终止（不进 handler，
      // 退出码非 0），优雅退出码只能 POSIX 断言（CI ubuntu 覆盖）；
      // Windows 本机至少断言"杀得动、不挂死"（回归目标本身）。
      if (process.platform !== "win32") {
        expect(exitInfo.code).toBe(0);
      }
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      // Windows 下子进程退出后句柄可能延迟释放（杀毒/索引器扫描临时目录），
      // rmSync 立即删除会 EPERM——重试几轮，仍失败则容忍（测试本体已过，
      // 临时目录留给系统清理，不让清理竞态打挂用例）
      for (let i = 0; ; i++) {
        try {
          rmSync(dataDir, { recursive: true, force: true });
          break;
        } catch (error) {
          if (i >= 9 || (error as NodeJS.ErrnoException).code !== "EPERM") {
            break;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 200);
          });
        }
      }
    }
  }, 60_000); // tsx 冷启动 + 迁移 + 信号退出，整体放宽
});
