import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";

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
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
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

export default defineConfig({
  plugins: [react(), tailwindcss(), excalidrawAssets()],
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
    proxy: {
      // 开发环境把 /api 转发给本地 server（端口见 §0.3，默认 8787）。
      // 用 127.0.0.1 而不是 localhost，避免 Windows 上解析到 IPv6 导致代理失败
      "/api": "http://127.0.0.1:8787",
    },
  },
  // build.outDir 保持默认 dist：生产模式由 apps/server 托管 apps/web/dist
});
