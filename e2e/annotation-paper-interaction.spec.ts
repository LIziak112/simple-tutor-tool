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

test.beforeEach(async ({ request, page }) => {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `交互回归课程${suffix}`;
  const unitName = `交互回归练习${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  const markdown = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "---",
    "",
    '::::question{type=choice difficulty=1 knowledge="计算"}',
    "计算 $1+1$ 的结果，选择正确选项。",
    "",
    "- [ ] 选项甲：$1$",
    "- [x] 选项乙：$2$",
    "- [ ] 选项丙：$3$",
    "- [ ] 选项丁：$4$",
    "",
    ":::solution",
    "不应提前出现的秘密详解",
    ":::",
    "::::",
    "",
  ].join("\n");
  const imported = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: `${unitName}.md`, courseId },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  await setCourseItemVisible(request, courseId, unitName, true);
  const loginName = `interaction-${suffix}`;
  await request.post("/api/teacher/students", {
    data: { displayName: "交互回归学生", loginName },
  });
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await page.setViewportSize({ width: 1100, height: 668 });
  await openChoicePractice(page, courseId, courseName, unitName, 1);
});

test("圈画再次点击与双击取消，不丢已有笔迹", async ({ page }) => {
  const card = page.getByRole("article", { name: "第 1 题", exact: true });
  const trigger = card.getByRole("button", { name: /圈画题干/ });
  const canvas = card.locator('canvas[data-slot="annotation-canvas"]');
  await trigger.click();
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  await drawStrokeWithPointerEvents(canvas);
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(canvas).toHaveAttribute("data-input-enabled", "false");
  await trigger.click();
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  await trigger.dblclick();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(canvas).toHaveAttribute("data-input-enabled", "false");
  await trigger.dblclick();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  await card.locator('[role="radiogroup"] label').nth(1).click();
  await expect(card.getByRole("radio").nth(1)).toBeChecked();
});

test("草稿全屏参考包含全部选项，退出后保留作答", async ({ page }, testInfo) => {
  const leak = attachLeakMonitor(page);
  const card = page.getByRole("article", { name: "第 1 题", exact: true });
  await card.locator('[role="radiogroup"] label').nth(1).click();
  await card
    .getByRole("button", { name: "第 1 题草稿纸", exact: true })
    .click();
  const paper = card.locator('[data-slot="note-layer"]');
  await paper.getByRole("button", { name: "第 1 题草稿纸全屏" }).click();
  const dialog = page.getByRole("dialog", { name: "第 1 题草稿纸全屏" });
  const options = dialog.getByRole("list", { name: "参考选项" });
  await expect(options.getByRole("listitem")).toHaveCount(4);
  for (const label of ["选项甲", "选项乙", "选项丙", "选项丁"])
    await expect(options).toContainText(label);
  await options.getByRole("listitem").last().scrollIntoViewIfNeeded();
  await expect(options.getByRole("listitem").last()).toBeVisible();
  await expect(dialog).not.toContainText("不应提前出现的秘密详解");
  await expect(dialog.locator(".katex-error, .math-fallback")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("paper-options-fullscreen.png"),
  });
  await dialog.getByRole("button", { name: "退出全屏" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole("radio").nth(1)).toBeChecked();
  expect(leak.violations()).toEqual([]);
});
