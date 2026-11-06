// 规则补审取证：隔离演示服务、浏览器请求拦截与截图；不写应用源码。
import { chromium } from "file:///C:/Users/HUAYU/Documents/github/simple-tutor-tool/node_modules/@playwright/test/index.mjs";
import fs from "node:fs";

const baseURL = "http://127.0.0.1:5199";
const dir =
  "C:/Users/HUAYU/Documents/github/simple-tutor-tool/plans/unslop-2026-11-07/evidence";
const old =
  "C:/Users/HUAYU/AppData/Local/Temp/ownclass-unslop-evidence-20261107";
const b = await chromium.launch({ channel: "msedge", headless: true });
const t = await b.newContext({
  baseURL,
  storageState: `${old}/teacher-state.json`,
  viewport: { width: 1440, height: 900 },
});
const p = await t.newPage();
p.setDefaultTimeout(8000);
const findings = [];
const checkpoint = () => {
  fs.writeFileSync(
    `${dir}/canon-ui-probes.json`,
    JSON.stringify(findings, null, 2),
  );
  console.log(`已记录 ${findings.at(-1)?.case}`);
};
const rect = async (loc) =>
  loc.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      transform: s.transform,
      animation: s.animationName,
      duration: s.animationDuration,
      text: el.innerText?.slice(0, 100),
    };
  });
await p.goto("/t/settings", { waitUntil: "networkidle" });
const save = p.getByRole("button", { name: "保存更改", exact: true }).first();
findings.push({ case: "save-idle", value: await rect(save) });
await p.screenshot({ path: `${dir}/save-idle.png` });
let release;
const gate = new Promise((r) => (release = r));
await p.route("**/api/teacher/settings/capability-profile", async (route) => {
  if (route.request().method() === "PUT") {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { enabledCapabilities: ["steps", "ink"] },
      }),
    });
  } else await route.continue();
});
const sb = await save.boundingBox();
await p.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
await p.mouse.down();
findings.push({ case: "button-pressed", value: await rect(save) });
await p.screenshot({ path: `${dir}/button-pressed.png` });
await p.mouse.up();
await p.waitForTimeout(100);
findings.push({
  case: "save-pending",
  value: await rect(
    p.getByRole("button", { name: "保存更改", exact: true }).first(),
  ),
});
await p.screenshot({ path: `${dir}/save-pending.png` });
release();
await p.waitForTimeout(300);
await p.unroute("**/api/teacher/settings/capability-profile");
checkpoint();
await p.setViewportSize({ width: 390, height: 844 });
await p.goto("/t/students", { waitUntil: "networkidle" });
findings.push({
  case: "ordinary-monospace",
  elements: await p.locator("p.font-mono").evaluateAll((els) =>
    els.map((el) => ({
      text: el.innerText,
      font: getComputedStyle(el).fontFamily,
      cls: el.className,
    })),
  ),
});
await p.screenshot({ path: `${dir}/login-name-monospace.png` });
await p.getByRole("button", { name: "打开导航" }).click();
await p.waitForTimeout(50);
const drawer = p.locator("[data-slot=sheet-content]");
const openState = await rect(drawer);
await p.screenshot({ path: `${dir}/drawer-opening.png` });
await p.keyboard.press("Escape");
const closeState = await rect(drawer).catch(() => ({ unmounted: true }));
findings.push({ case: "drawer-interruption", openState, closeState });
await p.screenshot({ path: `${dir}/drawer-closing.png` });
checkpoint();
await p.goto("/t/library", { waitUntil: "networkidle" });
await p.emulateMedia({ reducedMotion: "reduce" });
await p
  .getByRole("button", { name: /文件夹.*更多操作/ })
  .first()
  .focus();
await p.keyboard.press("Enter");
findings.push({
  case: "reduced-motion-menu",
  value: await rect(p.locator("[data-slot=dropdown-menu-content]")).catch(
    (error) => ({ probeError: error.message.slice(0, 100) }),
  ),
});
await p.screenshot({ path: `${dir}/menu-reduced-motion.png` });
await p.keyboard.press("Escape");
checkpoint();
await p.goto("/t/import", { waitUntil: "networkidle" });
await p
  .getByRole("button", { name: /AI 出题助手/ })
  .click()
  .catch(() => {});
await p.screenshot({ path: `${dir}/ai-prompt-panel.png` });
await p.setViewportSize({ width: 1440, height: 900 });
await p.goto("/t/export", { waitUntil: "networkidle" });
await p.getByRole("checkbox").first().check();
await p.getByRole("button", { name: "下一步", exact: true }).click();
await p.screenshot({ path: `${dir}/export-content-step.png` });
findings.push({
  case: "export-content",
  text: (await p.locator("main").innerText()).slice(0, 4000),
});
const s = await b.newContext({
  baseURL,
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
findings.push({
  case: "ai-trigger",
  value: await sp
    .getByRole("button", { name: "AI 助教", exact: true })
    .first()
    .evaluate((el) => ({
      html: el.outerHTML,
      rect: el.getBoundingClientRect().toJSON(),
    })),
});
await sp.getByRole("button", { name: "AI 助教", exact: true }).first().click();
await sp.screenshot({ path: `${dir}/ai-help-open.png` });
findings.push({
  case: "ai-open-no-dispatch",
  text: (await sp.locator("main").innerText()).slice(-2800),
});
await sp.goto("/s/settings", { waitUntil: "networkidle" });
await sp.getByText("自定义求助快捷按钮", { exact: true }).click();
await sp.screenshot({ path: `${dir}/settings-disclosure-open.png` });
await sp.goto("/s/records", { waitUntil: "networkidle" });
await sp.evaluate(() => {
  document.documentElement.style.fontSize = "32px";
});
await sp.screenshot({ path: `${dir}/records-double-font.png` });
findings.push({
  case: "records-double-font",
  clientWidth: 390,
  scrollWidth: await sp.evaluate(() => document.documentElement.scrollWidth),
});
await sp.evaluate(() => {
  document.documentElement.style.fontSize = "";
});
// 在已提交的隔离夹具响应中，仅强制未公布投影；不引入任何真实外发或交卷动作。
const review = JSON.parse(fs.readFileSync(`${old}/results.json`, "utf8")).find(
  (r) =>
    r.role === "student" &&
    r.route.startsWith("/s/attempts/") &&
    r.small?.length === 0 &&
    r.width === 390,
).route;
const attemptId = review.split("/")[3].split("?")[0];
await sp.route(`**/api/student/attempts/${attemptId}`, async (rr) => {
  const response = await rr.fetch();
  const body = await response.json();
  body.data.answersReleased = false;
  body.data.dueAt = new Date(Date.now() + 86400000).toISOString();
  await rr.fulfill({ response, json: body });
});
await sp.goto(review, { waitUntil: "networkidle" });
await sp.screenshot({ path: `${dir}/pending-release-emoji.png` });
findings.push({
  case: "pending-release",
  fixture: "页面响应拦截：已提交卷改为未公布且明天截止，非真实发布状态",
  text: (await sp.locator("main").innerText()).slice(0, 4000),
});
fs.writeFileSync(
  `${dir}/canon-ui-probes.json`,
  JSON.stringify(findings, null, 2),
);
console.log(JSON.stringify(findings, null, 2));
await b.close();
