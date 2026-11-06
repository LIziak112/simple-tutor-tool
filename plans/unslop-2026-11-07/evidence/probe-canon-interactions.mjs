// 单独核查动画中断与折叠指示；所有操作限于隔离夹具和页面呈现。
import { chromium } from "file:///C:/Users/HUAYU/Documents/github/simple-tutor-tool/node_modules/@playwright/test/index.mjs";
import fs from "node:fs";

const dir =
  "C:/Users/HUAYU/Documents/github/simple-tutor-tool/plans/unslop-2026-11-07/evidence";
const old =
  "C:/Users/HUAYU/AppData/Local/Temp/ownclass-unslop-evidence-20261107";
const b = await chromium.launch({ channel: "msedge", headless: true });
const t = await b.newContext({
  baseURL: "http://127.0.0.1:5199",
  storageState: `${old}/teacher-state.json`,
  viewport: { width: 390, height: 844 },
});
const p = await t.newPage();
p.setDefaultTimeout(8000);
const results = [];
await p.goto("/t/students", { waitUntil: "networkidle" });
await p.getByRole("button", { name: "打开导航", exact: true }).click();
await p.waitForTimeout(50);
const read = () =>
  p.evaluate(() => {
    const e = document.querySelector("[data-slot=sheet-content]");
    return e
      ? {
          time: performance.now(),
          x: e.getBoundingClientRect().x,
          animation: getComputedStyle(e).animationName,
          duration: getComputedStyle(e).animationDuration,
        }
      : null;
  });
const before = await read();
await p.keyboard.press("Escape");
const after = await read();
results.push({ case: "drawer-fast-reverse", before, after });
await p.goto("/t/library", { waitUntil: "networkidle" });
await p.emulateMedia({ reducedMotion: "reduce" });
const trigger = p.locator('button[aria-label$="的更多操作"]').first();
await trigger.click();
const menu = p.locator("[data-slot=dropdown-menu-content]");
await menu.waitFor({ state: "visible" });
results.push({
  case: "menu-reduce",
  value: await menu.evaluate((el) => ({
    html: el.outerHTML.slice(0, 500),
    animation: getComputedStyle(el).animationName,
    duration: getComputedStyle(el).animationDuration,
    transform: getComputedStyle(el).transform,
  })),
});
await p.screenshot({ path: `${dir}/menu-reduced-motion-verified.png` });
await p.keyboard.press("Escape");
const s = await b.newContext({
  baseURL: "http://127.0.0.1:5199",
  storageState: `${old}/student-state.json`,
  viewport: { width: 390, height: 844 },
});
const sp = await s.newPage();
const route = JSON.parse(fs.readFileSync(`${old}/results.json`, "utf8")).find(
  (r) =>
    r.role === "student" &&
    r.route.startsWith("/s/assignments/") &&
    r.width === 390,
).route;
await sp.goto(route, { waitUntil: "networkidle" });
await sp.getByRole("button", { name: "AI 助教", exact: true }).first().click();
const summary = sp.locator("summary").filter({ hasText: "更多问法" });
await summary.scrollIntoViewIfNeeded();
const info = () =>
  summary.evaluate((el) => ({
    html: el.outerHTML,
    display: getComputedStyle(el).display,
    listStyle: getComputedStyle(el).listStyleType,
    before: getComputedStyle(el, "::before").content,
    after: getComputedStyle(el, "::after").content,
    svg: el.querySelectorAll("svg").length,
    open: el.parentElement.open,
  }));
const closed = await info();
await sp.screenshot({ path: `${dir}/more-presets-closed.png` });
await summary.click();
const opened = await info();
await sp.screenshot({ path: `${dir}/more-presets-open.png` });
results.push({ case: "more-presets-indicator", closed, opened });
await p.setViewportSize({ width: 390, height: 844 });
await p.emulateMedia({ reducedMotion: "no-preference" });
await p.goto("/t/settings", { waitUntil: "networkidle" });
const button = p.getByRole("button", { name: "保存更改", exact: true }).first();
await button.scrollIntoViewIfNeeded();
const box = await button.boundingBox();
await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await p.mouse.down();
results.push({
  case: "press-style",
  value: await button.evaluate((el) => ({
    translate: getComputedStyle(el).translate,
    scale: getComputedStyle(el).scale,
    transform: getComputedStyle(el).transform,
  })),
});
await p.mouse.move(0, 0);
await p.mouse.up();
fs.writeFileSync(
  `${dir}/canon-interaction-probes.json`,
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
await b.close();
