import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { AttemptDraftData } from "../packages/contract/src/index";
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

test(
  "第8题修正源：导入修订阻断坏公式，8空正常作答，冻结旧源明确降级",
  { tag: ["@teacher"] },
  async ({ page, request }, testInfo) => {
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const unit = `公式修正${suffix}`;
    const courseName = `公式课程${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const source = readFileSync(
      new URL("../docs/待处理的问题/练习六第8题修正题源.md", import.meta.url),
      "utf8",
    ).replace("id=p6-q8", `id=p6-q8-${suffix}`);
    const bad = source
      .replace("= +($[[6]]", "= +\\left($[[6]]")
      .replace("{5}{6}) = $[[5]]", "{5}{6}\\right) = $[[5]]");
    const wrap = (value: string) =>
      `---\nkind: practice\nunit: ${unit}\n---\n\n${value}`;
    const rejected = await request.post("/api/teacher/import/commit", {
      data: { markdown: wrap(bad), filename: `${unit}.md`, courseId },
    });
    expect(rejected.status()).toBe(422);
    expect(await rejected.text()).toContain("MATH_LEFT_RIGHT_UNBALANCED");
    const filler = Array.from(
      { length: 7 },
      (_, index) =>
        `::::question{type=judge difficulty=1 id=math-${suffix}-${index}}\n$1>0$。[[正确]]\n::::`,
    ).join("\n\n");
    const imported = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: wrap(`${filler}\n\n${source}`),
        filename: `${unit}.md`,
        courseId,
      },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    await setCourseItemVisible(request, courseId, unit, true);
    const loginName = `math-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: "公式测试生", loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);
    const leak = attachLeakMonitor(page);
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await openChoicePractice(page, courseId, courseName, unit, 8);
    const card = page.locator('article[aria-label="第 8 题"]');
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole("textbox")).toHaveCount(8);
    await expect(
      card.locator(".katex-error, .math-fallback, .math-render-error"),
    ).toHaveCount(0);
    await expect(card.locator(".mfrac").first()).toBeVisible();
    await card.getByLabel("第1空").fill("3");
    await expect(card).toContainText("已填 1/8 空");
    await page.screenshot({ path: testInfo.outputPath("p6-q8-corrected.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("p6-q8-corrected-390.png"),
    });
    // 仅浏览器夹具模拟旧冻结公开题面，不改服务端/用户数据库或题目版本。
    await page.route("**/api/student/attempts/*", async (route) => {
      if (
        route.request().method() !== "GET" ||
        !/\/attempts\/[^/]+$/.test(new URL(route.request().url()).pathname)
      )
        return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { data: AttemptDraftData };
      const question = body.data.units
        .flatMap((unit) => unit.questions)
        .find((question) => question.id === `p6-q8-${suffix}`);
      if (question)
        question.stemMd = question.stemMd
          .replace("= +($[[]]", "= +\\left($[[]]")
          .replace("{5}{6}) = $[[]]", "{5}{6}\\right) = $[[]]");
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(
      card.locator('[data-slot="question-surface"] .math-fallback'),
    ).toHaveCount(2);
    await expect(card.locator(".katex-error")).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole("textbox")).toHaveCount(8);
    await page.screenshot({
      path: testInfo.outputPath("p6-q8-historical-fixture.png"),
    });
    await card.getByRole("button", { name: /圈画题干/ }).click();
    await expect(page.getByRole("alert")).toContainText(
      "题面公式或配图渲染失败",
    );
    await expect(
      card.locator('canvas[data-slot="annotation-canvas"]'),
    ).toHaveCount(0);
    expect(leak.violations()).toEqual([]);
  },
);
