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

test.use({ isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

test("桌面答题：紧凑页头、常驻导航、完整选项名称与稳定交卷操作区", async ({
  request,
  page,
}, testInfo) => {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `桌面界面课程${suffix}`;
  const unitName = `桌面练习${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  const markdown = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "---",
    "",
    ...Array.from({ length: 27 }, (_, index) =>
      [
        `::::question{type=${index === 1 ? "multi" : "choice"} difficulty=1 knowledge="桌面阅读"}`,
        `第 ${index + 1} 题：阅读下面的中英文条件，选择操作系统提供的接口。CPU 与设备可以并行工作；本题用于验证较长题干在桌面和窄屏下仍可完整阅读。`,
        "",
        "- [x] 系统调用",
        "- [ ] $1+1$",
        "- [ ] 中断",
        "- [ ] 原语",
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
  const loginName = `desktop-interface-${suffix}`;
  const created = await request.post("/api/teacher/students", {
    data: { displayName: "桌面界面测试生", loginName },
  });
  expect(created.ok()).toBe(true);
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  const leak = attachLeakMonitor(page);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await openChoicePractice(page, courseId, courseName, unitName, 27);
  const first = page.getByRole("article", { name: "第 1 题", exact: true });
  const second = page.getByRole("article", { name: "第 2 题", exact: true });
  await expect(
    first.getByRole("radio", { name: "选项 A 系统调用", exact: true }),
  ).toBeVisible();
  await expect(
    first.getByRole("radio", { name: /^选项 B/ }),
  ).toHaveAccessibleName(/选项 B.*1.*1/);
  await expect(
    second.getByRole("checkbox", { name: "选项 A 系统调用", exact: true }),
  ).toBeAttached();

  for (const width of [1024, 1118, 1200, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const navigator = page
      .locator("aside")
      .getByRole("navigation", { name: "答题卡" });
    await expect(navigator).toBeVisible();
    await expect(
      page.getByRole("button", { name: "答题卡", exact: true }),
    ).toBeHidden();
    const metrics = await page.evaluate(() => {
      const header = document
        .querySelector('[data-slot="attempt-header"]')
        ?.getBoundingClientRect();
      const stem = document.querySelector('[data-slot="question-surface"] p');
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        headerHeight: header?.height ?? 0,
        stemWidth: stem?.getBoundingClientRect().width ?? 0,
        fontSize: stem ? getComputedStyle(stem).fontSize : "",
      };
    });
    expect(metrics.overflow).toBe(false);
    expect(metrics.headerHeight).toBeLessThanOrEqual(96);
    expect(metrics.stemWidth).toBeLessThanOrEqual(720);
    expect(metrics.fontSize).toBe("16px");
    await page.screenshot({
      path: testInfo.outputPath(`desktop-${width}.png`),
    });
  }

  await first.getByText("系统调用", { exact: true }).click();
  await expect(
    first.getByRole("radio", { name: "选项 A 系统调用", exact: true }),
  ).toBeChecked();
  const selectedOption = first.getByRole("radio", {
    name: "选项 A 系统调用",
    exact: true,
  });
  await selectedOption.press("Space");
  const optionFocus = await selectedOption.evaluate((input) => {
    const style = getComputedStyle(input.closest("label") as HTMLLabelElement);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(optionFocus).toEqual({ style: "solid", width: "2px" });
  await page
    .locator("aside")
    .getByRole("button", { name: "下一道未答" })
    .click();
  await expect(second).toBeFocused();
  await second.getByText("系统调用", { exact: true }).click();
  await expect(
    second.getByRole("checkbox", { name: "选项 A 系统调用", exact: true }),
  ).toBeChecked();
  await second.getByText("系统调用", { exact: true }).click();
  await expect(
    second.getByRole("checkbox", { name: "选项 A 系统调用", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "交卷", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("还有 26 题没有作答");
  for (const [width, height] of [
    [1118, 668],
    [320, 740],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const visibleActions = await dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return [
        ...element.querySelectorAll('[data-slot="dialog-footer"] button'),
      ].every((button) => {
        const rect = button.getBoundingClientRect();
        return (
          rect.top >= bounds.top &&
          rect.bottom <= bounds.bottom &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight
        );
      });
    });
    expect(visibleActions).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`submit-${width}.png`) });
  }
  await dialog.getByRole("button", { name: "继续作答", exact: true }).click();

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator("aside")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "答题卡", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "答题卡", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate(
      (element) => getComputedStyle(element).animationDuration,
    ),
  ).toBe("0s");
  await dialog.getByRole("button", { name: "下一道未答" }).press("Tab");
  const focus = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement as Element);
    return {
      style: style.outlineStyle,
      width: style.outlineWidth,
      color: style.outlineColor,
    };
  });
  expect(focus.style).toBe("solid");
  expect(focus.width).toBe("2px");
  expect(focus.color).not.toContain("/ 0.5");
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  const highContrastFocus = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement as Element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(highContrastFocus).toEqual({ style: "solid", width: "2px" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(leak.violations()).toEqual([]);
});
