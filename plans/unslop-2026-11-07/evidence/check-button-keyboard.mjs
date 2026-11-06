import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5199",
    storageState:
      "C:/Users/HUAYU/AppData/Local/Temp/ownclass-unslop-evidence-20261107/student-state.json",
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto(
    "/s/courses/24993439-c87c-46f7-b773-787099ee06b3/units/有理数随堂练习",
    { waitUntil: "networkidle" },
  );
  await page.getByRole("button", { name: "再做一次", exact: true }).click();
  const cancel = page.getByRole("button", { name: "先不做", exact: true });
  await cancel.focus();
  // 先等待Dialog自身200ms入场结束，不能把弹窗缩放误算为按钮命中区变化。
  await page.waitForTimeout(250);
  const outer = await cancel.boundingBox();
  await page.keyboard.down("Space");
  await page.waitForTimeout(130);
  const inner = await cancel
    .locator('[data-slot="button-content"]')
    .evaluate((element) => ({
      transform: getComputedStyle(element).transform,
      justify: getComputedStyle(element).justifyContent,
      gap: getComputedStyle(element).gap,
      duration: getComputedStyle(element).transitionDuration,
    }));
  assert.match(inner.transform, /^matrix\(0\.96,/);
  assert.equal(inner.justify, "center");
  const pressed = await cancel.boundingBox();
  assert.deepEqual(pressed, outer);
  await page.keyboard.up("Space");
  await page
    .locator('[data-slot="dialog-content"]')
    .waitFor({ state: "detached" });
  await page.goto("/s/attempts/4189b824-c473-4a31-bb15-d9c5eca9ad31", {
    waitUntil: "networkidle",
  });
  const batch = page.getByRole("button", { name: "批量复盘", exact: true });
  await batch.waitFor();
  const batchIcon = await batch.locator("svg").getAttribute("class");
  assert.ok(!batchIcon.includes("sparkles"));
  await page.screenshot({ path: path.join(dir, "fixed-batch-review.png") });
  const teacher = await browser.newContext({
    baseURL: "http://127.0.0.1:5199",
    storageState:
      "C:/Users/HUAYU/AppData/Local/Temp/ownclass-unslop-evidence-20261107/teacher-state.json",
    viewport: { width: 1440, height: 900 },
  });
  const tp = await teacher.newPage();
  await tp.goto("/t/students/fd94d342-95f7-4409-8308-460c9037895e", {
    waitUntil: "networkidle",
  });
  await tp.getByRole("button", { name: /AI 报告/ }).click();
  const reports = tp.locator('section[aria-label="AI 报告"]');
  await reports.waitFor();
  assert.equal(await reports.locator("svg.lucide-file-text").count(), 1);
  const icons = await tp
    .locator("svg")
    .evaluateAll((elements) =>
      elements
        .map((element) => element.getAttribute("class"))
        .filter((value) => /file-text|file-down/.test(value)),
    );
  assert.ok(
    icons.some((value) => value.includes("file-text")) &&
      icons.some((value) => value.includes("file-down")),
  );
  await reports.scrollIntoViewIfNeeded();
  await tp.screenshot({ path: path.join(dir, "fixed-student-reports.png") });
  const result = {
    keyboardPress: inner,
    outer,
    pressed,
    batchIcon,
    reportAndExportIcons: icons,
    verified: true,
  };
  fs.writeFileSync(
    path.join(dir, "keyboard-and-purpose-icons.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
