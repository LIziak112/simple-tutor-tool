import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test("混合题型外框共享父列边缘，草稿偏好与助教开合后保持对齐", async ({
  page,
  request,
}, testInfo) => {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `题卡对齐课程${suffix}`;
  const unitName = `题卡对齐练习${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  const markdown = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "---",
    "",
    '::::question{type=fill difficulty=1 knowledge="极限"}',
    "求极限 $\\lim_{x\\to0}\\frac{\\sin x}{x}$，计算结果为 [[1]]。",
    "::::",
    "",
    '::::question{type=solve difficulty=1 knowledge="极限"}',
    "计算 $\\lim_{x\\to0}\\frac{1-\\cos x}{x^2}$，写出计算过程。",
    ":::answer",
    "1/2",
    ":::",
    "::::",
    "",
  ].join("\n");
  const imported = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: `${unitName}.md`, courseId },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  await setCourseItemVisible(request, courseId, unitName, true);
  const loginName = `alignment-${suffix}`;
  await request.post("/api/teacher/students", {
    data: { displayName: "题卡对齐测试生", loginName },
  });
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openChoicePractice(page, courseId, courseName, unitName);
  const first = page.getByRole("article", { name: "第 1 题", exact: true });
  const second = page.getByRole("article", { name: "第 2 题", exact: true });
  const aligned = async () => {
    // 与父列和相邻题比较几何，不依赖任何固定题卡宽度。
    await expect
      .poll(async () => {
        const boxes = await Promise.all([
          first.boundingBox(),
          second.boundingBox(),
        ]);
        const parent = await second.evaluate((article) =>
          article.parentElement?.getBoundingClientRect().toJSON(),
        );
        const [a, b] = boxes;
        if (!a || !b || !parent) return Number.POSITIVE_INFINITY;
        return Math.max(
          Math.abs(a.x - b.x),
          Math.abs(a.width - b.width),
          Math.abs(b.x - parent.x),
          Math.abs(b.width - parent.width),
        );
      })
      .toBeLessThan(1);
  };
  for (const width of [1440, 1143, 820, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await aligned();
    // 未生成标画底图的题面填满当前题列。
    await expect
      .poll(() =>
        first.evaluate((article) => {
          const row = article.querySelector('[data-slot="note-body-row"]');
          const surface = article.querySelector(
            '[data-slot="question-surface"]',
          );
          if (!row || !surface) return Number.POSITIVE_INFINITY;
          return Math.abs(
            row.getBoundingClientRect().width -
              surface.getBoundingClientRect().width,
          );
        }),
      )
      .toBeLessThan(1);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await aligned();
  await page.screenshot({
    path: testInfo.outputPath("aligned-question-cards.png"),
  });
  const paperTrigger = first.getByRole("button", {
    name: /^第 1 题草稿纸(?:（|$)/,
  });
  for (const layout of ["上下排列", "左右分栏", "自动（按宽度）"]) {
    await paperTrigger.click();
    await first
      .getByRole("button", { name: "更多操作（第 1 题草稿纸）" })
      .click();
    await page
      .getByRole("menuitem", { name: `布局：${layout}`, exact: true })
      .click();
    await aligned();
    await paperTrigger.click();
    await aligned();
  }
  for (const card of [second, first, second]) {
    await card.getByRole("button", { name: "AI 助教", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "关闭 AI 助教", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "关闭 AI 助教", exact: true })
      .click();
    await aligned();
  }
});
