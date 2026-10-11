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

test("原位标画：不复制题面、退出一击作答、切题唯一输入、重排不拉伸", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `原位课程${suffix}`;
  const unitName = `原位练习${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  const imported = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: choiceJudgePracticeMarkdown(unitName),
      filename: `${unitName}.md`,
      courseId,
    },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  await setCourseItemVisible(request, courseId, unitName, true);
  const loginName = `inline-${suffix}`;
  await request.post("/api/teacher/students", {
    data: { displayName: "原位测试生", loginName },
  });
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  const leak = attachLeakMonitor(page);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await openChoicePractice(page, courseId, courseName, unitName);
  const first = page.locator('article[aria-label="第 1 题"]');
  const second = page.locator('article[aria-label="第 2 题"]');
  const before = await first
    .locator('[data-slot="question-surface"]')
    .boundingBox();
  await first.getByRole("button", { name: /圈画题干/ }).click();
  await expect(
    page.getByRole("toolbar", { name: "第 1 题标画工具栏" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(first.locator('[data-slot="question-surface"]')).toHaveAttribute(
    "inert",
    "",
  );
  await expect(first.locator('[data-slot="annotation-workspace"]')).toHaveCount(
    0,
  );
  await expect(first.locator('[data-slot="question-surface"]')).toHaveCount(1);
  const after = await first
    .locator('[data-slot="question-surface"]')
    .boundingBox();
  expect(after?.width).toBeCloseTo(before?.width ?? 0, 0);
  expect(after?.height).toBeCloseTo(before?.height ?? 0, 0);
  const canvas = first.locator('canvas[data-slot="annotation-canvas"]');
  await drawStrokeWithPointerEvents(canvas);
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const data =
          canvas
            .getContext("2d")
            ?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
        let painted = 0;
        for (let index = 3; index < data.length; index += 4)
          if ((data[index] ?? 0) > 0) painted++;
        return painted;
      }),
    )
    .toBeGreaterThan(10);
  await page.screenshot({ path: testInfo.outputPath("inline-drawing.png") });
  await page.getByRole("button", { name: "作答", exact: true }).click();
  await expect(
    first.locator('[data-slot="question-surface"]'),
  ).not.toHaveAttribute("inert", "");
  await first.getByText("错", { exact: true }).click();
  await expect(
    first.getByRole("radio", { name: "错", exact: true }),
  ).toBeChecked();
  await expect(canvas).toBeVisible();
  await page.reload();
  await expect(
    first.locator('canvas[data-slot="annotation-canvas"]'),
  ).toBeVisible();
  await expect(page.getByRole("toolbar", { name: /标画工具栏/ })).toHaveCount(
    0,
  );
  await expect(
    first.locator('[data-slot="question-surface"]'),
  ).not.toHaveAttribute("inert", "");
  await first.getByRole("button", { name: "第 1 题更多" }).click();
  await page.getByRole("menuitemcheckbox", { name: "显示标画" }).click();
  await expect(canvas).toBeHidden();
  await first.getByRole("button", { name: /圈画题干/ }).click();
  await expect(canvas).toBeVisible();
  await second.getByRole("button", { name: /圈画题干/ }).click();
  await expect(
    page.getByRole("toolbar", { name: "第 2 题标画工具栏" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('canvas[data-input-enabled="true"]')).toHaveCount(
    1,
  );
  await expect(
    first.locator('[data-slot="question-surface"]'),
  ).not.toHaveAttribute("inert", "");
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.getByRole("toolbar", { name: /标画工具栏/ })).toHaveCount(
    0,
  );
  await expect(page.locator('canvas[data-input-enabled="true"]')).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 810, height: 1080 });
  await second.getByRole("button", { name: /圈画题干/ }).click();
  await expect(
    page.getByRole("toolbar", { name: "第 2 题标画工具栏" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("toolbar", { name: /标画工具栏/ })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(first.getByRole("button", { name: "查看原标画" })).toBeVisible();
  await expect(canvas).toBeHidden();
  await second
    .getByRole("radio", { name: "选项 B" })
    .locator("xpath=ancestor::label[1]")
    .click();
  await expect(second.getByRole("radio", { name: "选项 B" })).toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath("inline-layout-fallback.png"),
  });
  await first.getByRole("button", { name: "查看原标画" }).click();
  await first.getByRole("button", { name: "编辑原标画" }).click();
  const toolbar = page.getByRole("toolbar", { name: "第 1 题标画工具栏" });
  await expect(toolbar).toBeVisible();
  for (const button of await toolbar.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
  }
  await page.screenshot({
    path: testInfo.outputPath("inline-original-320.png"),
  });
  await page.getByRole("button", { name: "作答", exact: true }).click();
  expect(leak.violations()).toEqual([]);
});
