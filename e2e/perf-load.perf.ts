import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  getStudentViaApi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 性能取证（蓝小鲸，2026-10-28）：习题/讲义加载与交互开销。
 * 只用于本地测量，不提交。生产构建（preview）+ 临时 DB。
 * 场景：10 题 / 130 题（短题干）/ 130 题（带选项+公式+解析）/ 长讲义。
 * 指标：首卡可见、末卡挂载、长任务、CDP 主线程耗时、DOM 节点、API 体积与耗时、
 *       切题耗时、滚动帧间隔。
 */

function plainQuestion(index: number): string {
  return `::::question{type=judge difficulty=1 knowledge="判断"}\n第${index + 1}道判断题：一是正数。[[正确]]\n::::\n`;
}

function richQuestion(index: number): string {
  return [
    `::::question{type=choice difficulty=2 knowledge="选择"}`,
    `第${index + 1}题：已知 $a=${index + 1}$，求 $\\frac{a}{2}+\\sqrt{a^2}$ 的值，下列选项正确的是？`,
    "",
    "- [ ] $\\frac{a}{2}$",
    "- [x] $\\frac{3a}{2}$",
    "- [ ] $a^2$",
    "- [ ] $2a$",
    "",
    ":::solution",
    `解析：代入 $a=${index + 1}$ 计算即可。`,
    ":::",
    "::::",
    "",
  ].join("\n");
}

function questionsMarkdown(count: number, rich: boolean): string {
  const unit = `测量练习-${count}-${rich ? "rich" : "plain"}`;
  return [
    "---",
    "kind: practice",
    `unit: ${unit}`,
    "---",
    "",
    ...Array.from({ length: count }, (_, i) =>
      rich ? richQuestion(i) : plainQuestion(i),
    ),
  ].join("\n");
}

function lectureMarkdown(sections: number): string {
  const title = "长讲义性能测试";
  return [
    "---",
    "kind: lecture",
    "---",
    "",
    `# ${title}`,
    "",
    ...Array.from({ length: sections }, (_, i) =>
      [
        `## 第 ${i + 1} 讲：绝对值与分类讨论`,
        "",
        ...Array.from(
          { length: 8 },
          () =>
            "阅读正文：判断数量与符号，结合数轴理解绝对值。先明确条件，再按步骤推理，最后回到原题检验。\n",
        ),
        "用 $|x|$ 表示距离，$\\sqrt{a^2}=|a|$。",
        "",
        "- 要点一：先定符号，再算数值。",
        "- 要点二：分类讨论要穷尽。",
        "",
      ].join("\n"),
    ),
  ].join("\n");
}

type LoadMetrics = {
  scenario: string;
  viewport: string;
  cpuRate: number;
  firstCardMs: number | null;
  lastCardMs: number | null;
  nowMs: number;
  nav: { ttfb: number; domContentLoaded: number; load: number };
  longTasks: { count: number; totalMs: number; maxMs: number };
  api: Array<{
    url: string;
    status: number;
    bytes: number;
    durationMs: number;
  }>;
  apiTotalBytes: number;
  apiTotalMs: number;
  domNodes: number;
  /** 首卡可见那一刻的 DOM 节点数（懒挂载后的「第一眼」口径） */
  firstScreenDomNodes: number | null;
  htmlBytes: number;
  heapBytes: number | null;
  cdp: Record<string, number>;
};

async function measureLoad(
  page: import("@playwright/test").Page,
  scenario: string,
  url: string,
  lastLabel: string | null,
  cpuRate: number,
  waitSelector?: string,
): Promise<LoadMetrics & { attachNowMs: number | null }> {
  const api: LoadMetrics["api"] = [];
  const onResponse = async (r: import("@playwright/test").Response) => {
    const u = r.url();
    if (!u.includes("/api/")) return;
    try {
      const body = await r.body();
      api.push({
        url: u.replace(/^https?:\/\/[^/]+/, ""),
        status: r.status(),
        bytes: body.length,
        // 从请求发起到响应体可读的耗时（本地链路，含服务端处理）
        durationMs: Math.round(r.request().timing().responseEnd),
      });
    } catch {
      // 响应体不可读（重定向等）不计
    }
  };
  page.on("response", onResponse);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __long: number[];
      __perfInstalled?: boolean;
    };
    // 同一文档只装一次：多次 addInitScript 会在每次导航后各挂一个 observer，
    // 造成 longtask 重复计数（首版实测踩过）。
    if (w.__perfInstalled === true) return;
    w.__perfInstalled = true;
    w.__long = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          w.__long.push(Math.round(e.duration));
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* 不支持 longtask 时留空 */
    }
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });

  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  let firstCardMs: number | null = null;
  let attachNowMs: number | null = null;
  let firstScreenDomNodes: number | null = null;
  if (waitSelector !== undefined) {
    await page
      .locator(waitSelector)
      .first()
      .waitFor({ state: "visible", timeout: 180_000 });
  }
  if (lastLabel !== null) {
    const first = page.locator('article[aria-label="第 1 题"]');
    await first.waitFor({ state: "visible", timeout: 180_000 });
    firstCardMs = Date.now() - t0;
    // 首屏快照：视口懒挂载后，「用户第一眼看到」的成本要单独记
    firstScreenDomNodes = await page.evaluate(
      () => document.getElementsByTagName("*").length,
    );
    // 懒挂载：末题不会在首屏挂载，滚动到底触发挂载
    const last = page.locator(`article[aria-label="${lastLabel}"]`);
    for (let i = 0; i < 600; i++) {
      if ((await last.count()) > 0) break;
      await page.evaluate(() =>
        window.scrollBy(0, Math.round(window.innerHeight * 0.8)),
      );
      await page.waitForTimeout(100);
    }
    await last.first().waitFor({ state: "attached", timeout: 60_000 });
    attachNowMs = await page.evaluate(() => Math.round(performance.now()));
  }
  const lastCardMs = lastLabel === null ? null : Date.now() - t0;

  const data = await page.evaluate(() => {
    const nav = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming;
    const w = window as unknown as { __long: number[] };
    const mem = (
      performance as unknown as { memory?: { usedJSHeapSize: number } }
    ).memory;
    return {
      nowMs: Math.round(performance.now()),
      nav: {
        ttfb: Math.round(nav.responseStart),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
        load: Math.round(nav.loadEventEnd),
      },
      longTasks: w.__long ?? [],
      domNodes: document.getElementsByTagName("*").length,
      htmlBytes: document.documentElement.outerHTML.length,
      heapBytes: mem?.usedJSHeapSize ?? null,
    };
  });
  const perf = await cdp.send("Performance.getMetrics");
  const cdpMap: Record<string, number> = {};
  for (const m of perf.metrics) {
    if (
      [
        "TaskDuration",
        "ScriptDuration",
        "LayoutDuration",
        "RecalcStyleDuration",
        "JSHeapUsedSize",
        "Nodes",
      ].includes(m.name)
    ) {
      cdpMap[m.name] = Math.round(m.value * 1000) / 1000;
    }
  }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  page.off("response", onResponse);
  const longTasks = data.longTasks;
  return {
    scenario,
    viewport: `${page.viewportSize()?.width}x${page.viewportSize()?.height}`,
    cpuRate,
    firstCardMs,
    lastCardMs,
    nowMs: data.nowMs,
    nav: data.nav,
    longTasks: {
      count: longTasks.length,
      totalMs: longTasks.reduce((a, b) => a + b, 0),
      maxMs: longTasks.length > 0 ? Math.max(...longTasks) : 0,
    },
    api,
    apiTotalBytes: api.reduce((a, b) => a + b.bytes, 0),
    apiTotalMs: api.reduce((a, b) => a + b.durationMs, 0),
    domNodes: data.domNodes,
    firstScreenDomNodes,
    htmlBytes: data.htmlBytes,
    heapBytes: data.heapBytes,
    cdp: cdpMap,
    attachNowMs,
  };
}

async function measureScroll(
  page: import("@playwright/test").Page,
): Promise<{ p50: number; p95: number; max: number; frames: number }> {
  const intervals = await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const out: number[] = [];
    let prev = performance.now();
    for (let i = 0; i < 60; i++) {
      window.scrollBy(0, 500);
      await new Promise<void>((resolve) =>
        requestAnimationFrame((t) => {
          out.push(t - prev);
          prev = t;
          resolve();
        }),
      );
    }
    return out;
  });
  const sorted = [...intervals].sort((a, b) => a - b);
  return {
    p50: Math.round(sorted[Math.floor(sorted.length * 0.5)] ?? 0),
    p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    frames: intervals.length,
  };
}

test("perf: 习题与讲义加载", async ({ request, page }, testInfo) => {
  test.setTimeout(900_000);
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const results: Record<string, unknown> = { runs: [] as unknown[] };
  const runs = results.runs as unknown[];

  const student = await (async () => {
    const loginName = `perf-${suffix}`;
    const created = await request.post("/api/teacher/students", {
      data: { displayName: "性能测试生", loginName },
    });
    if (!created.ok()) throw new Error(await created.text());
    return getStudentViaApi(request, loginName);
  })();

  // PERF_FILTER（逗号分隔的场景名）：只跑指定习题场景并跳过讲义，便于限时
  // 内的定向前后对照；不设则全量。
  const allScenarios: Array<{ name: string; count: number; rich: boolean }> = [
    { name: "10题", count: 10, rich: false },
    { name: "130题-短题干", count: 130, rich: false },
    { name: "130题-带选项公式", count: 130, rich: true },
  ];
  const filter = (process.env.PERF_FILTER ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const scenarios =
    filter.length === 0
      ? allScenarios
      : allScenarios.filter((scenario) => filter.includes(scenario.name));

  for (const scenario of scenarios) {
    const courseTitle = `${scenario.name}-${suffix}`;
    const courseId = await createCourseViaApi(request, courseTitle);
    await addCourseMemberViaApi(request, courseId, student.id);
    const markdown = questionsMarkdown(scenario.count, scenario.rich);
    const imported = await request.post("/api/teacher/import/commit", {
      data: { markdown, filename: `${courseTitle}.md`, courseId },
    });
    if (!imported.ok()) throw new Error(await imported.text());
    const body = (await imported.json()) as {
      data: { units: Array<{ id: string }> };
    };
    const unitId = body.data.units[0]?.id;
    if (unitId === undefined) throw new Error("缺少 unit");
    const assigned = await request.post("/api/teacher/assignments", {
      data: {
        unitIds: [unitId],
        studentIds: [student.id],
        title: `测量-${scenario.name}`,
        courseId,
      },
    });
    if (!assigned.ok()) throw new Error(await assigned.text());
    const assignmentBody = (await assigned.json()) as {
      data: { assignments: Array<{ id: string }> };
    };
    const assignmentId = assignmentBody.data.assignments[0]?.id;
    if (assignmentId === undefined) throw new Error("缺少 assignment");
    const url = `/s/assignments/${assignmentId}`;

    // 学生会话（链接登录一次，后续复用 cookie）
    if (!page.url().includes("/s/")) {
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
    }

    for (const [vp, cpu] of [
      [{ width: 390, height: 844 }, 4],
      [{ width: 1280, height: 900 }, 1],
    ] as const) {
      await page.setViewportSize(vp);
      const m = await measureLoad(
        page,
        `${scenario.name}@${vp.width}`,
        url,
        `第 ${scenario.count} 题`,
        cpu,
      );
      runs.push({ kind: "load", ...m });
      console.log(
        `LOAD ${scenario.name} ${vp.width}px cpu${cpu}x first=${m.firstCardMs ?? "-"}ms last=${m.lastCardMs ?? "-"}ms nodes=${m.domNodes} firstNodes=${m.firstScreenDomNodes ?? "-"} api=${(m.apiTotalBytes / 1024).toFixed(0)}KB script=${m.cdp.ScriptDuration}s task=${m.cdp.TaskDuration}s longtasks=${m.longTasks.count}/${m.longTasks.totalMs}ms`,
      );
      if (vp.width === 390 && scenario.rich) {
        const scrollMobile = await measureScroll(page);
        runs.push({
          kind: "scroll",
          scenario: `${scenario.name}@390`,
          ...scrollMobile,
        });
        console.log(
          `SCROLL ${scenario.name}@390 p50=${scrollMobile.p50}ms p95=${scrollMobile.p95}ms max=${scrollMobile.max}ms`,
        );
      }
      if (vp.width === 1280) {
        const scroll = await measureScroll(page);
        runs.push({ kind: "scroll", scenario: scenario.name, ...scroll });
        console.log(
          `SCROLL ${scenario.name} p50=${scroll.p50}ms p95=${scroll.p95}ms max=${scroll.max}ms`,
        );
      }
    }
  }

  // 讲义：短 vs 长（定向过滤时不跑）
  for (const sections of filter.length === 0 ? [5, 40, 120] : []) {
    const courseTitle = `讲义-${sections}-${suffix}`;
    const courseId = await createCourseViaApi(request, courseTitle);
    await addCourseMemberViaApi(request, courseId, student.id);
    const md = lectureMarkdown(sections);
    const imported = await request.post("/api/teacher/import/commit", {
      data: { markdown: md, filename: `${courseTitle}.md`, courseId },
    });
    if (!imported.ok()) throw new Error(await imported.text());
    const body = (await imported.json()) as {
      data: { lectures: Array<{ id: string }> };
    };
    const lectureId = body.data.lectures[0]?.id;
    if (lectureId === undefined) throw new Error("缺少 lecture");
    const url = `/s/lectures/${lectureId}?courseId=${courseId}`;
    await page.setViewportSize({ width: 390, height: 844 });
    const m = await measureLoad(
      page,
      `讲义-${sections}节@390`,
      url,
      null,
      4,
      "article h1, h1",
    );
    runs.push({ kind: "load", ...m });
    console.log(
      `LECTURE ${sections} sections ${(md.length / 1024).toFixed(0)}KB now=${m.nowMs}ms nodes=${m.domNodes} script=${m.cdp.ScriptDuration}s longtasks=${m.longTasks.count}/${m.longTasks.totalMs}ms`,
    );
  }

  const out = `/workspace/output/perf-load-${suffix}.json`;
  writeFileSync(out, JSON.stringify(results, null, 2), "utf8");
  await testInfo.attach("perf-load", {
    path: out,
    contentType: "application/json",
  });
  console.log(`WROTE ${out}`);
});
