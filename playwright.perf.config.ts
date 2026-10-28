import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * 性能实测专用配置（蓝小鲸，2026-10-28）。
 * 与主配置的区别：生产构建（vite build + preview）而非 dev server；单 worker；
 * 用本机 chrome-headless-shell 156（executablePath），CPU 节流由用例内经 CDP 设置。
 * 该文件与 e2e/perf-load.spec.ts 只用于本地取证，不提交。
 */
const CHROME =
  "/workspace/.cache/chrome/chrome-headless-shell/linux-156.0.8078.73/chrome-headless-shell-linux64/chrome-headless-shell";
const E2E_SERVER_PORT = 8899;
const E2E_WEB_PORT = 5199;
const dataDir = mkdtempSync(join(tmpdir(), "tutor-perf-"));

export default defineConfig({
  testDir: "./e2e",
  testMatch: /perf-load\.perf\.ts/,
  outputDir: "./e2e/.artifacts-perf",
  timeout: 900_000,
  expect: { timeout: 180_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${E2E_WEB_PORT}`,
    navigationTimeout: 180_000,
    actionTimeout: 60_000,
    launchOptions: {
      executablePath: CHROME,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  projects: [{ name: "chromium" }],
  webServer: [
    {
      command: "node node_modules/tsx/dist/cli.mjs src/index.ts",
      cwd: "apps/server",
      url: `http://127.0.0.1:${E2E_SERVER_PORT}/api/public/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        PORT: String(E2E_SERVER_PORT),
        DATA_DIR: dataDir,
        PUBLIC_URL: `http://127.0.0.1:${E2E_WEB_PORT}`,
      },
      stdout: "ignore",
      stderr: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      command:
        "node node_modules/vite/bin/vite.js build --mode e2e-preview && node node_modules/vite/bin/vite.js preview --port 5199 --strictPort --mode e2e-preview",
      cwd: "apps/web",
      url: `http://127.0.0.1:${E2E_WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: { DEV_API_PROXY_TARGET: `http://127.0.0.1:${E2E_SERVER_PORT}` },
      stdout: "ignore",
      stderr: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
  ],
});
