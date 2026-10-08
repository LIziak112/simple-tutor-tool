import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  removeDataDirWithRetry,
  spawnServerForTest,
} from "./test/child-server";

/**
 * 启动期端口冲突的真实进程回归（2026-10-08 立项）：
 * 端口被占时必须：① 进程退出码 1；② stderr 出现含端口号的中文友好报错
 * （此前行为：未处理 error 事件裸崩，只有英文栈，排查成本极高——
 * 2026-10-08 半天排障的直接教训）。
 * stderr 用 pipe 捕获以便断言（stdout 的 pino 日志此时不可见，故只看 fd2）。
 */

/** 找一个空闲 TCP 端口（listen(0) 由内核分配）并保持占用（不 close）。
 * 必须绑 "::"（与服务端 @hono/node-server 相同的通配族）：绑 127.0.0.1
 * 时 Windows 允许通配 IPv6 socket 与之共存，制造不出冲突。 */
function holdFreePort(): Promise<{ port: number; release: () => void }> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "::", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("无法获取空闲端口")));
        return;
      }
      resolve({
        port: address.port,
        release: () => {
          probe.close();
        },
      });
    });
  });
}

describe("入口进程端口冲突", () => {
  it("端口被占时：退出码 1，stderr 出现含端口号的友好报错", async () => {
    const { port, release } = await holdFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), "tutor-eaddrinuse-test-"));
    const child = spawnServerForTest({
      port,
      dataDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("exit", (exitCode) => resolve(exitCode));
        child.once("error", reject);
        // 兜底：异常挂死时杀掉并让断言失败
        setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("端口冲突进程未在时限内退出"));
        }, 30_000).unref();
      });
      expect(code).toBe(1);
      expect(stderr).toContain(String(port));
      expect(stderr).toContain("已被占用");
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      release();
      await removeDataDirWithRetry(dataDir);
    }
  }, 60_000);
});
