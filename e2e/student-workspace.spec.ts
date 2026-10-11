import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
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
  const unitName = `工作区练习${suffix}`;
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
  for (const width of [320, 390, 768, 810, 1200, 1440]) {
    await page.setViewportSize({ width, height: 900 });
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
  await page.goto("/s/home");
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
  expect(leak.violations()).toEqual([]);
});
