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

test(
  "选择题紧凑排版保留触控高度、长选项与草稿空间",
  {
    tag: ["@student"],
  },
  async ({ page, request }, testInfo) => {
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const title = `紧凑排版${suffix}`;
    const courseId = await createCourseViaApi(request, title);
    const longOption =
      "这是一段用于检查窄屏自然换行的长选项，包含完整的条件说明与推理过程，不能截断或省略正文。";
    const markdown = [
      "---",
      "kind: practice",
      `unit: ${title}`,
      "---",
      "",
      '::::question{type=choice difficulty=1 knowledge="数据结构"}',
      "可以用（ ）定义一个完整的数据结构。",
      "",
      "- [ ] 0.",
      "- [ ] 1.",
      "- [ ] 2.",
      "- [x] 3.",
      "::::",
      "",
      '::::question{type=multi difficulty=1 knowledge="数据结构"}',
      "选择符合条件的说明。",
      "",
      "- [x] 树",
      `- [ ] ${longOption}`,
      "- [x] $x^2 + y^2 = 1$",
      "::::",
    ].join("\n");
    const imported = await request.post("/api/teacher/import/commit", {
      data: { markdown, filename: `${title}.md`, courseId },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    await setCourseItemVisible(request, courseId, title, true);
    const loginName = `density-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: "紧凑排版测试生", loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await openChoicePractice(page, courseId, title, title);
    const first = page.getByRole("article", { name: "第 1 题", exact: true });
    const second = page.getByRole("article", { name: "第 2 题", exact: true });
    const options = first
      .getByRole("radiogroup", { name: "选项", exact: true })
      .locator("label");
    const checkDensity = async () => {
      await expect(options).toHaveCount(4);
      for (const option of await options.all()) {
        const box = await option.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
        expect(box?.height).toBeLessThanOrEqual(48);
      }
      for (const label of await first
        .locator('[role="radiogroup"] > label')
        .or(second.locator("fieldset > label"))
        .all()) {
        const offset = await label.evaluate((element) => {
          const letter = element.querySelector(":scope > span");
          if (!letter) throw new Error("缺少选项字母");
          const row = element.getBoundingClientRect();
          const glyph = letter.getBoundingClientRect();
          return Math.abs(glyph.y + glyph.height / 2 - row.y - row.height / 2);
        });
        expect(offset).toBeLessThanOrEqual(1);
      }
      const boxes = await Promise.all([
        first.boundingBox(),
        second.boundingBox(),
      ]);
      const [a, b] = boxes;
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      if (a && b) expect(b.y - a.y - a.height).toBeCloseTo(12, 0);
    };
    for (const width of [1440, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await checkDensity();
      await expect(second.getByText(longOption, { exact: true })).toBeVisible();
      expect(
        await second.evaluate((card) => card.scrollWidth <= card.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`compact-${width}.png`),
        fullPage: true,
      });
    }
    const longBox = await second
      .getByRole("checkbox")
      .nth(1)
      .locator("..")
      .boundingBox();
    expect(longBox?.height).toBeGreaterThan(48);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const paper = first.getByRole("button", { name: /^第 1 题草稿纸(?:（|$)/ });
    await paper.click();
    await checkDensity();
    await page.screenshot({
      path: testInfo.outputPath("compact-with-paper.png"),
      fullPage: true,
    });
    await paper.click();
    await options.nth(1).click();
    await expect(first.getByRole("radio").nth(1)).toBeChecked();
    await second.getByRole("checkbox").first().locator("..").click();
    await second.getByRole("checkbox").nth(2).locator("..").click();
    await expect(second.getByRole("checkbox").first()).toBeChecked();
    await expect(second.getByRole("checkbox").nth(2)).toBeChecked();
  },
);

test(
  "混合题型外框共享父列边缘，草稿偏好与助教开合后保持对齐",
  { tag: ["@student"] },
  async ({ page, request }, testInfo) => {
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
        page.getByRole("button", { name: "收起 AI 助教", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "收起 AI 助教", exact: true })
        .click();
      await aligned();
    }
  },
);
