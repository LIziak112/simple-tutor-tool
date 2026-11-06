// 状态颜色按浏览器实际解析色值取样；只展开AI界面，不点击发送。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const make = (role) =>
  browser.newContext({
    baseURL: "http://127.0.0.1:5199",
    storageState: `C:/Users/HUAYU/AppData/Local/Temp/ownclass-unslop-evidence-20261107/${role}-state.json`,
    viewport: { width: 390, height: 844 },
  });
const teacher = await make("teacher");
const student = await make("student");
const tp = await teacher.newPage();
const sp = await student.newPage();
const results = [];
const check = async (name, run) => {
  try {
    results.push({ name, passed: true, value: await run() });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
  fs.writeFileSync(
    path.join(dir, "status-and-ai-browser.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(JSON.stringify(results.at(-1)));
};
const go = (page, route) => page.goto(route, { waitUntil: "networkidle" });
const allBadges = [];
async function colors(page, surface) {
  const values = await page
    .locator("span.rounded-full, span.rounded-md, span.rounded, a.rounded-md")
    .evaluateAll((elements) => {
      const ctx = document
        .createElement("canvas")
        .getContext("2d", { willReadFrequently: true });
      const rgba = (color) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data].map(
          (value) => value / 255,
        );
      };
      const over = (fg, bg) => [
        ...fg
          .slice(0, 3)
          .map((value, index) => value * fg[3] + bg[index] * (1 - fg[3])),
        1,
      ];
      const luminance = (rgb) =>
        rgb
          .slice(0, 3)
          .map((value) =>
            value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
          )
          .reduce(
            (sum, value, index) =>
              sum + value * [0.2126, 0.7152, 0.0722][index],
            0,
          );
      return elements
        .filter((element) =>
          ["未开始", "进行中", "已交卷", "已批改"].includes(
            element.textContent.trim(),
          ),
        )
        .map((element) => {
          const chain = [];
          for (let item = element; item; item = item.parentElement)
            chain.unshift(item);
          let background = [1, 1, 1, 1];
          for (const item of chain)
            background = over(
              rgba(getComputedStyle(item).backgroundColor),
              background,
            );
          const foreground = over(
            rgba(getComputedStyle(element).color),
            background,
          );
          const a = luminance(foreground);
          const b = luminance(background);
          return {
            label: element.textContent.trim(),
            foreground,
            background,
            contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        });
    });
  assert.ok(values.length, `${surface}没有状态样本`);
  assert.ok(
    values.every((value) => value.contrast >= 4.5),
    `${surface}文字对比度不足`,
  );
  allBadges.push(...values.map((value) => ({ ...value, surface })));
  return values;
}

try {
  for (const width of [390, 768, 1440]) {
    for (const [page, route, surface] of [
      [sp, "/s/assignments", "assignment-cards"],
      [sp, "/s/records", "student-records"],
      [tp, "/t/data", "teacher-records"],
      [tp, "/t/insights", "matrix"],
    ]) {
      await check(`${surface}-${width}`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await go(page, route);
        const value = await colors(page, surface);
        await page.screenshot({
          path: path.join(dir, `fixed-${surface}-${width}.png`),
        });
        return value;
      });
    }
    await check(`roster-${width}`, async () => {
      await tp.setViewportSize({ width, height: 900 });
      await go(tp, "/t/assignments");
      // 选原有多学生作业，避免新建单人未公布夹具缺少状态样本。
      const card = tp.locator("li").filter({ hasText: "开学摸底练习" }).first();
      await card.getByRole("button", { name: "编辑", exact: true }).click();
      await tp.getByRole("dialog").waitFor();
      await tp
        .getByRole("dialog")
        .getByText(/^(未开始|进行中|已交卷|已批改)$/)
        .first()
        .waitFor();
      const value = await colors(tp, "roster");
      await tp.screenshot({
        path: path.join(dir, `fixed-roster-${width}.png`),
      });
      await tp.keyboard.press("Escape");
      return value;
    });
  }
  await check("status-consistency", async () => {
    const grouped = {};
    for (const item of allBadges) {
      const key = JSON.stringify([item.foreground, item.background]);
      if (grouped[item.label])
        assert.equal(key, grouped[item.label], `${item.label}跨消费者颜色不同`);
      else grouped[item.label] = key;
    }
    assert.equal(Object.keys(grouped).length, 4);
    return {
      states: Object.keys(grouped),
      minimumContrast: Math.min(...allBadges.map((item) => item.contrast)),
      samples: allBadges.length,
    };
  });
  await check("ai-disclosure-and-icons", async () => {
    await sp.setViewportSize({ width: 390, height: 844 });
    await go(sp, "/s/assignments/927f76b0-3b9b-475b-b59d-d4ae27e4fd69");
    let created = 0;
    sp.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/api\/student\/ai\/.*tasks/.test(request.url())
      )
        created++;
    });
    const entry = sp
      .getByRole("button", { name: "AI 助教", exact: true })
      .first();
    assert.ok(!(await entry.locator("svg.lucide-sparkles").count()));
    assert.equal(await entry.locator("svg").count(), 1);
    await entry.click();
    const summary = sp.locator("summary").filter({ hasText: "更多问法" });
    await summary.waitFor();
    const arrow = summary.locator("svg");
    assert.equal(await arrow.getAttribute("aria-hidden"), "true");
    await summary.focus();
    await sp.keyboard.press("Enter");
    assert.equal(await summary.locator("..").getAttribute("open"), "");
    await sp.waitForTimeout(170);
    const opened = await arrow.evaluate(
      (element) => getComputedStyle(element).rotate,
    );
    assert.equal(opened, "180deg");
    await sp.screenshot({ path: path.join(dir, "fixed-ai-more-open.png") });
    await sp.keyboard.press("Space");
    assert.equal(await summary.locator("..").getAttribute("open"), null);
    assert.equal(created, 0);
    await sp.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await arrow.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    );
    assert.equal(reduced, "0s");
    await sp.emulateMedia({ reducedMotion: "no-preference" });
    await tp.setViewportSize({ width: 1440, height: 900 });
    await go(tp, "/t/import");
    const prompt = tp.getByRole("button", { name: /AI 出题助手/ });
    assert.ok(!(await prompt.locator("svg.lucide-sparkles").count()));
    await prompt.click();
    await tp.screenshot({ path: path.join(dir, "fixed-ai-prompt.png") });
    return { opened, reduced, createdTasks: created, purposeIcons: true };
  });
  await check("double-text-size", async () => {
    const samples = [];
    for (const [page, route] of [
      [tp, "/t/insights"],
      [
        sp,
        "/s/courses/24993439-c87c-46f7-b773-787099ee06b3/units/有理数随堂练习",
      ],
    ]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await go(page, route);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      assert.ok(scrollWidth <= 391, `${route}双倍字号横溢出`);
      await page.screenshot({
        path: path.join(dir, `fixed-double-text-${samples.length}.png`),
      });
      samples.push({ route, scrollWidth });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "";
      });
    }
    return samples;
  });
} finally {
  await browser.close();
}
assert.ok(
  results.every((result) => result.passed),
  "存在未通过项，见status-and-ai-browser.json",
);
