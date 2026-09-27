import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PWA_THEME_COLOR, pwaManifest } from "./pwa-manifest";

/**
 * PWA manifest 配置正确性测试（T2.12）：
 * 配置数据与 vite.config.ts 共用同一模块（pwa-manifest.ts），
 * 这里钉死关键字段与图标文件的真实存在，防止改配置时悄悄破坏可安装性。
 */

/** apps/web/public 根目录（按测试文件自身位置回溯 src/lib → ../../public，与 cwd 无关） */
const publicDir = resolve(import.meta.dirname, "..", "..", "public");

describe("pwaManifest（PWA manifest 配置）", () => {
  it("名称/展示方式/颜色符合约定", () => {
    expect(pwaManifest.name).toBe("一对一辅导讲练");
    expect(pwaManifest.short_name).toBe("辅导讲练");
    expect(pwaManifest.display).toBe("standalone");
    expect(pwaManifest.lang).toBe("zh-CN");
    expect(pwaManifest.theme_color).toBe(PWA_THEME_COLOR);
    expect(pwaManifest.background_color).toBe("#ffffff");
    expect(pwaManifest.description.length).toBeGreaterThan(0);
  });

  it("start_url/scope 为根路径（origin 相对，HTTP→HTTPS 迁移无需重构建）", () => {
    expect(pwaManifest.start_url).toBe("/");
    expect(pwaManifest.scope).toBe("/");
  });

  it("图标：any 与 maskable 都有 192/512，且文件真实存在于 public/", () => {
    const purposes = pwaManifest.icons.map((icon) => icon.purpose).sort();
    expect(purposes).toEqual(["any", "any", "maskable", "maskable"]);
    for (const icon of pwaManifest.icons) {
      const file = join(publicDir, icon.src);
      expect(existsSync(file), `缺少图标文件 ${icon.src}`).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(0);
    }
    expect(pwaManifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ]),
    );
  });
});
