import { devices, expect, test } from "@playwright/test";
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

/**
 * T6R.20 题干标注 E2E——现仅保留装配失败降级两条：
 * - 无底图：超高题显式禁用文案；mock 装配 500 同禁用（草稿照用）；
 * - mock 装配载荷投影失败（500 EXPORT_ASSEMBLY_BROKEN）→ 入口禁用文案。
 * 原「学生全链（栅格化→落笔→resize 等比→封存→教师回看）」用例因结果
 * 回看操作栏改版与断言脱节，于 2026-10-12 随 e2e 减负整体删除（git 历史
 * 可回溯；jsdom 单测仍覆盖注入依赖的失败语义）。
 */

/** 单题选择练习（题面带公式，圈画可辨识） */
function annotationPracticeMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 有理数混合运算",
    "---",
    "",
    '::::question{type=choice difficulty=1 knowledge="有理数混合运算"}',
    "计算 $(-2)^3+4\\times 3-6\\div 2$ 的结果，并选择正确选项。",
    "",
    "- [ ] $-8$",
    "- [x] $1$",
    "- [ ] $3$",
    "",
    ":::solution",
    "$(-2)^3=-8$，$4\\times 3=12$，$6\\div 2=3$，原式 $=-8+12-3=1$，故选 B。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

/** 超高题练习（题干约 30 段 → 内容高 > 1976 CSS 上限 → 显式禁用标注） */
function tooTallPracticeMarkdown(unitName: string): string {
  const lines: string[] = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 有理数混合运算",
    "---",
    "",
    '::::question{type=choice difficulty=2 knowledge="有理数混合运算"}',
    "阅读下面各段说明后作答。",
    "",
  ];
  for (let i = 1; i <= 30; i += 1) {
    lines.push(
      `说明第 ${i} 段：有理数混合运算的顺序是先乘除后加减，有括号先算括号内的部分；同级运算从左到右依次进行。本段说明用于把题干撑到超过标注底图的高度上限（共三十段，这是第 ${i} 段）。`,
      "",
    );
  }
  lines.push(
    "计算结果是（　）",
    "",
    "- [ ] $-8$",
    "- [x] $1$",
    "- [ ] $3$",
    "",
    ":::solution",
    "原式 $=1$，故选 B。",
    ":::",
    "::::",
    "",
  );
  return lines.join("\n");
}

test.describe("题干标注（T6R.20）", { tag: ["@annotation"] }, () => {
  test("无底图：超高题显式禁用文案；mock 装配 500 同禁用（草稿照用）", {
    tag: ["@annotation"],
  }, async ({ request, browser }) => {
    test.setTimeout(240_000);

    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e超高题课程${suffix}`;
    const unitName = `超高题练习${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: tooTallPracticeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入超高题练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-tall-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e超高题生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const context = await browser.newContext(devices["iPad (gen 7)"]);
    const page = await context.newPage();
    try {
      const leak = attachLeakMonitor(page);
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
      await openChoicePractice(page, courseId, courseName, unitName, 1);

      const card = page.locator('article[aria-label="第 1 题"]');
      await card.getByRole("button", { name: /圈画题干/ }).click();
      // 超高题：显式禁用 + 说明原因 + 草稿照用口径
      await expect(page.getByRole("alert")).toContainText(/尺寸超限/);
      await expect(page.getByRole("alert")).toContainText(/草稿不受影响/);
      await expect(
        card.locator('canvas[data-slot="annotation-canvas"]'),
      ).toHaveCount(0);
      await expect(
        card.locator('[data-slot="question-surface"]'),
      ).not.toHaveAttribute("inert", "");
      await expect(card.getByText(/已禁用题干标注/)).toHaveCount(0);
      // 不挂画布（没有可靠底图不能落墨）
      await expect(
        card.locator('[data-slot="annotation-base-wrap"]'),
      ).toHaveCount(0);
      // 泄露监控零告警
      expect(leak.violations()).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("mock 装配载荷投影失败（500 EXPORT_ASSEMBLY_BROKEN）→ 入口禁用文案", {
    tag: ["@annotation"],
  }, async ({ request, browser }) => {
    test.setTimeout(180_000);

    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e哨兵课程${suffix}`;
    const unitName = `哨兵练习${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: annotationPracticeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-sent-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e哨兵生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const context = await browser.newContext(devices["iPad (gen 7)"]);
    const page = await context.newPage();
    try {
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
      await openChoicePractice(page, courseId, courseName, unitName, 1);

      // mock：视图与装配载荷都替换为 500 EXPORT_ASSEMBLY_BROKEN 壳
      await page.route(
        /\/api\/student\/attempts\/[^/]+\/questions\/[^/]+\/annotation(\?phase=|$)/,
        async (route) => {
          if (route.request().method() === "GET") {
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({
                ok: false,
                error: "EXPORT_ASSEMBLY_BROKEN",
                message: "题面装配失败：题干含答案标记",
              }),
            });
            return;
          }
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: "EXPORT_ASSEMBLY_BROKEN",
              message: "题面装配失败：题干含答案标记",
            }),
          });
        },
      );

      const card = page.locator('article[aria-label="第 1 题"]');
      await card.getByRole("button", { name: /圈画题干/ }).click();
      await expect(page.getByRole("alert")).toContainText(
        "题面装配失败：题干含答案标记",
      );
      await expect(
        card.locator('[data-slot="annotation-base-wrap"]'),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
