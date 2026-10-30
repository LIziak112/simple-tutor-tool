import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 讲练页目录与阅读位置（大厅 #16910 验收）：
 * - 目录入口在页面顶部工具栏（不再沉在正文末尾）：窄屏首屏可见、点开弹层、
 *   跳转后关闭弹层并聚焦正文标题，标题不被 sticky 工具栏遮住；
 * - 目录跟随真实滚动高亮当前节；桌面顶部按钮收起/展开左侧栏；
 * - 阅读位置：读到后面某一节后刷新页面，自动回到原位置（同一作答卷）。
 */

const SECTIONS = [
  "一、相反数的引入",
  "二、相反数的概念",
  "三、例题精讲",
  "四、随堂练习",
  "五、本讲小结",
] as const;

function lessonMarkdown(title: string, unit: string): string {
  return [
    "---",
    "kind: lesson",
    `unit: ${unit}`,
    "topic: 相反数与绝对值",
    "---",
    "",
    `# ${title}`,
    "",
    ...SECTIONS.flatMap((section, index) => [
      `## ${section}`,
      "",
      ...Array.from(
        { length: 10 },
        () =>
          "阅读正文：判断数量与符号，结合数轴理解相反数。先明确条件，再按步骤推理。\n",
      ),
      ...(index === 0
        ? [
            '::::question{type=judge difficulty=1 knowledge="引入"}',
            "$0$ 的相反数是 $0$。[[正确]]",
            "",
            ":::solution",
            "判断题详解：$0$ 的相反数是它本身。",
            ":::",
            "::::",
            "",
          ]
        : []),
    ]),
  ].join("\n");
}

test("讲练目录在顶部工具栏，阅读位置重进恢复", { tag: ["@student"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseId = await createCourseViaApi(request, `讲练目录课程${suffix}`);
  const title = `讲练目录测试${suffix}`;
  const imported = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: lessonMarkdown(title, `目录单元${suffix}`),
      filename: `${title}.md`,
      courseId,
    },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  const loginName = `lesson-outline-${suffix}`;
  const created = await request.post("/api/teacher/students", {
    data: { displayName: "讲练目录学生", loginName },
  });
  expect(created.ok()).toBe(true);
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);

  const leak = attachLeakMonitor(page);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await page.goto("/s/lectures");
  await page.getByRole("link", { name: `打开讲练 ${title}` }).click();
  await expect(
    page.getByRole("heading", { name: title, level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: `开始练习 ${title}` }).click();
  await page.waitForURL(/\/s\/lectures\/[^/]+\/lesson\/run/);
  const lessonUrl = page.url();
  await expect(
    page.getByRole("heading", { name: title, level: 1 }),
  ).toBeVisible();

  // —— 窄屏（iPad 竖屏 820px）：目录入口在顶部工具栏，首屏可见 ——
  const toolbar = page.getByRole("navigation", { name: "讲练页工具栏" });
  const tocTrigger = toolbar.getByRole("button", {
    name: "展开目录",
    exact: true,
  });
  await expect(tocTrigger).toBeVisible();
  await expect(tocTrigger).toBeInViewport();
  // 正文底部不再有目录按钮：滚到底部时唯一入口仍是顶部工具栏
  await page.evaluate(() =>
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "instant",
    }),
  );
  await expect(
    page.getByRole("button", { name: "展开目录", exact: true }),
  ).toHaveCount(1);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));

  // 目录跳转用即时滚动（减少动态效果）：位置断言不吃平滑动画的中间态
  await page.emulateMedia({ reducedMotion: "reduce" });
  await tocTrigger.click();
  const dialog = page.getByRole("dialog", { name: "讲练目录" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: SECTIONS[3] }).click();
  await expect(dialog).toBeHidden();
  const targetHeading = page.getByRole("heading", {
    name: SECTIONS[3],
    exact: true,
  });
  await expect(targetHeading).toBeInViewport();
  // 标题落在 sticky 工具栏下方，不被遮住
  await expect
    .poll(async () => {
      const [headingBox, toolbarBox] = await Promise.all([
        targetHeading.boundingBox(),
        toolbar.boundingBox(),
      ]);
      return headingBox !== null && toolbarBox !== null
        ? headingBox.y - (toolbarBox.y + toolbarBox.height)
        : -1;
    })
    .toBeGreaterThanOrEqual(-1);

  // —— 阅读位置：离开再回来（新导航，排除浏览器原生滚动恢复）回到第 4 节 ——
  await page.waitForTimeout(400);
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(400);
  await page.goto("/s/home");
  await page.goto(lessonUrl);
  await expect(
    page.getByRole("heading", { name: title, level: 1 }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 })
    .toBeGreaterThan(scrolled * 0.6);
  await expect(targetHeading).toBeInViewport();

  // —— 桌面：顶部按钮收起/展开左侧栏，目录随真实滚动高亮 ——
  await page.setViewportSize({ width: 1440, height: 900 });
  const outline = page.getByRole("navigation", { name: "讲练目录" });
  await expect(outline).toBeVisible();
  // 程序化滚动会让工具栏按阅读手势收起；反向滚动唤回后再点按钮
  await page.mouse.move(700, 200);
  await page.mouse.wheel(0, -120);
  await expect(toolbar).toHaveAttribute("data-reading-hidden", "false");
  await toolbar.getByRole("button", { name: "收起目录" }).click();
  await expect(outline).toHaveCount(0);
  await toolbar.getByRole("button", { name: "展开目录" }).click();
  await expect(outline).toBeVisible();
  await page
    .getByRole("heading", { name: SECTIONS[1], exact: true })
    .evaluate((element) =>
      element.scrollIntoView({ block: "start", behavior: "instant" }),
    );
  await expect(
    outline.getByRole("button", { name: SECTIONS[1], exact: true }),
  ).toHaveAttribute("aria-current", "location");

  await page.waitForTimeout(500);
  expect(leak.violations().join("\n")).toBe("");
});

function longLessonMarkdown(title: string, unit: string): string {
  const sections = Array.from(
    { length: 24 },
    (_, index) => `第${index + 1}节 目录滚动测试`,
  );
  return [
    "---",
    "kind: lesson",
    `unit: ${unit}`,
    "topic: 目录滚动",
    "---",
    "",
    `# ${title}`,
    "",
    ...sections.flatMap((section) => [
      `## ${section}`,
      "",
      "阅读正文：判断数量与符号，结合数轴理解相反数。先明确条件，再按步骤推理。",
      "",
    ]),
  ].join("\n");
}

test("移动端长目录可在弹层内下滑到最后一节", { tag: ["@student"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseId = await createCourseViaApi(request, `长目录课程${suffix}`);
  const title = `长目录测试${suffix}`;
  const imported = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: longLessonMarkdown(title, `长目录单元${suffix}`),
      filename: `${title}.md`,
      courseId,
    },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  const loginName = `lesson-long-outline-${suffix}`;
  const created = await request.post("/api/teacher/students", {
    data: { displayName: "长目录学生", loginName },
  });
  expect(created.ok()).toBe(true);
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);

  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/s/lectures");
  await page.getByRole("link", { name: `打开讲练 ${title}` }).click();
  await expect(
    page.getByRole("heading", { name: title, level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: `开始练习 ${title}` }).click();
  await page.waitForURL(/\/s\/lectures\/[^/]+\/lesson\/run/);

  const toolbar = page.getByRole("navigation", { name: "讲练页工具栏" });
  await toolbar.getByRole("button", { name: "展开目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "讲练目录" });
  await expect(dialog).toBeVisible();
  const list = dialog.locator("div.overflow-y-auto").first();
  const metrics = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  // 目录比弹层可视高度长：列表自身可滚（回归 #16969 目录无法下滑）
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  const documentScrollY = await page.evaluate(() => window.scrollY);

  await page.emulateMedia({ reducedMotion: "reduce" });
  const box = await dialog.boundingBox();
  if (box === null) throw new Error("目录弹层缺少几何信息");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let index = 0; index < 4; index += 1) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
  }
  // 滚轮只滚目录列表，正文不动
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(documentScrollY);

  const lastSection = dialog.getByRole("button", {
    name: "第24节 目录滚动测试",
    exact: true,
  });
  await expect(lastSection).toBeInViewport();
  await lastSection.click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "第24节 目录滚动测试", exact: true }),
  ).toBeInViewport();
});
