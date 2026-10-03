// 生成 GitHub 仓库社交预览图（逻辑尺寸 1200×640，deviceScaleFactor 2 实际输出 2400×1280）。
// 产物：docs/social-preview.png，上传路径：GitHub 仓库 → Settings → Social preview。
// 运行方式：node scripts/gen-social-preview.mjs
// 前置条件：本机需已安装 Playwright 的 Chromium（未安装时先运行：npx playwright install chromium）。
// 依赖说明：仅使用仓库 devDependencies 中已有的 @playwright/test（官方支持从该包导入 chromium），不新增任何依赖。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

// 页面内容为内联 HTML，无任何外部请求；字体走系统字体栈（中文回退微软雅黑 / 苹方）。
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 640px; }
  body {
    background: #f6f8fb;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    width: 1060px;
    height: 540px;
    background: #ffffff;
    border-radius: 20px;
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.07);
    padding: 76px 80px 56px 88px;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
  }
  .accent {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 8px;
    background: #2563eb;
  }
  h1 {
    font-size: 72px;
    font-weight: 700;
    color: #0f172a;
    letter-spacing: -1px;
  }
  .subtitle-zh {
    margin-top: 20px;
    font-size: 34px;
    font-weight: 500;
    color: #334155;
  }
  .subtitle-en {
    margin-top: 14px;
    font-size: 22px;
    color: #64748b;
  }
  .tags {
    margin-top: 52px;
    display: flex;
    gap: 16px;
  }
  .tag {
    font-size: 22px;
    font-weight: 500;
    color: #1d4ed8;
    background: #e0eaff;
    padding: 12px 28px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .foot {
    margin-top: auto;
    font-size: 20px;
    color: #94a3b8;
    letter-spacing: 1px;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="accent"></div>
    <h1>simple-tutor-tool</h1>
    <div class="subtitle-zh">一对一辅导的自部署 AI 讲练工具</div>
    <div class="subtitle-en">Self-hosted · AI-native · for 1-on-1 tutors</div>
    <div class="tags">
      <span class="tag">Markdown 讲练 DSL</span>
      <span class="tag">iPad 手写作答</span>
      <span class="tag">学情数据回流 AI</span>
    </div>
    <div class="foot">单进程 · SQLite · 数据自持 · MIT</div>
  </div>
</body>
</html>`;

const outPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "social-preview.png",
);

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1200, height: 640 },
    deviceScaleFactor: 2,
  });
  await page.setContent(html, { waitUntil: "load" });
  await page.waitForTimeout(200); // 等系统字体排版稳定
  await page.screenshot({ path: outPath, fullPage: false });
  console.log(`已生成社交预览图:${outPath}`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`生成失败:${message}`);
  // Playwright 在浏览器可执行文件缺失时会提示运行 playwright install，据此区分提示语。
  if (
    /playwright install|Executable doesn't exist|Looks like Playwright/i.test(
      message,
    )
  ) {
    console.error(
      "本机尚未安装 Playwright Chromium,请先运行:npx playwright install chromium",
    );
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
}
