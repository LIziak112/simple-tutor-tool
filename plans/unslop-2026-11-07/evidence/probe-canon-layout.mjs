// 人工复核用的 DOM 临时去框对照与触屏几何；不持久化页面变更。
import { chromium } from "file:///C:/Users/HUAYU/Documents/github/simple-tutor-tool/node_modules/@playwright/test/index.mjs";
import fs from "node:fs";

const dir =
  "C:/Users/HUAYU/Documents/github/simple-tutor-tool/plans/unslop-2026-11-07/evidence";
const old =
  "C:/Users/HUAYU/AppData/Local/Temp/ownclass-unslop-evidence-20261107";
const prior = JSON.parse(fs.readFileSync(`${old}/results.json`, "utf8"));
const b = await chromium.launch({ channel: "msedge", headless: true });
const c = await b.newContext({
  baseURL: "http://127.0.0.1:5199",
  storageState: `${old}/student-state.json`,
  viewport: { width: 390, height: 844 },
  hasTouch: true,
});
const p = await c.newPage();
const results = [];
for (const route of [
  "/s/home",
  "/s/settings",
  "/s/records",
  "/s/settings/ai",
]) {
  await p.goto(route, { waitUntil: "networkidle" });
  results.push({
    case: "touch-render",
    route,
    scrollWidth: await p.evaluate(() => document.documentElement.scrollWidth),
  });
}
const review = prior.find(
  (r) =>
    r.role === "student" &&
    r.route.startsWith("/s/attempts/") &&
    r.small?.length === 0 &&
    r.width === 390,
).route;
const id = review.split("/")[3].split("?")[0];
await p.route(`**/api/student/attempts/${id}`, async (rr) => {
  const response = await rr.fetch();
  const body = await response.json();
  body.data.answersReleased = false;
  body.data.dueAt = new Date(Date.now() + 86400000).toISOString();
  await rr.fulfill({ response, json: body });
});
await p.goto(review, { waitUntil: "networkidle" });
const panel = p.locator('section[aria-label="交卷成功与待公布提示"]');
await p.screenshot({ path: `${dir}/nested-frames-before.png` });
results.push({
  case: "nested-frames",
  before: await panel.evaluate((el) =>
    [...el.querySelectorAll("div")]
      .filter(
        (e) =>
          getComputedStyle(e).borderTopStyle !== "none" &&
          parseFloat(getComputedStyle(e).borderTopWidth) > 0,
      )
      .map((e) => ({ class: e.className, text: e.innerText.slice(0, 50) })),
  ),
});
await panel.evaluate((el) => {
  for (const e of el.querySelectorAll("div")) {
    const cs = getComputedStyle(e);
    if (cs.borderTopStyle !== "none" && parseFloat(cs.borderTopWidth) > 0) {
      e.style.borderColor = "transparent";
      e.style.background = "transparent";
      e.style.boxShadow = "none";
      e.style.backdropFilter = "none";
    }
  }
});
await p.screenshot({ path: `${dir}/nested-frames-preview.png` });
const t = await b.newContext({
  baseURL: "http://127.0.0.1:5199",
  storageState: `${old}/teacher-state.json`,
  viewport: { width: 390, height: 844 },
  hasTouch: true,
});
const tp = await t.newPage();
await tp.goto("/t/library", { waitUntil: "networkidle" });
results.push({
  case: "touch-library-choice",
  pointer: await tp.evaluate(() => matchMedia("(pointer: coarse)").matches),
  controls: await tp
    .locator('input[type=checkbox][aria-label^="选择单元"]')
    .evaluateAll((es) =>
      es.map((e) => ({
        w: e.getBoundingClientRect().width,
        h: e.getBoundingClientRect().height,
        labels: e.labels.length,
      })),
    ),
});
fs.writeFileSync(
  `${dir}/canon-layout-probes.json`,
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
await b.close();
