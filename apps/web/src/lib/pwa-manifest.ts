import type { ManifestOptions } from "vite-plugin-pwa";

/**
 * PWA manifest 配置（T2.12）。
 * 放在 src/lib 而非 vite.config.ts 内联：vite.config.ts 与单测（pwa-manifest.test.ts）
 * 共用同一份数据，避免"配置"与"被测对象"两处手抄。
 *
 * 约定：
 * - start_url/scope 用根路径 "/"（origin 相对）：同一份 dist 先部署在 http://公网IP
 *   后迁移到 https://域名，manifest 均按当前 origin 解析，无需按 PUBLIC_URL 重构建；
 *   是否注册 SW 由运行时 /api/public/config 的 pwaEnabled 判断（§5.10），与 manifest 无关；
 * - 图标为占位自绘图（scripts/generate-icons.mjs 生成，学士帽风格与 favicon 一致），
 *   正式图标待用户提供后替换 public/icons/ 并重跑生成脚本。
 */

/** 主题色：与现有 favicon / Tailwind primary（indigo-600）一致 */
export const PWA_THEME_COLOR = "#4f46e5";

/**
 * vite-plugin-pwa 的 manifest 字段（透传给 web app manifest）。
 * 类型取 Partial<ManifestOptions> + 本配置必填的核心字段（Partial 是 VitePWA
 * 配置的入参形态；icons 收窄回非可选，测试可直接遍历）；字段正确性由
 * pwa-manifest.test.ts 钉死。
 */
export type PwaManifest = Partial<ManifestOptions> & {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  icons: NonNullable<ManifestOptions["icons"]>;
};

export const pwaManifest: PwaManifest = {
  name: "一对一辅导讲练",
  short_name: "辅导讲练",
  description: "一对一辅导老师的讲义与练习工具：看讲义、做作业、自动判分。",
  lang: "zh-CN",
  dir: "ltr",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "any",
  theme_color: PWA_THEME_COLOR,
  background_color: "#ffffff",
  icons: [
    {
      src: "/icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/maskable-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "maskable",
    },
    {
      src: "/icons/maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};
