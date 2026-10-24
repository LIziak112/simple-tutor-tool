import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test(
  "本题导出：纯题面、收起草稿、隐藏标画仍完整，资料同排且菜单图标一致",
  { tag: ["@export"] },
  async ({ page, request }, testInfo) => {
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const title = `本题导出${suffix}`;
    const courseId = await createCourseViaApi(request, title);
    const imported = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: choiceJudgePracticeMarkdown(title),
        filename: `${title}.md`,
        courseId,
      },
    });
    expect(imported.ok()).toBe(true);
    await setCourseItemVisible(request, courseId, title, true);
    const loginName = `export-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: "导出测试生", loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);
    const leak = attachLeakMonitor(page);
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await openChoicePractice(page, courseId, title, title);
    const card = page.locator('article[aria-label="第 1 题"]');
    const more = card.getByRole("button", { name: "第 1 题更多" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await more.click();
    const items = page.getByRole("menuitem");
    for (const item of await items.all())
      await expect(item.locator("svg")).toHaveCount(1);
    await page.getByRole("menuitem", { name: "显示题目资料" }).click();
    const heading = await card
      .getByText("第 1 题", { exact: true })
      .boundingBox();
    const difficulty = await card
      .getByRole("img", { name: /难度/ })
      .boundingBox();
    expect(Math.abs((heading?.y ?? 0) - (difficulty?.y ?? 0))).toBeLessThan(12);
    await page.screenshot({
      path: testInfo.outputPath("question-header-wide.png"),
    });
    const exportCurrent = async () => {
      await more.click();
      await page.getByRole("menuitem", { name: "导出本题" }).click();
      const preview = page.getByRole("img", { name: "本题导出预览" });
      await expect(preview).toBeVisible();
      return preview;
    };
    const plain = await exportCurrent();
    const plainHeight = await plain.evaluate(
      (element) => (element as HTMLImageElement).naturalHeight,
    );
    await page.getByRole("button", { name: "关闭弹层" }).click();
    // 纯题面导出没有创建标画绑定；圈画前仍无笔迹标记。
    await expect(
      card.getByRole("button", { name: "第 1 题圈画题干" }),
    ).toBeVisible();
    await card.getByRole("button", { name: "第 1 题草稿纸" }).click();
    const canvas = card.locator(
      '[data-slot="note-paper"] canvas[data-slot="ink-canvas"]',
    );
    await expect(canvas).toBeVisible();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        /\/notes\//.test(response.url()) &&
        response.ok(),
    );
    await drawStrokeWithPointerEvents(canvas);
    await saved;
    await card.getByRole("button", { name: /收起/ }).click();
    const scratch = await exportCurrent();
    await expect(page.getByText("题面、草稿", { exact: true })).toBeVisible();
    const scratchPixels = await scratch.evaluate(
      async (element, baselineHeight) => {
        const image = element as HTMLImageElement;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("画布不可用");
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(
          0,
          baselineHeight,
          canvas.width,
          canvas.height - baselineHeight,
        ).data;
        let ink = 0;
        for (let i = 0; i < data.length; i += 4)
          if (
            (data[i] ?? 255) < 120 &&
            (data[i + 1] ?? 255) < 120 &&
            (data[i + 2] ?? 255) < 120
          )
            ink++;
        return { height: canvas.height, ink };
      },
      plainHeight,
    );
    expect(scratchPixels.height).toBeGreaterThan(plainHeight);
    expect(scratchPixels.ink).toBeGreaterThan(10);
    await page.screenshot({
      path: testInfo.outputPath("question-with-scratch.png"),
    });
    await page.getByRole("button", { name: "关闭弹层" }).click();
    await card.getByRole("button", { name: "第 1 题圈画题干" }).click();
    await drawStrokeWithPointerEvents(
      card.locator('canvas[data-slot="annotation-canvas"]'),
    );
    await page.getByRole("button", { name: "作答", exact: true }).click();
    await more.click();
    await page.getByRole("menuitem", { name: "隐藏标画" }).click();
    await more.click();
    await expect(
      page.getByRole("menuitem", { name: "显示标画" }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "导出本题" }).click();
    const combined = page.getByRole("img", { name: "本题导出预览" });
    await expect(combined).toBeVisible();
    const red = await combined.evaluate(async (element) => {
      const image = element as HTMLImageElement;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("画布不可用");
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          (pixels[i] ?? 0) > 150 &&
          (pixels[i + 1] ?? 255) < 100 &&
          (pixels[i + 2] ?? 255) < 100
        )
          red++;
      return red;
    });
    expect(red).toBeGreaterThan(10);
    await page.getByRole("button", { name: "关闭弹层" }).click();
    await page.setViewportSize({ width: 320, height: 740 });
    await more.click();
    await expect(
      page.getByRole("menuitem", { name: "显示标画" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("question-menu-320.png"),
    });
    await page.getByRole("menuitem", { name: "标记待检查" }).click();
    await expect(card.locator('svg[aria-label="待检查"]')).toBeVisible();
    await more.click();
    await page.getByRole("menuitem", { name: "取消待检查" }).click();
    await expect(card.locator('svg[aria-label="待检查"]')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(leak.violations()).toEqual([]);
  },
);
