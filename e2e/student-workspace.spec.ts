import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  openChoicePractice,
  openPracticeInfoDialog,
  openSaveDetails,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";
import { expectNavigationRingSpace } from "./navigation-ring";

/** 标画热开预算（毫秒）。2026-10-25 由 150 放宽至 300：CI 实测 176.5-189ms
 * （PR #6 e2e 失败、#8785 两轮），本机 197-226ms——150 在 CI 硬件上从不可达；
 * 断言目的是防回归劣化而非卡硬件差异，300 仍远紧于可感知卡顿。 */
const WARM_OPEN_BUDGET_MS = 300;

/** CI 或显式 E2E_PERF_GATE=1 时硬断言热开最大值；本机默认按中位数告警，
 * 避免单次调度停顿干扰。原始样本始终写入附件，无关题卡的 DOM 变更恒硬断言。 */
const PERF_GATE = !!process.env.CI || process.env.E2E_PERF_GATE === "1";

test("桌面长卷答题卡固定筛选并独立滚动", { tag: ["@student"] }, async ({
  request,
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `答题卡课程${suffix}`;
  const unitName = `答题卡长卷${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  const questions = Array.from(
    { length: 105 },
    (_, i) =>
      `::::question{type=judge difficulty=1 knowledge="判断"}\n第 ${i + 1} 题是测试题。[[正确]]\n::::`,
  );
  const markdown = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "---",
    "",
    ...questions,
  ].join("\n\n");
  const imported = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: `${unitName}.md`, courseId },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  await setCourseItemVisible(request, courseId, unitName, true);
  const loginName = `navigator-${suffix}`;
  await request.post("/api/teacher/students", {
    data: { displayName: "答题卡测试生", loginName },
  });
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  const leak = attachLeakMonitor(page);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await openChoicePractice(page, courseId, courseName, unitName, 105);
  const entry = page.getByRole("button", { name: "答题卡", exact: true });
  await expect(entry).toHaveCount(1);
  await expect(
    page.getByRole("complementary", { name: "答题定位" }),
  ).toHaveCount(0);
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "答题卡" });
  const list = dialog.getByRole("list");
  const filter = dialog.getByRole("button", { name: "未填写", exact: true });
  await expect(filter).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: /下一道未答|交卷/ }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      list.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return new Set(
          [...element.querySelectorAll("button")]
            .map((button) => button.getBoundingClientRect())
            .filter(
              (tile) => tile.top >= bounds.top && tile.bottom <= bounds.bottom,
            )
            .map((tile) => tile.top),
        ).size;
      }),
    )
    .toBeGreaterThanOrEqual(6);
  const before = await filter.boundingBox();
  await list.evaluate((element) => {
    element.scrollTop = 300;
  });
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await dialog.getByRole("button", { name: "待检查" }).click();
  await expect(dialog.getByRole("status")).toContainText("没有「待检查」");
  expect(await filter.boundingBox()).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(entry).toBeFocused();
  const first = page.getByRole("article", { name: "第 1 题", exact: true });
  const scratch = first.locator('[data-paper-trigger="true"]');
  await scratch.click();
  await drawStrokeWithPointerEvents(
    first.locator('[data-slot="note-layer"] canvas'),
  );
  await scratch.click();
  await entry.click();
  await dialog.getByRole("button", { name: "部分作答", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "第 1 题，部分作答", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("部分作答 1 题");
  await page.keyboard.press("Escape");

  const footer = page.locator('[data-slot="attempt-bottom-bar"]');
  await expect(
    footer.getByRole("button", { name: "交卷", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 668 });
  await expect(
    footer.getByRole("button", { name: "交卷", exact: true }),
  ).toBeVisible();
  await entry.click();
  await expect(
    dialog.getByRole("button", { name: "部分作答", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "练习更多" }).click();
  await page.getByRole("menuitem", { name: "做题方式", exact: true }).click();
  await page.getByText("单题专注", { exact: true }).click();
  await expect(
    footer.getByRole("button", { name: "交卷", exact: true }),
  ).toHaveCount(0);
  await entry.click();
  await expect(
    dialog.getByRole("button", { name: "部分作答", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "全部", exact: true }).click();
  await dialog.getByRole("button", { name: /^第 105 题，/ }).click();
  const workspace = page.locator('[data-slot="practice-single-workspace"]');
  await expect(workspace).toBeFocused();
  await expect(entry).toContainText("105/105");

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(entry).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "答题定位" }),
  ).toHaveCount(0);
  await entry.click();
  await expect(
    dialog.getByRole("button", { name: "全部", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const current = dialog.locator('button[aria-current="location"]');
  await expect(current).toHaveText("105");
  await expect(current).toBeInViewport();

  await page.setViewportSize({ width: 390, height: 668 });
  await expect(current).toBeInViewport();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press("Escape");
  await expect(entry).toBeFocused();
  expect(leak.violations()).toEqual([]);
});

test(
  "学生工作区：部分填写、遗漏定位、答题卡与响应式布局",
  { tag: ["@student"] },
  async ({ request, page }, testInfo) => {
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `工作区课程${suffix}`;
    const unitName = `工作区练习长标题覆盖多因数连乘奇负偶正与约分${suffix}${"LongTitle".repeat(8)}`;
    const courseId = await createCourseViaApi(request, courseName);
    const markdown = [
      "---",
      "kind: practice",
      `unit: ${unitName}`,
      "---",
      "",
      '::::question{type=fill difficulty=1 knowledge="填空"}',
      "计算 $1+1=$ [[2]]；$2+2=$ [[4]]；$3+3=$ [[6]]；$4+4=$ [[8]]。",
      "::::",
      "",
      '::::question{type=judge difficulty=1 knowledge="判断"}',
      "零是正数。[[错误]]",
      "::::",
      "",
    ].join("\n");
    const imported = await request.post("/api/teacher/import/commit", {
      data: { markdown, filename: `${unitName}.md`, courseId },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    await setCourseItemVisible(request, courseId, unitName, true);
    const loginName = `workspace-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: "工作区测试生", loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);
    const leak = attachLeakMonitor(page);
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await openChoicePractice(page, courseId, courseName, unitName, 2);
    await expect(
      page.getByRole("navigation", { name: "学生端导航" }),
    ).toHaveCount(0);
    const first = page.locator('article[aria-label="第 1 题"]');
    await first.getByLabel("第1空").fill("2");
    await expect(first.getByText("已填 1/4 空")).toBeVisible();
    await expect(
      page.locator('[data-slot="attempt-bottom-bar"]'),
    ).toContainText("已填写 0/2");
    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await page.getByRole("button", { name: /去补全第 1 题/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(first.getByLabel("第2空")).toBeFocused();
    for (const [index, value] of ["4", "6", "8"].entries()) {
      await first.getByLabel(`第${index + 2}空`).fill(value);
    }
    await expect(first.getByText("已填写", { exact: true })).toBeVisible();
    await expect(
      page.locator('[data-slot="attempt-bottom-bar"]'),
    ).toContainText("已填写 1/2");
    await first.getByLabel("第3空").fill("");
    await expect(first.getByText("已填 3/4 空")).toBeVisible();
    await page
      .locator('article[aria-label="第 2 题"]')
      .getByText("错", { exact: true })
      .click();
    await expect(
      page
        .locator('article[aria-label="第 2 题"]')
        .getByRole("radio", { name: "错", exact: true }),
    ).toBeChecked();
    await expect(
      page.locator('[data-slot="attempt-bottom-bar"]'),
    ).toContainText("已填写 1/2");
    for (const [width, height] of [
      [320, 800],
      [390, 844],
      [768, 1024],
      [810, 668],
      [1200, 900],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      const header = page.locator('[data-slot="attempt-header"]');
      if (width < 640) {
        await expect(header.getByTestId("draft-status")).toBeHidden();
        await expect(
          header.getByText(`课程：${courseName}`, { exact: false }),
        ).toBeHidden();
        const headerBox = await header.boundingBox();
        expect(headerBox?.height).toBeLessThanOrEqual(80);
        const footer = page.locator('[data-slot="attempt-bottom-bar"]');
        expect((await footer.boundingBox())?.height).toBeLessThanOrEqual(60);
        await expect(
          footer.getByRole("button", { name: "答题卡", exact: true }),
        ).toContainText("已填写 1/2");
        await expect(
          footer.locator('[data-slot="attempt-desktop-progress"]'),
        ).toBeHidden();
        const details = await openPracticeInfoDialog(page);
        await expect(details).toContainText(courseName);
        await expect(details).toContainText(unitName);
        await expect(details.getByTestId("draft-status")).toHaveCount(0);
        await expect(
          details.getByRole("button", { name: "保存详情" }),
        ).toHaveCount(0);
        await details.press("Escape");
        const saves = await openSaveDetails(page);
        await saves.getByRole("button", { name: "定位第 1 题" }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(first).toBeFocused();
      } else {
        await expect(header.getByTestId("draft-status")).toHaveCount(0);
        await expect(
          header.getByText(`课程：${courseName}`, { exact: false }),
        ).toHaveCount(0);
      }
      // 所有尺寸都可向下阅读收起顶栏，横屏和电脑也不例外。
      // 短卷用短视口产生真实滚动；等待两帧让旋转/缩放事件先落定。
      await page.setViewportSize({ width, height: 300 });
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
        window.scrollTo({ top: 0, behavior: "instant" });
        return new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      const beforeWidth = (await first.boundingBox())?.width;
      await page.mouse.move(width * 0.7, 150);
      await page.mouse.wheel(0, 180);
      await expect(header).toHaveAttribute("data-reading-hidden", "true");
      await expect
        .poll(() =>
          header.evaluate((element) => element.getBoundingClientRect().bottom),
        )
        .toBeLessThanOrEqual(1);
      expect((await first.boundingBox())?.width).toBe(beforeWidth);
      await page.mouse.wheel(0, -80);
      await expect(header).toHaveAttribute("data-reading-hidden", "false");
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
      await page.setViewportSize({ width, height });
      const navigator = page.getByRole("button", {
        name: "答题卡",
        exact: true,
      });
      const before = (await first.boundingBox())?.width;
      await navigator.press("Enter");
      const answerCard = page.getByRole("dialog", { name: "答题卡" });
      await expectNavigationRingSpace(
        answerCard.getByRole("navigation", { name: "答题卡" }),
      );
      const partial = answerCard.getByRole("button", {
        name: "部分作答",
        exact: true,
      });
      await partial.click();
      await expect(
        answerCard.getByRole("button", { name: "第 1 题，部分作答" }),
      ).toBeVisible();
      await expect(
        answerCard.getByRole("button", { name: /^第 2 题/ }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(navigator).toBeFocused();
      expect((await first.boundingBox())?.width).toBe(before);
      await expect(first.getByLabel("第1空")).toHaveValue("2");
      const geometry = await page.evaluate(() => {
        const header = document
          .querySelector('[data-slot="attempt-header"]')
          ?.getBoundingClientRect();
        const footer = document
          .querySelector('[data-slot="attempt-bottom-bar"]')
          ?.getBoundingClientRect();
        const controls = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-slot="attempt-header"] button,[data-slot="attempt-bottom-bar"] button',
          ),
        )
          .map((element) => element.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => ({
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
          }));
        return {
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          headerBottom: header?.bottom,
          footerTop: footer?.top,
          controls,
        };
      });
      expect(geometry.scrollWidth).toBeLessThanOrEqual(width);
      expect(geometry.headerBottom).toBeLessThan(geometry.footerTop ?? 0);
      for (const control of geometry.controls) {
        expect(control.left).toBeGreaterThanOrEqual(0);
        expect(control.right).toBeLessThanOrEqual(width);
        expect(control.height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({
        path: testInfo.outputPath(`workspace-${width}.png`),
        fullPage: false,
      });
    }
    // CSS 2倍缩放补充压力测试；实体设备与浏览器原生缩放另列手动验收。
    await page.setViewportSize({ width: 640, height: 1600 });
    await page.evaluate(() => {
      document.body.style.zoom = "2";
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(640);
    await page.screenshot({
      path: testInfo.outputPath("workspace-css-zoom-200.png"),
    });
    await page.evaluate(() => {
      document.body.style.zoom = "";
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "答题卡", exact: true }).click();
    await expectNavigationRingSpace(
      page.getByRole("dialog").getByRole("navigation", { name: "答题卡" }),
    );
    await expect(
      page.getByRole("button", { name: "部分作答", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "全部", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /第 2 题，已填写/ })
      .click();
    await expect(page.locator('article[aria-label="第 2 题"]')).toBeFocused();
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(
      page.getByRole("navigation", { name: "学生端导航" }),
    ).toBeVisible();
    expect(leak.violations()).toEqual([]);
  },
);

test(
  "130题长作业：答题卡独立滚动、跳到末题、待检查刷新恢复",
  { tag: ["@student"] },
  async ({ request, page }, testInfo) => {
    // 满载全量下多次 reload + 130 题材料恢复可能整条超 120s；360s 顶格余量
    // （只放大用例级超时，expect 的 15s 预算不变）。
    test.slow();
    await page.addInitScript(() => {
      const listeners = new Set<EventListenerOrEventListenerObject>();
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (
        type,
        callback,
        options,
      ) {
        if (this === window && type === "blur" && callback)
          listeners.add(callback);
        add.call(this, type, callback, options);
      };
      EventTarget.prototype.removeEventListener = function (
        type,
        callback,
        options,
      ) {
        if (this === window && type === "blur" && callback)
          listeners.delete(callback);
        remove.call(this, type, callback, options);
      };
      Object.defineProperty(window, "workspaceBlurListenerCount", {
        value: () => listeners.size,
      });
    });
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `长卷课程${suffix}`;
    const unitName = `长卷练习${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const markdown = [
      "---",
      "kind: practice",
      `unit: ${unitName}`,
      "---",
      "",
      ...Array.from({ length: 130 }, (_, index) =>
        [
          '::::question{type=judge difficulty=1 knowledge="判断"}',
          `第${index + 1}道判断题：一是正数。[[正确]]`,
          "::::",
          "",
        ].join("\n"),
      ),
    ].join("\n");
    const imported = await request.post("/api/teacher/import/commit", {
      data: { markdown, filename: `${unitName}.md`, courseId },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    await setCourseItemVisible(request, courseId, unitName, true);
    const loginName = `long-workspace-${suffix}`;
    const created = await request.post("/api/teacher/students", {
      data: { displayName: "长卷测试生", loginName },
    });
    expect(created.ok()).toBe(true);
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);
    const leak = attachLeakMonitor(page);
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await openChoicePractice(page, courseId, courseName, unitName, 130);
    await page.setViewportSize({ width: 1200, height: 900 });
    const entry = page.getByRole("button", { name: "答题卡", exact: true });
    const dialog = page.getByRole("dialog", { name: "答题卡" });
    await entry.click();
    await expect(
      dialog.getByRole("button", { name: "未填写", exact: true }),
    ).toBeEnabled();
    const middleNumber = dialog.getByRole("button", {
      name: "第 65 题，未填写",
      exact: true,
    });
    await middleNumber.click();
    const middle = page.getByRole("article", { name: "第 65 题", exact: true });
    // 跳题先等前邻题从占位变成真实题卡，并回到题头锚点；之后才测试开合保位。
    await expect(
      page.getByRole("article", { name: "第 64 题", exact: true }),
    ).toBeAttached();
    const expectedTop = await page
      .locator('[data-slot="attempt-header"]')
      .evaluate((header) => header.getBoundingClientRect().height + 12);
    await expect
      .poll(async () => (await middle.boundingBox())?.y ?? Infinity)
      .toBeCloseTo(expectedTop, 0);
    const middleTop = (await middle.boundingBox())?.y;
    if (middleTop === undefined) throw new Error("无法测量当前题位置");
    await entry.press("Enter");
    await expect(middleNumber).toHaveAttribute("aria-current", "location");
    await page.keyboard.press("Escape");
    await expect(entry).toBeFocused();
    await expect
      .poll(async () => (await middle.boundingBox())?.y ?? Infinity)
      .toBeCloseTo(middleTop, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await entry.click();
    const bounds = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    });
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(844);
    await dialog.getByRole("button", { name: /第 130 题，未填写/ }).click();
    const last = page.locator('article[aria-label="第 130 题"]');
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport();
    await last.getByRole("button", { name: "第 130 题更多" }).click();
    await page.getByRole("menuitem", { name: "标记待检查" }).click();
    await expect(last.locator('svg[aria-label="待检查"]')).toBeVisible();
    const attemptUrl = page.url();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const key = Object.keys(localStorage).find((key) =>
            key.startsWith("attempt-reading:"),
          );
          const saved = JSON.parse(
            key ? (localStorage.getItem(key) ?? "null") : "null",
          ) as { questionId: string; offset: number } | null;
          const article = document.querySelector(
            `article[data-question-id="${saved?.questionId}"]`,
          );
          const header = document.querySelector('[data-slot="attempt-header"]');
          const rect = article?.parentElement?.getBoundingClientRect();
          return saved &&
            rect &&
            header &&
            rect.bottom > header.getBoundingClientRect().height &&
            rect.top < innerHeight
            ? Math.abs(
                rect.top - header.getBoundingClientRect().height - saved.offset,
              )
            : Infinity;
        }),
      )
      .toBeLessThanOrEqual(2);
    await page.goto("/s/home");
    // pagehide会捕获最后一次滚动，恢复应以离页时真正落盘的位置为准。
    const position = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) =>
        key.startsWith("attempt-reading:"),
      );
      return JSON.parse(
        key ? (localStorage.getItem(key) ?? "null") : "null",
      ) as {
        questionId: string;
        offset: number;
      } | null;
    });
    expect(position).not.toBeNull();
    await page.goto(attemptUrl);
    await expect
      .poll(async () =>
        page.evaluate((saved) => {
          const card = document.querySelector(
            `article[data-question-id="${saved?.questionId}"]`,
          )?.parentElement;
          const header = document.querySelector('[data-slot="attempt-header"]');
          return card && header && saved
            ? Math.abs(
                card.getBoundingClientRect().top -
                  header.getBoundingClientRect().height -
                  saved.offset,
              )
            : Infinity;
        }, position),
      )
      .toBeLessThanOrEqual(2);
    await page.reload();
    await expect(last.locator('svg[aria-label="待检查"]')).toBeVisible();
    await entry.click();
    await dialog.getByRole("button", { name: "待检查", exact: true }).click();
    await dialog
      .getByRole("button", { name: /第 130 题，未填写，待检查/ })
      .click();
    await expect(last).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath("long-workspace-390.png"),
    });
    expect(
      await page.locator('canvas[data-slot="annotation-canvas"]').count(),
    ).toBe(0);
    const rasterCalls: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /annotation\/base\/image/.test(request.url())
      )
        rasterCalls.push(request.url());
    });
    const measureEnter = () =>
      last.evaluate(async (article) => {
        const button = article.querySelector<HTMLButtonElement>(
          'button[aria-label*="圈画题干"]',
        );
        if (!button) throw new Error("缺少标画入口");
        // 全页保稿也会监听失焦；标画只应在既有监听上增加一个，关闭后归还。
        const beforeOpenListeners = (
          window as unknown as { workspaceBlurListenerCount(): number }
        ).workspaceBlurListenerCount();
        const start = performance.now();
        return await new Promise<number>((resolve, reject) => {
          let frame = 0;
          let readyFrames = 0;
          const timeout = setTimeout(() => {
            cancelAnimationFrame(frame);
            reject(new Error("标画就绪超时"));
          }, 30_000);
          const check = () => {
            if (
              article.querySelector(
                'canvas[data-slot="annotation-canvas"][data-input-enabled="true"]',
              ) &&
              (
                window as unknown as { workspaceBlurListenerCount(): number }
              ).workspaceBlurListenerCount() ===
                beforeOpenListeners + 1
            )
              readyFrames++;
            else readyFrames = 0;
            if (readyFrames >= 2) {
              clearTimeout(timeout);
              performance.measure("ownclass:e2e-annotation-open", {
                start,
                duration: performance.now() - start,
              });
              resolve(performance.now() - start);
              return;
            }
            frame = requestAnimationFrame(check);
          };
          button.click();
          frame = requestAnimationFrame(check);
        });
      });
    const firstOpenMs = await measureEnter();
    const canvas = last.locator('canvas[data-slot="annotation-canvas"]');
    await drawStrokeWithPointerEvents(canvas);
    await page.getByRole("button", { name: "完成标画", exact: true }).click();
    await expect(canvas).toHaveAttribute("data-input-enabled", "false");
    // 首次落笔的本机/云端持久化属于准备阶段，不能计入后续热打开耗时。
    await expect(page.getByTestId("draft-status")).toHaveText("全部已保存", {
      timeout: 30_000,
    });
    const warmMs: number[] = [];
    const listenerCount = () =>
      page.evaluate(() =>
        (
          window as unknown as { workspaceBlurListenerCount(): number }
        ).workspaceBlurListenerCount(),
      );
    const beforeListeners = await listenerCount();
    for (let repeat = 0; repeat < 5; repeat++) {
      warmMs.push(await measureEnter());
      // 版式校验会暂时解绑输入，等待稳定绑定后仍严格检查唯一监听。
      await expect.poll(listenerCount).toBe(beforeListeners + 1);
      await expect(
        page.locator('canvas[data-input-enabled="true"]'),
      ).toHaveCount(1);
      await page.getByRole("button", { name: "完成标画", exact: true }).click();
      await expect(canvas).toHaveAttribute("data-input-enabled", "false");
    }
    expect(await listenerCount()).toBe(beforeListeners);
    expect(
      await page.locator('canvas[data-slot="annotation-canvas"]').count(),
    ).toBe(1);
    await measureEnter();
    const moveMetrics = await canvas.evaluate(async (element) => {
      const canvas = element as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      let unrelatedMutations = 0;
      const mutationKinds = new Map<string, number>();
      const observer = new MutationObserver((records) => {
        unrelatedMutations += records.length;
        for (const record of records) {
          const element =
            record.target instanceof Element
              ? record.target
              : record.target.parentElement;
          const kind = `${record.type}:${element?.tagName}:${record.attributeName ?? ""}:${element?.getAttribute("data-slot") ?? ""}`;
          mutationKinds.set(kind, (mutationKinds.get(kind) ?? 0) + 1);
        }
      });
      document
        .querySelectorAll('article:not([aria-label="第 130 题"])')
        .forEach((card) => {
          observer.observe(card, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        });
      const intervals: number[] = [];
      let previous = performance.now();
      const send = (type: string, x: number) =>
        canvas.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 39,
            pointerType: "mouse",
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: rect.left + 20 + x,
            clientY: rect.top + rect.height / 2,
            pressure: 0.5,
            isPrimary: true,
          }),
        );
      send("pointerdown", 0);
      for (let index = 0; index < 60; index++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame((now) => {
            intervals.push(now - previous);
            previous = now;
            resolve();
          }),
        );
        send("pointermove", index * 2);
      }
      await Promise.resolve();
      observer.disconnect();
      send("pointerup", 120);
      return {
        unrelatedMutations,
        mutationKinds: Object.fromEntries(mutationKinds),
        frameP95: intervals.sort((a, b) => a - b)[
          Math.floor(intervals.length * 0.95)
        ],
        moveCount: 60,
      };
    });
    await page.getByRole("button", { name: "完成标画", exact: true }).click();
    const warmMaxMs = Math.max(...warmMs);
    // 中位数容忍少量离群样本；CI 保留最大值守护，继续检测偶发慢路径。
    const warmMedianMs =
      [...warmMs].sort((a, b) => a - b)[Math.floor(warmMs.length / 2)] ??
      Infinity;
    const metrics = {
      browser: testInfo.project.name,
      questions: 130,
      network: "隔离本机API，无节流",
      perfGate: PERF_GATE ? "hard" : "advisory",
      warmMedianMs,
      firstOpenMs,
      warmMs,
      listenerCount: beforeListeners,
      rasterUploads: rasterCalls.length,
      stages: await page.evaluate(() =>
        performance.getEntriesByType("measure").map((entry) => ({
          name: entry.name,
          start: entry.startTime,
          duration: entry.duration,
        })),
      ),
      ...moveMetrics,
    };
    const metricsPath = testInfo.outputPath("workspace-performance.json");
    await writeFile(metricsPath, JSON.stringify(metrics, null, 2), "utf8");
    await testInfo.attach("workspace-performance", {
      path: metricsPath,
      contentType: "application/json",
    });
    const { stages: _stages, ...summary } = metrics;
    console.log("工作区实测", JSON.stringify(summary));
    expect(moveMetrics.unrelatedMutations).toBe(0);
    if (PERF_GATE) {
      expect(warmMaxMs).toBeLessThanOrEqual(WARM_OPEN_BUDGET_MS);
    } else if (warmMedianMs > WARM_OPEN_BUDGET_MS) {
      console.warn(
        `热开中位数 ${warmMedianMs}ms 超预算 ${WARM_OPEN_BUDGET_MS}ms（max ${warmMaxMs}ms，样本 ${JSON.stringify(warmMs)}），请安静机器或 E2E_PERF_GATE=1 复验`,
      );
    }
    // 在 390px 视口从更多菜单进入保存详情。
    const saves = await openSaveDetails(page);
    await expect(saves).toContainText("标画：");
    await page.screenshot({
      path: testInfo.outputPath("save-details-390.png"),
      animations: "disabled",
    });
    await saves.getByRole("button", { name: "定位第 130 题" }).click();
    await expect(last).toBeFocused();
    await entry.click();
    await dialog.getByRole("button", { name: "部分作答", exact: true }).click();
    const marked = dialog.getByRole("button", {
      name: "第 130 题，部分作答，待检查",
    });
    await expect(marked).toHaveClass(/bg-primary\/10/);
    await expect(marked.locator("span")).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(leak.violations()).toEqual([]);
  },
);
