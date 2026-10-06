import { expect, test } from "@playwright/test";

/**
 * T6R.6 独立渲染器 E2E（浏览器渲染测试）：/dev/ink 第 ④ 区块在真实
 * Chromium/WebKit canvas 里渲染固定文档并**解码自产 PNG** 做内容级检查
 * （背景入图、轻划落墨与零长笔画语义、荧光笔/擦除保真、长稿切片顺序与
 * 重叠、确定性双渲
 * 字节一致、缩略图规格）。jsdom 无 2d canvas——单测层只能做命令流断言
 * （render-note.test.ts），本用例是任务验收「真实解码 PNG、不只验魔数」
 * 的自动化闸门。长稿小字可读性等观感项 🧑 留 iPad 真机（面板文案已标注）。
 *
 * 断言口径：面板输出 li[data-verdict]，全部 pass 且行数与面板检查链一致
 * （10 项；面板增删检查须同步本文件）。
 */

/**
 * 面板检查链点名名单（与 NoteRenderVerifyPanel.runChecks 的检查名逐项
 * 对应）；项数即期望行数——增删检查只改这一份名单（复审⑥：计数单轨）。
 */
const NAMED_CHECKS = [
  "背景 white",
  "背景 grid",
  "背景 line",
  "轻划",
  "零长笔画",
  "荧光笔",
  "擦除",
  "长稿切片",
  "确定性",
  "缩略图",
] as const;

const EXPECTED_CHECK_COUNT = NAMED_CHECKS.length;

test("渲染验证面板：全部检查通过（真实解码 PNG）", async ({ page }) => {
  await page.goto("/dev/ink");

  // 区块容器（id 在标题 h2 上，用 :has 定位所属 section）
  const panel = page.locator("section:has(#ink-sec-render)");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /运行渲染验证/ }).click();

  const items = panel.locator("li[data-verdict]");
  await expect(items).toHaveCount(EXPECTED_CHECK_COUNT, { timeout: 60_000 });

  const fails = panel.locator("li[data-verdict='fail']");
  await expect(fails).toHaveCount(0);

  // 关键项逐条点名（防面板检查链被误删后行数断言仍侥幸通过）
  for (const namePart of [
    "背景 white",
    "背景 grid",
    "背景 line",
    "轻划",
    "荧光笔",
    "擦除",
    "长稿切片",
    "确定性",
    "缩略图",
  ]) {
    await expect(
      panel.locator("li[data-verdict='pass']", { hasText: namePart }),
    ).toHaveCount(1);
  }
});
