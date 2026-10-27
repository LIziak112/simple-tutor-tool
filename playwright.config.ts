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

/** e2e 前端对照实验模式（2026-10-25 已判决**不切换**，默认关闭，见
 *  docs/e2e功能面选测与preview对照.md：spec 依赖 dev server 的 /src 源码路径
 *  与 /dev 调试页，preview 结构性不兼容）：手动设置 E2E_WEB_PREVIEW=1 时
 *  webServer 先 vite build 再 vite preview 服务构建产物。注意 e2e:full 与
 *  pnpm e2e 等价（dev server），本变量只服务手动对照复现——
 *  Git Bash：E2E_WEB_PREVIEW=1 pnpm e2e；cmd：set E2E_WEB_PREVIEW=1&&pnpm e2e；
 *  PowerShell：$env:E2E_WEB_PREVIEW="1"; pnpm e2e。preview 的代理与 PWA
 *  裁剪经 --mode e2e-preview 挂在 vite 内建 mode 上（apps/web/vite.config.ts）。 */
const USE_PREVIEW = process.env.E2E_WEB_PREVIEW === "1";

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
  // SAI-33（B18）假 AI 供应商：globalSetup 在 Playwright 主进程启动
  // 127.0.0.1:8898（OpenAI 兼容端点 + 控制端），被测 server 经下方 env 的
  // E2E_FAKE_AI_BASE_URL 显式分流出站到该服务——业务链路全真，只有最后一跳
  // 指向受控假端点，见 e2e/fake-ai-provider.ts 头注。
  globalSetup: "./e2e/global-setup.ts",
  outputDir: "./e2e/.artifacts",
  // 单用例超时：本机主流程 ~15s，CI 2 核 runner + vite 冷编译约 40-60s，120s 已足余量。
  // 收紧（原 180s）：失败时更快暴露（4 用例 × 重试 1 次吃满 180s 会把 job 拖到 12 分钟+）。
  timeout: 120_000,
  // 262 项双浏览器回归在 CI 的两路并发下约需 30 分钟（2026-10-27 #32 合入后套件
  // 贴满旧 30 分钟墙），保留 45 分钟给 flaky 重试与冷编译余量，外层 job 上限 55 分钟。
  // 整个 run 的硬上限（含所有 worker）：防止 worker/浏览器卡死时无限等待
  // （CI job 层面还有 workflow 的 timeout-minutes 双保险）。
  globalTimeout: 45 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: IS_CI,
  // CI 重试 1 次吸收 runner 的网络/首编译抖动；本机不重试，避免掩盖真问题
  retries: IS_CI ? 1 : 0,
  // CI 限 2（2 核 runner）；本机显式 6——默认值是 CPU 逻辑核数的一半（本机 8），
  // 16GB 内存下 8 路 Edge/WebKit 并发会顶到内存上限，6 路是实测安全档。
  // 低配/高配机可用 CLI 覆盖：pnpm e2e --workers=N
  workers: IS_CI ? 2 : 6,
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
      // env 与 process.env 合并（Playwright spawn 语义），CI/本机行为一致；
      // E2E_FAKE_AI_BASE_URL 显式激活假 AI 供应商分流（SAI-33，见
      // provider-client.ts 的 defaultProviderTransport 注释——仓库外部署
      // 不设置该变量，生产行为零变化）
      env: {
        PORT: String(E2E_SERVER_PORT),
        DATA_DIR: dataDir,
        PUBLIC_URL: `http://127.0.0.1:${E2E_WEB_PORT}`,
        E2E_FAKE_AI_BASE_URL: "http://127.0.0.1:8898/v1",
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
      // 同样去 pnpm 壳：node 直接跑 vite bin，cwd 到 apps/web（vite 以 cwd 为 root）。
      // E2E_WEB_PREVIEW=1：先 build 再 preview 服务 dist（对照实验，见上）；两端都带
      // --mode e2e-preview——vite.config 以此 mode 裁剪 PWA 插件并启用 preview 代理
      command: USE_PREVIEW
        ? `node node_modules/vite/bin/vite.js build --mode e2e-preview && node node_modules/vite/bin/vite.js preview --port ${E2E_WEB_PORT} --strictPort --mode e2e-preview`
        : `node node_modules/vite/bin/vite.js --port ${E2E_WEB_PORT} --strictPort`,
      cwd: "apps/web",
      url: `http://127.0.0.1:${E2E_WEB_PORT}`,
      reuseExistingServer: false,
      // dev 180s：vite 冷启动（依赖预构建）在 CI 上明显慢于本机；
      // preview 300s：先完整 build（本机 1-2 分钟）再起 preview
      timeout: USE_PREVIEW ? 300_000 : 180_000,
      env: {
        DEV_API_PROXY_TARGET: `http://127.0.0.1:${E2E_SERVER_PORT}`,
      },
      stdout: IS_CI ? "pipe" : "ignore",
      stderr: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
  ],
});
