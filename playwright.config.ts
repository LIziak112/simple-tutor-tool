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
 * - server：node 直接跑 tsx 的 cli 入口（不用 pnpm --filter 壳——pnpm 在 POSIX 上
 *   不向子进程转发信号，Playwright teardown 杀不到 server，CI 曾等满 900s；
 *   tsx cli 会向真正的 server 进程转发 SIGTERM/SIGINT），cwd 指到 apps/server，
 *   端口 8899、DATA_DIR 指向本 run 唯一临时目录（不污染本地 data/）；
 * - web：node 直接跑 vite 的 bin（同样去 pnpm 壳），cwd 指到 apps/web，
 *   /api 代理目标经 DEV_API_PROXY_TARGET 指向 8899（vite.config.ts 支持）。
 * gracefulShutdown：POSIX 上 teardown 先向进程组发 SIGTERM（server 的优雅退出
 * 处理生效，见 apps/server/src/index.ts），10 秒未退再走默认 SIGKILL 组杀兜底；
 * Windows 不支持优雅关闭，自动回退 taskkill /T 树杀（本机路径不变）。
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
  // 单用例超时：本机主流程 ~15s，CI 2 核 runner + vite 冷编译约 40-60s，120s 已足余量。
  // 收紧（原 180s）：失败时更快暴露（4 用例 × 重试 1 次吃满 180s 会把 job 拖到 12 分钟+）。
  timeout: 120_000,
  // 整个 run 的硬上限（含所有 worker）：防止 worker/浏览器卡死时无限等待
  // （CI job 层面还有 workflow 的 timeout-minutes 双保险）。
  globalTimeout: 15 * 60_000,
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
      // 去掉 pnpm 壳（POSIX 信号转发断链的根因）：node 直接跑 tsx 的 cli 入口。
      // 进程链 = Playwright → node(tsx cli) → node(server)，tsx cli 会转发
      // SIGTERM/SIGINT，server 自身也有优雅退出处理（src/index.ts），双层保证。
      command: "node node_modules/tsx/dist/cli.mjs src/index.ts",
      cwd: "apps/server",
      url: `http://127.0.0.1:${E2E_SERVER_PORT}/api/public/health`,
      reuseExistingServer: false,
      // 180s：CI 2 核 runner 冷启动（tsx 加载依赖→迁移）留足余量；本机秒级
      timeout: 180_000,
      // env 与 process.env 合并（Playwright spawn 语义），CI/本机行为一致
      env: {
        PORT: String(E2E_SERVER_PORT),
        DATA_DIR: dataDir,
        PUBLIC_URL: `http://127.0.0.1:${E2E_WEB_PORT}`,
      },
      // CI 打印被测进程输出（[WebServer] 前缀）：启动失败/卡住时日志能定位；
      // 本机忽略 stdout 减噪（stderr 始终透出）
      stdout: IS_CI ? "pipe" : "ignore",
      stderr: "pipe",
      // POSIX teardown：先向进程组发 SIGTERM（server 优雅退出，见 src/index.ts），
      // 10 秒未退由 Playwright 走默认 SIGKILL 进程组杀兜底；Windows 忽略此选项
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      // 同样去 pnpm 壳：node 直接跑 vite bin，cwd 到 apps/web（vite 以 cwd 为 root）
      command: `node node_modules/vite/bin/vite.js --port ${E2E_WEB_PORT} --strictPort`,
      cwd: "apps/web",
      url: `http://127.0.0.1:${E2E_WEB_PORT}`,
      reuseExistingServer: false,
      // 180s：vite 冷启动（依赖预构建）在 CI 上明显慢于本机
      timeout: 180_000,
      env: {
        DEV_API_PROXY_TARGET: `http://127.0.0.1:${E2E_SERVER_PORT}`,
      },
      stdout: IS_CI ? "pipe" : "ignore",
      stderr: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
  ],
});
