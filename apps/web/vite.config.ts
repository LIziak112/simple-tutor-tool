import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { pwaManifest } from "./src/lib/pwa-manifest";

// Vite 配置：React + Tailwind v4（无 tailwind.config，样式全在 src/index.css）

/** Excalidraw 静态资源的对外 URL 前缀（适配器设置 window.EXCALIDRAW_ASSET_PATH） */
const EXCALIDRAW_ASSET_PREFIX = "/excalidraw-assets/";

/**
 * Excalidraw 本站静态资源插件（T2.7，禁 CDN）：
 * 库运行时按 window.EXCALIDRAW_ASSET_PATH（excalidraw-adapter.ts 中设为本前缀）
 * 请求字体等文件。14MB 字体不提交进仓库/public，而是按需提供：
 * - dev：中间件把 /excalidraw-assets/fonts/* 映射到包内 dist/dev/fonts/*；
 * - build：closeBundle 阶段把包内字体复制进 dist/excalidraw-assets/fonts/。
 */
function excalidrawAssets(): Plugin {
  // apps/web/node_modules/@excalidraw/excalidraw/dist/dev（pnpm 符号链接可解析）
  const pkgDevDir = fileURLToPath(
    new URL("./node_modules/@excalidraw/excalidraw/dist/dev", import.meta.url),
  );

  function contentTypeFor(file: string): string {
    if (file.endsWith(".woff2")) return "font/woff2";
    if (file.endsWith(".woff")) return "font/woff";
    if (file.endsWith(".ttf")) return "font/ttf";
    if (file.endsWith(".css")) return "text/css; charset=utf-8";
    return "application/octet-stream";
  }

  return {
    name: "tutor:excalidraw-assets",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        if (!path.startsWith(EXCALIDRAW_ASSET_PREFIX)) {
          next();
          return;
        }
        const rel = decodeURIComponent(
          path.slice(EXCALIDRAW_ASSET_PREFIX.length),
        ).replace(/^\/+/, "");
        // 防路径穿越：只放行 fonts/ 前缀下的具体文件
        if (!rel.startsWith("fonts/") || rel.includes("..")) {
          next();
          return;
        }
        const file = resolvePath(pkgDevDir, rel);
        const root = resolvePath(pkgDevDir);
        if (
          !file.startsWith(root) ||
          !existsSync(file) ||
          !statSync(file).isFile()
        ) {
          next();
          return;
        }
        try {
          res.setHeader("Content-Type", contentTypeFor(file));
          res.end(readFileSync(file));
        } catch {
          next();
        }
      });
    },
    closeBundle() {
      // 生产构建：字体随 dist 发布（服务器托管 apps/web/dist）
      const outDir = fileURLToPath(new URL("./dist", import.meta.url));
      const fontsSrc = resolvePath(pkgDevDir, "fonts");
      if (existsSync(fontsSrc) && statSync(fontsSrc).isDirectory()) {
        cpSync(fontsSrc, resolvePath(outDir, "excalidraw-assets/fonts"), {
          recursive: true,
        });
      }
    },
  };
}

/**
 * PWA 配置（T2.12，架构 §2.2 / §5.10）：
 * - injectRegister: false——不在 index.html 自动注入注册脚本；由 main.tsx 调
 *   lib/pwa.ts 先取 /api/public/config，pwaEnabled（= PUBLIC_URL 为 https）才
 *   注册 SW。纯 HTTP（公网 IP 部署、备案前）不注册，功能完整；
 * - 只缓存静态资源，绝不缓存 API：navigateFallback 的回退排除 /api 路径，
 *   runtimeCaching 不配置任何 /api 规则（未列出的请求 workbox 一律放行网络）；
 * - 预缓存取舍：排除 excalidraw-assets（约 14MB 字体，首装过重），改为
 *   CacheFirst 运行时缓存——用过手写题后离线可用，首次安装不背这笔流量；
 *   其余产物（JS/CSS/KaTeX woff2/图标，约 12MB）全量预缓存，离线可完整答题；
 * - dev 模式禁用（devOptions.enable=false）：开发环境不生成 sw.js、不注入
 *   manifest link，localhost 调试行为与 HTTP 部署一致。
 */
function pwa() {
  return VitePWA({
    injectRegister: false,
    registerType: "autoUpdate",
    manifest: { ...pwaManifest },
    workbox: {
      globPatterns: ["**/*.{js,css,html,svg,png,webmanifest,woff2}"],
      globIgnores: ["**/excalidraw-assets/**"],
      navigateFallback: "index.html",
      // 注意：denylist 正则匹配的是完整 URL（http://host/api/...），不能锚定行首
      navigateFallbackDenylist: [/\/api\//],
      cleanupOutdatedCaches: true,
      runtimeCaching: [
        {
          // Excalidraw 本站字体（禁 CDN，见 excalidrawAssets 插件）：按需缓存
          urlPattern: /\/excalidraw-assets\//,
          handler: "CacheFirst",
          options: {
            cacheName: "excalidraw-assets",
            cacheableResponse: { statuses: [0, 200] },
            expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 },
          },
        },
      ],
    },
    devOptions: { enabled: false },
  });
}

export default defineConfig({
  plugins: [react(), tailwindcss(), excalidrawAssets(), pwa()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // 样例文档别名：/dev/render 开发页用 ?raw 引入 samples/ 原文做预置样例
      "@samples": fileURLToPath(new URL("../../samples", import.meta.url)),
    },
  },
  server: {
    // 暴露局域网地址，iPad 同一 Wi-Fi 可直接访问开发服务器
    host: true,
    // 启动即预热入口（触发依赖预构建）：dev 首屏与 E2E 首个导航不再等
    // 预构建（CI 全新环境上冷预构建曾把首个用例拖超时）
    warmup: { clientFiles: ["./index.html", "./src/main.tsx"] },
    proxy: {
      // 开发环境把 /api 转发给本地 server（端口见 §0.3，默认 8787）。
      // 用 127.0.0.1 而不是 localhost，避免 Windows 上解析到 IPv6 导致代理失败。
      // DEV_API_PROXY_TARGET 覆盖目标：E2E（T2.13）起独立 server 在 8899，
      // 与日常 pnpm dev（8787）互不干扰；不设置时行为不变。
      "/api": process.env.DEV_API_PROXY_TARGET ?? "http://127.0.0.1:8787",
      // 图片伺服（媒体管线第二单）：/blobs/* 由 server 从 DATA_DIR/blobs/media
      // 内容寻址直出（生产同源托管，无代理）；dev 下与 /api 同目标同逻辑转发。
      "/blobs": process.env.DEV_API_PROXY_TARGET ?? "http://127.0.0.1:8787",
    },
  },
  // build.outDir 保持默认 dist：生产模式由 apps/server 托管 apps/web/dist
});
