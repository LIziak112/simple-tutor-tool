/**
 * PR #30 分栏材料工作区——三条浏览器实测驱动（修复单 #13028 挂账①证据脚本）。
 *
 * 用法（仓库根）：node e2e/manual/split-ink-verify.mjs
 * 前置：pnpm install 完成（用到 tsx / vite / @playwright/test 的 chromium）。
 * 自举：临时 DATA_DIR 起 server(:8899) + vite(:5199)，API 播种教师、单元
 * （1 份共享材料 + 1 个题组 3 题）、学生与课程；Playwright chromium 桌面
 * 视口（1440×900，lg 断点分栏生效）驱动真实页面。
 *
 * 三条场景（修复单 #13028 验收口径）：
 * ① 失配回原宽笔迹复显：首笔收笔冻结 → 中缝键盘移开（失配：笔迹隐藏 +
 *    「按圈画时排版查看」入口）→ 键盘等步移回原宽 → data-ink-visible 回
 *    true、入口消失；顺带验 E：回看态列宽复原自动退出；
 * ② 进出圈画态材料子树不重挂：children 元素上的 dataset 探针跨进出保持
 *    （重挂即丢）；
 * ③ 列表模式滚动不回顶：右列滚动材料列不动；显式跳题才平滑回顶。
 *
 * 产物：/workspace/output/pr30-verify/*.png + 控制台逐项 PASS/FAIL 结论。
 * 本脚本不进默认 e2e 套件（无 .spec 后缀，testDir 通配不匹配）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = new URL("../..", import.meta.url).pathname;
const SERVER_PORT = 8899;
const WEB_PORT = 5199;
const API = `http://127.0.0.1:${SERVER_PORT}`;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const SHOTS = "/workspace/output/pr30-verify";
mkdirSync(SHOTS, { recursive: true });

const results = [];
function report(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(
    `[verify] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` —— ${detail}` : ""}`,
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(url, label) {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 未就绪，继续等
    }
    await sleep(1000);
  }
  throw new Error(`等待超时：${label} ${url}`);
}

const dataDir = mkdtempSync(join(tmpdir(), "split-verify-"));
const procs = [];
function start(cmd, args, cwd, env, inherit) {
  const p = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: inherit ? "inherit" : ["ignore", "ignore", "inherit"],
  });
  procs.push(p);
  return p;
}

let cookie = "";
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0] ?? "";
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应原样带 null
  }
  return { status: res.status, json };
}

function unitMarkdown(unit) {
  const paras = Array.from(
    { length: 14 },
    (_, i) =>
      `第${i + 1}段：这是一段用于分栏阅读验证的长文本，用来撑起材料列的独立滚动高度，正文随列宽自然回流，圈画基准在首笔落笔时捕获。`,
  );
  return [
    "---",
    "kind: practice",
    `unit: ${unit}`,
    "topic: 分栏材料",
    "---",
    "",
    "# 分栏验证单元",
    "",
    "::::material{id=mat-1}",
    ":::seg{id=seg-1}",
    ...paras,
    ":::",
    "::::",
    "",
    '::::group{id=grp-1 title="材料组" label="1～3"}',
    "请阅读左侧材料后作答。",
    "",
    "::ref{material=mat-1}",
    "::ref{question=q-1}",
    "::ref{question=q-2}",
    "::ref{question=q-3}",
    "::::",
    "",
    '::::question{id=q-1 type=choice difficulty=1 knowledge="k"}',
    "第一题：本组材料共有多少段正文？（　）",
    "",
    "- [ ] 十三段",
    "- [x] 十四段",
    "- [ ] 十五段",
    "",
    ":::solution",
    "共十四段。",
    ":::",
    "::::",
    "",
    '::::question{id=q-2 type=judge difficulty=1 knowledge="k"}',
    "第二题：材料可以随中缝拖拽改变列宽。[[正确]]",
    "",
    ":::solution",
    "分栏中缝可拖。",
    ":::",
    "::::",
    "",
    '::::question{id=q-3 type=choice difficulty=1 knowledge="k"}',
    "第三题：以下哪种状态会隐藏旧笔迹？（　）",
    "",
    "- [x] 排版与圈画时不一致",
    "- [ ] 排版与圈画时一致",
    "- [ ] 从未圈画过",
    "",
    ":::solution",
    "不匹配即隐藏，禁静默叠。",
    ":::",
    "::::",
  ].join("\n");
}

async function seed() {
  const setup = await api("POST", "/api/public/teacher/setup", {
    loginName: "teacher",
    password: "e2e-teacher-pass",
  });
  if (setup.status !== 200 && setup.status !== 409) {
    throw new Error(`教师 setup 失败：${setup.status}`);
  }
  const unit = `分栏验证${Date.now().toString(36)}`;
  const commit = await api("POST", "/api/teacher/import/commit", {
    markdown: unitMarkdown(unit),
    filename: "split-verify.md",
  });
  if (!commit.status.toString().startsWith("2")) {
    throw new Error(
      `导入失败：${commit.status} ${JSON.stringify(commit.json)}`,
    );
  }
  const studentRes = await api("POST", "/api/teacher/students", {
    displayName: "验证学生",
    loginName: `vfystu${Date.now().toString(36)}`,
    password: "e2e-stu-pass",
  });
  const student = studentRes.json?.data?.student;
  if (!student?.id)
    throw new Error(`建学生失败：${JSON.stringify(studentRes.json)}`);
  const courseRes = await api("POST", "/api/teacher/courses", {
    title: "验证课程",
  });
  const courseId = courseRes.json?.data?.id;
  if (!courseId) throw new Error("建课程失败");
  await api("POST", `/api/teacher/courses/${courseId}/members`, {
    studentIds: [student.id],
  });
  await api("POST", `/api/teacher/courses/${courseId}/items`, {
    items: [{ kind: "unit", refId: unit }],
  });
  return { linkToken: student.linkToken, courseId };
}

async function main() {
  start(
    "node",
    ["node_modules/tsx/dist/cli.mjs", "src/index.ts"],
    join(ROOT, "apps/server"),
    { PORT: String(SERVER_PORT), DATA_DIR: dataDir, PUBLIC_URL: BASE },
    true,
  );
  await waitReady(`${API}/api/public/health`, "server");

  start(
    "node",
    [
      "node_modules/vite/bin/vite.js",
      "--port",
      String(WEB_PORT),
      "--strictPort",
    ],
    join(ROOT, "apps/web"),
    { DEV_API_PROXY_TARGET: API },
    false,
  );
  await waitReady(BASE, "vite");

  const { linkToken, courseId } = await seed();
  console.log(`[verify] world ready：courseId=${courseId}`);

  const browser = await chromium.launch({ channel: "chromium" });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  await page.goto(`${BASE}/s/${linkToken}`);
  await page.waitForURL("**/s/home");
  await page.goto(`${BASE}/s/courses/${courseId}`);
  // 点单元行进入练习（行内含单元名与「练习 · N 题」）
  const unitRow = page.getByText(/分栏验证/).first();
  await unitRow.waitFor({ state: "visible", timeout: 60_000 });
  await unitRow.click();
  const startButton = page.getByRole("button", { name: /开始练习/ });
  await startButton.waitFor({ state: "visible", timeout: 60_000 });
  await startButton.click();
  await page.waitForTimeout(6000);
  console.log("[verify] url after entry:", page.url());
  await page.screenshot({ path: join(SHOTS, "debug-after-entry.png") });
  // 等题组锚与材料列出现（vite 首编译较慢，超时放宽）
  await page.waitForSelector('[data-slot="question-group-anchor"]', {
    timeout: 120_000,
  });
  const materials = page.locator('[data-slot="group-materials"]').first();
  await materials.waitFor({ state: "visible" });
  const overlay = page
    .locator('[data-slot="material-annotation-overlay"]')
    .first();
  const live = page.locator('[data-slot="material-live-surface"]').first();
  await overlay.waitFor({ state: "visible" });
  console.log("[verify] attempt page loaded");
  await page.screenshot({ path: join(SHOTS, "00-loaded.png") });

  // ---------- 场景③：列表模式滚动不回顶 ----------
  await materials.evaluate((el) => {
    el.scrollTop = 300;
  });
  await sleep(200);
  const beforeScroll = await materials.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, 500);
  await sleep(800);
  const afterWindowScroll = await materials.evaluate((el) => el.scrollTop);
  report(
    "③a 右列滚动材料列不动",
    Math.abs(afterWindowScroll - beforeScroll) <= 5,
    `材料 scrollTop ${beforeScroll} → ${afterWindowScroll}`,
  );
  await page.screenshot({ path: join(SHOTS, "03a-window-scroll.png") });

  // 探针：记录材料列上的每次 scrollTo/scrollTop 写入（谁在滚、滚到哪）
  await page.evaluate(() => {
    const el = document.querySelector('[data-slot="group-materials"]');
    if (el === null) return;
    const log = [];
    window.__scrollLog = log;
    const orig = el.scrollTo.bind(el);
    el.scrollTo = (...args) => {
      log.push(`scrollTo(${JSON.stringify(args[0])})`);
      return orig(...args);
    };
    let cur = el.scrollTop;
    Object.defineProperty(el, "scrollTop", {
      get: () => cur,
      set: (v) => {
        log.push(`scrollTop= ${v}`);
        cur = Number(v);
      },
      configurable: true,
    });
  });
  const navButton = page.getByRole("button", { name: /答题卡/ }).first();
  if (await navButton.isVisible().catch(() => false)) {
    await navButton.click();
    await sleep(600);
    await page.screenshot({ path: join(SHOTS, "03b-navigator.png") });
    const item2 = page
      .getByRole("button", { name: /^\s*第\s*2\s*题\s*$/ })
      .first();
    if (await item2.isVisible().catch(() => false)) {
      await item2.click();
    } else {
      await page
        .getByText(/第\s*2\s*题/)
        .first()
        .click();
    }
    for (const [label, gap] of [
      ["+0.3s", 300],
      ["+1.0s", 700],
      ["+2.5s", 1500],
      ["+4.0s", 1500],
    ]) {
      await sleep(gap);
      console.log(
        `[verify] ③b scrollTop ${label} =`,
        await materials.evaluate((el) => el.scrollTop),
      );
    }
    const afterJump = await materials.evaluate((el) => el.scrollTop);
    const scrollLog = await page.evaluate(() => window.__scrollLog ?? []);
    console.log(`[verify] ③b scroll ops: ${JSON.stringify(scrollLog)}`);
    report(
      "③b 显式跳题材料回顶",
      afterJump <= 5,
      `跳题后 scrollTop=${afterJump}`,
    );
    await page.screenshot({ path: join(SHOTS, "03b-jump-top.png") });
  } else {
    report("③b 显式跳题材料回顶", false, "找不到「答题卡」按钮");
  }

  // ---------- 场景②：进出圈画态材料子树不重挂 ----------
  await live.evaluate((el) => {
    el.dataset.probe = "keep-me";
  });
  const annoButton = page.getByRole("button", { name: /圈画/ }).first();
  await annoButton.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-slot="material-annotation-overlay"]')
        ?.getAttribute("data-drawing") === "true",
    undefined,
    { timeout: 30_000 },
  );
  const probeIn = await live.getAttribute("data-probe");
  await live
    .locator(">> nth=0")
    .waitFor({ state: "visible" })
    .catch(() => {});
  // 画一笔：材料列先回顶（滚动位会让包围盒跑出视口），以输入层可见区域取点
  await materials.evaluate((el) => {
    el.scrollTop = 0;
  });
  await sleep(300);
  const inputLayer = page
    .locator('[data-slot="material-annotation-input"]')
    .first();
  const box = await inputLayer.boundingBox();
  if (box === null) throw new Error("输入层不可见");
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      box.x + box.width / 2 - 60 + i * 15,
      box.y + 120 + (i % 2 ? 6 : -6),
      { steps: 2 },
    );
  }
  await page.mouse.up();
  await sleep(800);
  const strokeCount = await overlay.getAttribute("data-stroke-count");
  const inkReady = await overlay.getAttribute("data-ink-ready");
  console.log(
    `[verify] stroke debug: count=${strokeCount} ready=${inkReady} url=${page.url()}`,
  );
  await page.screenshot({ path: join(SHOTS, "02-annotating.png") });
  await annoButton.click(); // 退出圈画态
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-slot="material-annotation-overlay"]')
        ?.getAttribute("data-drawing") === "false",
    undefined,
    { timeout: 30_000 },
  );
  const probeOut = await live.getAttribute("data-probe");
  report(
    "② 进出圈画态材料子树不重挂",
    probeIn === "keep-me" && probeOut === "keep-me",
    `进=${probeIn} 出=${probeOut}`,
  );

  // ---------- 场景①：失配回原宽笔迹复显（冻结已随首笔建立） ----------
  // 退出圈画态后回到原宽：应直接匹配自显
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-slot="material-annotation-overlay"]')
        ?.getAttribute("data-ink-visible") === "true",
    undefined,
    { timeout: 15_000 },
  );
  const handle = page.locator('[role="separator"]').first();
  await handle.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowLeft");
  await sleep(600);
  const inkHidden = await overlay.getAttribute("data-ink-visible");
  const reviewButton = page.getByRole("button", { name: "按圈画时排版查看" });
  const entryShown = await reviewButton.isVisible().catch(() => false);
  report(
    "①a 拖窄后笔迹隐藏并给只读入口",
    inkHidden === "false" && entryShown,
    `data-ink-visible=${inkHidden} 入口=${entryShown}`,
  );
  await page.screenshot({ path: join(SHOTS, "01a-mismatch.png") });

  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await sleep(800);
  const inkRestored = await overlay.getAttribute("data-ink-visible");
  const entryGone = !(await reviewButton.isVisible().catch(() => false));
  report(
    "①b 拖回原宽笔迹复显、入口消失",
    inkRestored === "true" && entryGone,
    `data-ink-visible=${inkRestored} 入口消失=${entryGone}`,
  );
  await page.screenshot({ path: join(SHOTS, "01b-restored.png") });

  // ---------- 顺带验 E：回看态列宽复原自动退出 ----------
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowLeft");
  await sleep(600);
  if (await reviewButton.isVisible().catch(() => false)) {
    await reviewButton.click();
    await sleep(400);
    const frame = page.locator('[data-slot="material-ink-frame"]').first();
    const frameWidth = await frame.evaluate((el) => el.style.width);
    await page.screenshot({ path: join(SHOTS, "01c-review-mode.png") });
    await handle.focus(); // 点击按钮后焦点已移走，方向键须重新作用于中缝
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
    await sleep(800);
    const frameWidthAfter = await frame.evaluate((el) => el.style.width);
    report(
      "E 回看态列宽复原自动退出",
      frameWidth !== "" && frameWidthAfter === "",
      `回看框宽=${frameWidth} → 复原后=${frameWidthAfter || "(空)"}`,
    );
  } else {
    report("E 回看态列宽复原自动退出", false, "失配入口未出现");
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(
    `[verify] 完成：${results.length - failed.length}/${results.length} 项通过；截图在 ${SHOTS}`,
  );
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("[verify] 异常终止：", err);
    process.exitCode = 2;
  })
  .finally(() => {
    for (const p of procs) {
      try {
        p.kill("SIGTERM");
      } catch {
        // 已退出
      }
    }
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
  });
