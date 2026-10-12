import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/** 长讲义阅读导航：真实浏览器、临时数据库，不使用用户的开发端口。 */
test("长讲义的返回、章节目录、窄屏焦点与导航恢复", async ({
  request,
  page,
}, testInfo) => {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseId = await createCourseViaApi(request, `讲义导航课程${suffix}`);
  const title = `长讲义阅读测试${suffix}`;
  const chapters = [
    "导学",
    "第一讲：绝对值方程与符号组合求和（原卷第 1 题）",
    "第二讲：数轴与绝对值",
    "第三讲：分类讨论",
    "总结",
    ...Array.from(
      { length: 12 },
      (_, index) => `拓展第 ${index + 1} 讲：数轴分析与分类讨论`,
    ),
  ] as const;
  const markdown = [
    "---",
    "kind: lecture",
    "---",
    "",
    `# ${title}`,
    "",
    ...chapters.flatMap((chapter) => [
      `## ${chapter}`,
      "",
      ...Array.from(
        { length: 12 },
        () =>
          "阅读正文：判断数量与符号，结合数轴理解绝对值。先明确条件，再按步骤推理。\n",
      ),
      "### 一、母题精讲",
      "",
      "用 $|x|$ 表示距离。",
      "",
      "### 二、巩固练习",
      "",
      "结合例题回顾知识。",
      "",
    ]),
  ].join("\n");
  const imported = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: `${title}.md`, courseId },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  const loginName = `lecture-navigation-${suffix}`;
  const created = await request.post("/api/teacher/students", {
    data: { displayName: "讲义阅读学生", loginName },
  });
  expect(created.ok()).toBe(true);
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  const leak = attachLeakMonitor(page);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await page.goto(`/s/courses/${courseId}`);
  await page.getByRole("link", { name: `阅读讲义 ${title}` }).click();
  const lectureUrl = page.url();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("navigation", { name: "学生端导航" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: title, level: 1 }),
  ).toHaveCount(1);
  const outline = page.getByRole("navigation", { name: "讲义目录" });
  await expect(outline).toBeVisible();

  // 目录比视口长：随正文阅读定位小节，独立目录应居中而不推动正文。
  await page.setViewportSize({ width: 1440, height: 650 });
  const laterChapter = chapters[10];
  if (!laterChapter) throw new Error("缺少长目录验收章节");
  await page
    .getByRole("heading", { name: laterChapter, exact: true })
    .evaluate((element) =>
      element.scrollIntoView({ block: "start", behavior: "instant" }),
    );
  await expect(
    outline.getByRole("button", { name: laterChapter, exact: true }),
  ).toHaveAttribute("aria-current", "location");
  async function centeringError() {
    return outline.evaluate((nav) => {
      const container = nav.parentElement;
      const selected = nav.querySelector('[aria-current="location"]');
      if (!container || !selected) return Number.POSITIVE_INFINITY;
      const itemBox = selected.getBoundingClientRect();
      const box = container.getBoundingClientRect();
      const desired =
        container.scrollTop +
        itemBox.top +
        itemBox.height / 2 -
        box.top -
        container.clientTop -
        container.clientHeight / 2;
      const clamped = Math.max(
        0,
        Math.min(desired, container.scrollHeight - container.clientHeight),
      );
      return Math.abs(clamped - container.scrollTop);
    });
  }
  await expect.poll(centeringError).toBeLessThan(3);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const laterGroup = outline.getByRole("group", {
    name: laterChapter,
    exact: true,
  });
  await laterGroup
    .getByRole("button", { name: "一、母题精讲", exact: true })
    .click();
  await expect(
    laterGroup.getByRole("button", { name: "一、母题精讲", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await expect.poll(centeringError).toBeLessThan(3);
  await page.screenshot({
    path: testInfo.outputPath("lecture-outline-centered.png"),
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const positionBefore = await page.evaluate(() => window.scrollY);
  // 展开其他目录章只改变目录高度；收起整个侧栏会改变正文宽度，不能拿来验证滚动隔离。
  await outline
    .getByRole("button", { name: `展开${chapters[0]}的子目录`, exact: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(centeringError).toBeLessThan(3);
  expect(await page.evaluate(() => window.scrollY)).toBe(positionBefore);
  await page.getByRole("button", { name: "收起目录", exact: true }).click();
  await page.getByRole("button", { name: "展开目录", exact: true }).click();
  await expect.poll(centeringError).toBeLessThan(3);
  await outline.getByRole("button", { name: chapters[2], exact: true }).click();
  const target = page.getByRole("heading", { name: chapters[2], exact: true });
  await expect(target).toBeFocused();
  await expect(
    outline.getByRole("button", { name: chapters[2], exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await expect
    .poll(async () => (await target.boundingBox())?.y ?? -1)
    .toBeGreaterThan(60);
  await expect(
    page.getByRole("link", { name: "返回课程目录" }),
  ).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("lecture-desktop.png") });
  // 真实滚动会更新目录，而不仅仅是点击后改选中样式。
  await page
    .getByRole("heading", { name: chapters[3], exact: true })
    .evaluate((element) =>
      element.scrollIntoView({ block: "start", behavior: "instant" }),
    );
  await expect(
    outline.getByRole("button", { name: chapters[3], exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await page.getByRole("button", { name: "收起目录", exact: true }).click();
  await expect(outline).toHaveCount(0);
  await page.getByRole("button", { name: "展开目录", exact: true }).click();
  await expect(outline).toBeVisible();

  for (const width of [390, 320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(lectureUrl);
    await expect(outline).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: title, level: 1 }),
    ).toBeInViewport();
    const trigger = page.getByRole("button", { name: "展开目录", exact: true });
    await trigger.press("Enter");
    const dialog = page.getByRole("dialog", { name: "讲义目录" });
    await expect(dialog).toBeVisible();
    await dialog.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    // 长目录独立滚动，底部章节不能被弹层裁掉。
    for (const chapter of chapters) {
      const expand = dialog.getByRole("button", {
        name: `展开${chapter}的子目录`,
        exact: true,
      });
      if (await expand.count()) await expand.click();
    }
    const lastChapter = dialog.getByRole("button", {
      name: chapters[4],
      exact: true,
    });
    await lastChapter.scrollIntoViewIfNeeded();
    await expect(lastChapter).toBeInViewport();
    if (width === 390)
      await page.screenshot({
        path: testInfo.outputPath("lecture-mobile-outline.png"),
      });
    await dialog
      .getByRole("button", { name: chapters[2], exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(target).toBeFocused();
    await expect
      .poll(async () => (await target.boundingBox())?.y ?? -1)
      .toBeGreaterThan(60);
    await expect(
      page.getByRole("link", { name: "返回课程目录" }),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`lecture-${width}.png`),
    });
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect.poll(centeringError).toBeLessThan(3);
    await dialog.press("Escape");
  }

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(lectureUrl);
  await outline.getByRole("button", { name: chapters[2], exact: true }).click();
  await expect(target).toBeFocused();
  const toolbar = page.getByRole("navigation", { name: "讲义阅读工具栏" });
  const toolbarBox = await toolbar.boundingBox();
  const headingBox = await target.boundingBox();
  expect(headingBox?.y).toBeGreaterThanOrEqual(toolbarBox?.height ?? 0);
  // 200% 文字放大；真正的浏览器页面缩放另列为手动验收项。
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await outline.getByRole("button", { name: chapters[1], exact: true }).click();
  await expect(
    page.getByRole("link", { name: "返回课程目录" }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("lecture-text-200.png") });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });

  await page.getByRole("link", { name: "返回课程目录" }).click();
  await page.waitForURL(`**/s/courses/${courseId}`);
  await expect(
    page.getByRole("navigation", { name: "学生端导航" }),
  ).toBeVisible();
  await page.getByRole("link", { name: `阅读讲义 ${title}` }).click();
  await page.goto(page.url().split("?")[0] ?? "");
  await page.getByRole("link", { name: "返回讲义列表" }).click();
  await page.waitForURL("**/s/lectures");
  expect(leak.violations()).toEqual([]);
});
