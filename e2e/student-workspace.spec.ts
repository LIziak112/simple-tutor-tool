import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test("学生工作区：部分填写、遗漏定位、答题卡与响应式布局", async ({
  request,
  page,
}, testInfo) => {
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
  await expect(page.locator('[data-slot="attempt-bottom-bar"]')).toContainText(
    "已填写 0 / 2 题",
  );
  await page.getByRole("button", { name: "交卷", exact: true }).click();
  await page.getByRole("button", { name: /去补全第 1 题/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(first.getByLabel("第2空")).toBeFocused();
  for (const [index, value] of ["4", "6", "8"].entries()) {
    await first.getByLabel(`第${index + 2}空`).fill(value);
  }
  await expect(first.getByText("已填写", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="attempt-bottom-bar"]')).toContainText(
    "已填写 1 / 2 题",
  );
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
  await expect(page.locator('[data-slot="attempt-bottom-bar"]')).toContainText(
    "已填写 1 / 2 题",
  );
  for (const [width, height] of [
    [320, 800],
    [390, 844],
    [768, 1024],
    [810, 668],
    [1200, 900],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
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
});

test("130题长作业：答题卡独立滚动、跳到末题、待检查刷新恢复", async ({
  request,
  page,
}, testInfo) => {
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "答题卡", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(844);
  expect(bounds.height).toBeLessThanOrEqual(844 * 0.7 + 1);
  await dialog.getByRole("button", { name: /第 130 题，未填写/ }).click();
  const last = page.locator('article[aria-label="第 130 题"]');
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await last.getByRole("button", { name: "第 130 题更多" }).click();
  await page.getByRole("menuitemcheckbox", { name: "待检查" }).click();
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
    return JSON.parse(key ? (localStorage.getItem(key) ?? "null") : "null") as {
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
  await page.getByRole("button", { name: "答题卡", exact: true }).click();
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
            ).workspaceBlurListenerCount() === 1
          )
            readyFrames++;
          else readyFrames = 0;
          if (readyFrames >= 2) {
            clearTimeout(timeout);
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
  await page.getByRole("button", { name: "作答", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-input-enabled", "false");
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
    await expect(page.locator('canvas[data-input-enabled="true"]')).toHaveCount(
      1,
    );
    await page.getByRole("button", { name: "作答", exact: true }).click();
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
    const observer = new MutationObserver((records) => {
      unrelatedMutations += records.length;
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
      frameP95: intervals.sort((a, b) => a - b)[
        Math.floor(intervals.length * 0.95)
      ],
      moveCount: 60,
    };
  });
  expect(moveMetrics.unrelatedMutations).toBe(0);
  await page.getByRole("button", { name: "作答", exact: true }).click();
  const metrics = {
    browser: testInfo.project.name,
    questions: 130,
    network: "隔离本机API，无节流",
    firstOpenMs,
    warmMs,
    listenerCount: beforeListeners,
    rasterUploads: rasterCalls.length,
    ...moveMetrics,
  };
  const metricsPath = testInfo.outputPath("workspace-performance.json");
  await writeFile(metricsPath, JSON.stringify(metrics, null, 2), "utf8");
  await testInfo.attach("workspace-performance", {
    path: metricsPath,
    contentType: "application/json",
  });
  console.log("工作区实测", JSON.stringify(metrics));
  expect(Math.max(...warmMs)).toBeLessThanOrEqual(150);
  await page.getByRole("button", { name: "保存详情" }).click();
  await expect(page.getByRole("dialog", { name: "保存详情" })).toContainText(
    "标画：",
  );
  await page.screenshot({
    path: testInfo.outputPath("save-details-390.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "定位第 130 题" }).click();
  await expect(last).toBeFocused();
  expect(leak.violations()).toEqual([]);
});
