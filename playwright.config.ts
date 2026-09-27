import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E 配置（T2.13，验收：pnpm e2e 全过 + CI 中运行 webkit 项目）。
 *
 * 项目：chromium（本机用已安装的 Edge，channel "msedge" 免下载；CI 用 Playwright
 * 自带 chromium build 以便完整缓存 ~/.cache/ms-playwright）+ webkit，两者都用
 * iPad（第 7 代）竖屏设备模拟（820×1180、触摸、移动端 UA）。
 *
 * 被测环境（webServer 数组，先 server 后 web）：
 * - server：tsx 直接跑 apps/server/src/index.ts（不用 watch，避免孤儿进程），
 *   端口 8899、DATA_DIR 指向本 run 唯一临时目录（不污染本地 data/，run 间数据隔离）；
 * - web：vite dev（--port 5199 --strictPort），/api 代理目标经
 *   DEV_API_PROXY_TARGET 环境变量指向 8899（vite.config.ts 支持）。
 * 两个端口都避开日常 pnpm dev 的 8787/5173（vite 端口被占时会自动 +1 顺延，
 * 如 5174），本机开发与 E2E 可同时进行；
 * reuseExistingServer 一律 false——E2E 数据目录每 run 不同，复用旧 server 会写错库。
 */

/** 是否在 CI（GitHub Actions）中运行 */
const IS_CI = !!process.env.CI;

/** E2E 专用端口：避开日常 dev 的 8787（server）与 5173-517x（vite 自动顺延段） */
const E2E_SERVER_PORT = 8899;
const E2E_WEB_PORT = 5199;

/** 本 run 唯一数据目录：教师 setup/学生/作业/attempt 全部隔离，跑完留在临时目录便于排查 */
const dataDir = mkdtempSync(join(tmpdir(), "tutor-e2e-"));

/**
 * iPad（第 7 代）竖屏设备参数（820×1180、触摸、移动端 UA）。
 * 显式摘取需要的字段而不是整体展开——devices 描述符里的 defaultBrowserType
 * 会覆盖项目名指定的浏览器（原样展开会让 chromium 项目也走 webkit 启动）；
 * 用哪个浏览器由项目名决定。
 */
const iPadPortrait = {
  viewport: devices["iPad (gen 7)"].viewport,
  userAgent: devices["iPad (gen 7)"].userAgent,
  deviceScaleFactor: devices["iPad (gen 7)"].deviceScaleFactor,
  isMobile: devices["iPad (gen 7)"].isMobile,
  hasTouch: devices["iPad (gen 7)"].hasTouch,
};

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.artifacts",
  // 主流程用例串起教师端+学生端全链路（含 2 秒防抖的笔迹上传），整体放宽
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: IS_CI,
  // CI 重试 1 次吸收 runner 的网络/首编译抖动；本机不重试，避免掩盖真问题
  retries: IS_CI ? 1 : 0,
  // CI 限并发（2 核 runner）；本机用默认（exactOptionalPropertyTypes：仅 CI 展开）
  ...(IS_CI ? { workers: 2 } : {}),
  reporter: IS_CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${E2E_WEB_PORT}`,
    // 127.0.0.1 而非 localhost：避免 Windows 上解析到 IPv6 导致连不上（与 vite 代理同口径）
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        // 本机用系统 Edge；CI 用 playwright 自带 chromium（见文件头注释）
        ...(IS_CI ? {} : { channel: "msedge" }),
        ...iPadPortrait,
      },
    },
    {
      name: "webkit",
      use: { ...iPadPortrait },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter server exec tsx src/index.ts",
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
    },
    {
      command: `pnpm --filter web exec vite --port ${E2E_WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${E2E_WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        DEV_API_PROXY_TARGET: `http://127.0.0.1:${E2E_SERVER_PORT}`,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
