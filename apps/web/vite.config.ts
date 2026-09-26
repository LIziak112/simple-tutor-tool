import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite 配置：React + Tailwind v4（无 tailwind.config，样式全在 src/index.css）
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
