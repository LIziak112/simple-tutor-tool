// 使用隔离演示服务逐帧复核共享弹层；不触发业务写入。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  baseURL: "http://127.0.0.1:5199",
  storageState:
    "C:/Users/HUAYU/AppData/Local/Temp/ownclass-unslop-evidence-20261107/teacher-state.json",
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
const samples = [];
const box = (locator) =>
  locator.evaluate((element) => ({
    x: element.getBoundingClientRect().x,
    animation: getComputedStyle(element).animationName,
    transform: getComputedStyle(element).transform,
    transition: getComputedStyle(element).transitionDuration,
  }));
try {
  await page.goto("/t/students", { waitUntil: "networkidle" });
  const trigger = page.getByRole("button", { name: "打开导航", exact: true });
  await trigger.click();
  await page.waitForTimeout(50);
  const drawer = page.locator("[data-slot=sheet-content]");
  const before = await box(drawer);
  await page.keyboard.press("Escape");
  const after = await box(drawer).catch(() => ({ unmounted: true }));
  samples.push({ case: "reverse", before, after });
  await page.waitForTimeout(450);
  assert.equal(await drawer.count(), 0, "关闭后必须卸载");
  assert.equal(
    await page.evaluate(() => document.body.style.pointerEvents),
    "",
    "关闭后必须解除背景锁",
  );
  assert.equal(
    await trigger.evaluate((element) => element === document.activeElement),
    true,
    "焦点返回导航按钮",
  );
  await trigger.click();
  await page.waitForTimeout(220);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(20);
  // 关闭过程中重新打开同一受控抽屉，检查未留下透明遮罩。
  await page.waitForTimeout(230);
  await trigger.click();
  await page.waitForTimeout(220);
  assert.equal(await drawer.count(), 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(230);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/t/library", { waitUntil: "networkidle" });
  // 使用实际原生button的aria-label，避免把可排序行当成菜单触发者。
  const menuTrigger = page
    .locator('button[aria-label*="文件夹"][aria-label*="更多操作"]')
    .first();
  await menuTrigger.click();
  const menu = page.locator("[data-slot=dropdown-menu-content]");
  const reduced = await box(menu);
  samples.push({ case: "reduced-menu", value: reduced });
  await page.keyboard.press("Escape");
  fs.writeFileSync(
    path.join(dir, `overlay-${process.argv[2] ?? "check"}.json`),
    `${JSON.stringify(samples, null, 2)}\n`,
  );
  assert.equal(after.unmounted, undefined, "正常关闭应保留退出生命周期");
  assert.ok(
    after.x <= before.x + 25,
    `反向不应先跳到全开位置：${before.x} → ${after.x}`,
  );
  assert.ok(
    ["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(reduced.transform),
    "reduce菜单没有缩放",
  );
  assert.equal(reduced.animation, "none", "reduce菜单没有动画");
  console.log(JSON.stringify({ verified: true, samples }));
} finally {
  await browser.close();
}
