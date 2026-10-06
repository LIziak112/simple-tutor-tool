import { expect, test } from "@playwright/test";

/**
 * T6R.6 独立渲染器 E2E（浏览器渲染测试）：/dev/ink 第 ④ 区块在真实
 * Chromium/WebKit canvas 里渲染固定文档并**解码自产 PNG** 做内容级检查
 * （背景入图、轻划落墨与零长笔画语义、荧光笔/擦除保真、长稿切片顺序与
 * 重叠、确定性双渲字节一致、缩略图规格）。jsdom 无 2d canvas——单测层只能
 * 做命令流断言（render-note.test.ts），本用例是任务验收「真实解码 PNG、
 * 不只验魔数」的自动化闸门。长稿小字可读性等观感项 🧑 留 iPad 真机。
 *
 * 断言口径（复审⑤）：检查以稳定 id 标识（面板 li[data-check-id]），本文件
 * 维护一份 id 镜像名单（spec 跑在 Node，不 import 面板模块——那会拖入
 * React 组件图）；文案变更不断言、id 变更须两侧同步。
 */

/** 面板检查 id 镜像名单（与 NoteRenderVerifyPanel.NOTE_RENDER_CHECK_IDS 对应） */
const EXPECTED_CHECK_IDS = [
  "bg-white",
  "bg-grid",
  "bg-line",
  "tap-ink",
  "zero-length",
  "highlighter",
  "erase",
  "slicing",
  "determinism",
  "thumbnail",
] as const;

test("渲染验证面板：全部检查通过（真实解码 PNG）", async ({ page }) => {
  await page.goto("/dev/ink");

  // 区块容器（id 在标题 h2 上，用 :has 定位所属 section）
  const panel = page.locator("section:has(#ink-sec-render)");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /运行渲染验证/ }).click();

  const items = panel.locator("li[data-verdict]");
  await expect(items).toHaveCount(EXPECTED_CHECK_IDS.length, {
    timeout: 60_000,
  });

  const fails = panel.locator("li[data-verdict='fail']");
  await expect(fails).toHaveCount(0);

  // 通过项的 id 集合与名单一致（解文案耦合：id 稳定，文案可改）
  const passIds = await panel
    .locator("li[data-verdict='pass']")
    .evaluateAll((lis) =>
      lis.map((li) => (li as HTMLElement).dataset.checkId ?? ""),
    );
  expect([...passIds].sort()).toEqual([...EXPECTED_CHECK_IDS].sort());
});
