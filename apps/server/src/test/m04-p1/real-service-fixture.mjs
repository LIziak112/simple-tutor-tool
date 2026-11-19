import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createTestDir } from "../../db/test-utils.ts";
import { removeDataDirWithRetry, serverDir } from "../child-server.ts";

export async function createRealServiceFixture(sharedDataDir) {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  const closed = once(socket, "close");
  socket.close();
  await closed;
  const dataDir = sharedDataDir ?? createTestDir();
  const base = `http://127.0.0.1:${port}`;
  const app = { request: (path, init) => fetch(base + path, init) };
  let server;
  async function stop(signal = "SIGTERM") {
    if (!server || server.exitCode !== null || server.signalCode !== null)
      return;
    const exited = once(server, "exit", {
      signal: AbortSignal.timeout(10_000),
    });
    server.kill(signal);
    await exited;
  }
  return {
    app,
    dataDir,
    stop,
    async boot(enabled, { preloads = [], extraEnv = {} } = {}) {
      const loader = pathToFileURL(
        join(serverDir, "node_modules", "tsx", "dist", "loader.mjs"),
      ).href;
      server = spawn(
        process.execPath,
        [
          "--import",
          loader,
          ...preloads.flatMap((path) => ["--import", path]),
          "src/index.ts",
        ],
        {
          cwd: serverDir,
          windowsHide: true,
          env: {
            ...process.env,
            NODE_ENV: "development",
            PORT: String(port),
            PUBLIC_URL: base,
            DATA_DIR: dataDir,
            OWNCLASS_KERNEL_ASSIGNMENTS_ENABLED: enabled ? "1" : "0",
            ...extraEnv,
          },
          stdio: ["ignore", "ignore", "inherit"],
        },
      );
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (server.exitCode !== null)
          throw new Error(`服务提前退出 ${server.exitCode}`);
        const health = await app
          .request("/api/public/health")
          .catch(() => null);
        if (health?.ok) return server.pid;
        await sleep(150);
      }
      throw new Error("服务未就绪");
    },
    async close() {
      await stop();
      if (sharedDataDir === undefined) await removeDataDirWithRetry(dataDir);
    },
  };
}
