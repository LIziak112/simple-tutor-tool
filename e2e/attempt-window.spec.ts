import { expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  getStudentViaApi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 窗口化虚拟列表（性能第三步，2026-10-28）：懒挂载列表在长卷上
 * ① 只挂视口带（首屏不全量）；② 滚到远端后，远端挂载、身后卸载
 * （挂载数恒近于视口带，不随滚动增长）；③ 滚回顶部后重挂（渲染缓存）。
 * 卸载守卫（绘制中不卸载等）由控制器单测锁定；本 spec 锁窗口化行为本身。
 */

const QUESTION_COUNT = 60;

function questionsMarkdown(count: number): string {
  const unit = `窗口化练习-${count}-${uniqueSuffix()}`;
  return [
    "---",
    "kind: practice",
    `unit: ${unit}`,
    "---",
    "",
    ...Array.from({ length: count }, (_, i) =>
      [
        "::::question{type=fill difficulty=1 knowledge=\"填空\"}",
        `第${i + 1}题：计算 $${i + 1}+1=$ [[${i + 2}]]；$${i + 1}×2=$ [[${(i + 1) * 2}]]；$${i + 1}×3=$ [[${(i + 1) * 3}]]；$${i + 1}×4=$ [[${(i + 1) * 4}]]。`,
        "::::",
        "",
      ].join("\n"),
    ),
  ].join("\n");
}

test(
  "窗口化虚拟列表：远端挂载、身后卸载、回滚重挂",
  { tag: ["@student"] },
  async ({ request, page }) => {
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseId = await createCourseViaApi(request, `窗口化课程${suffix}`);
    const markdown = questionsMarkdown(QUESTION_COUNT);
    const imported = await request.post("/api/teacher/import/commit", {
      data: { markdown, filename: `窗口化-${suffix}.md`, courseId },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    const body = (await imported.json()) as {
      data: { units: Array<{ id: string }> };
    };
    const unitId = body.data.units[0]?.id;
    expect(unitId).toBeTruthy();
    const loginName = `window-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: "窗口化测试生", loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);
    const assigned = await request.post("/api/teacher/assignments", {
      data: {
        unitIds: [unitId as string],
        studentIds: [student.id],
        title: `窗口化-${suffix}`,
        courseId,
      },
    });
    expect(assigned.ok(), await assigned.text()).toBe(true);
    const assignmentBody = (await assigned.json()) as {
      data: { assignments: Array<{ id: string }> };
    };
    const assignmentId = assignmentBody.data.assignments[0]?.id;
    expect(assignmentId).toBeTruthy();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await page.goto(`/s/assignments/${assignmentId}`);

    const first = page.locator('article[aria-label="第 1 题"]');
    await expect(first).toBeVisible({ timeout: 30_000 });
    const mountedAtStart = await page.locator("article").count();
    // 60 题长卷首屏只挂视口带（约 5~8 张）：全量挂载语义已被窗口化取代
    expect(mountedAtStart).toBeLessThan(20);

    // 跳到末题区（滚动静默后挂载）：末题挂载、身后远端卸载
    await page.evaluate(() =>
      window.scrollTo(0, document.body.scrollHeight),
    );
    const last = page.locator(
      `article[aria-label="第 ${QUESTION_COUNT} 题"]`,
    );
    await expect(last).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => page.locator("article").count(), { timeout: 15_000 })
      .toBeLessThan(25);

    // 滚回顶部：第 1 题重挂（渲染缓存命中，不需要全量重解析）
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(first).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => page.locator("article").count(), { timeout: 15_000 })
      .toBeLessThan(25);
  },
);
