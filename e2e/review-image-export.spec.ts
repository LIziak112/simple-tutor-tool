import { type Download, devices, expect, test } from "@playwright/test";
import { pngSize } from "../apps/server/src/lib/png";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  expectDecodablePng,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  teacherEvidenceOf,
  uniqueSuffix,
} from "./helpers";

/**
 * T6R.19 静态合成图导出 E2E（真实栅格化链路——html-to-image 在真浏览器的
 * 端到端验证，jsdom 单测只覆盖注入依赖的失败语义）：
 * - 学生链：长题干＋公式＋草稿原稿的练习 → 交卷 → 补分析图 → AI 复习包 →
 *   「导出合成图（PNG）」→ **多页下载**（长题干驱动分页）：逐张文件名
 *   review-image-q1-student-NN.png、可解码 PNG（魔数+IHDR）、宽恒 1440
 *   （720 逻辑宽 ×2 像素比）、页数 ≥2（分页真实发生）；
 * - 学生红线：面板文案注明合成图不含参考答案；泄露监控全程无告警；
 * - 单测已覆盖的失败语义（字体/媒体/编码/画布/无剪贴板）不在本 spec 重复。
 */

/**
 * 长题干练习（单题选择＋草稿＋详解）：题干约 26 段说明——每段约 88 全角当量
 * 字，跨行边界数据（720 宽≈48 字/行 → 2 行；648 内容宽≈43 字/行 → 3 行）：
 * 测量与渲染几何若不一致（审查修复轮 P0-1），段落真实高度会大于测量高度，
 * 页底内容被裁——修复后测量容器与页容器同为 648 内容宽，该边界不再触发。
 */
function longStemPracticeMarkdown(unitName: string): string {
  const lines: string[] = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 有理数混合运算",
    "---",
    "",
    '::::question{type=choice difficulty=2 knowledge="有理数混合运算"}',
    "阅读下面各段说明，计算 $(-2)^3+4\\times 3-6\\div 2$ 的值，并选择正确选项。",
    "",
  ];
  for (let i = 1; i <= 26; i += 1) {
    lines.push(
      `说明第 ${i} 段：有理数混合运算的顺序是先乘除后加减，有括号先算括号内的部分；同级运算从左到右依次进行。本段说明用于把题干撑长，验证长内容分页与逐页下载（共二十六段，这是第 ${i} 段）。`,
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
    "$(-2)^3=-8$，$4\\times 3=12$，$6\\div 2=3$，原式 $=-8+12-3=1$，故选 B。",
    ":::",
    "::::",
    "",
  );
  return lines.join("\n");
}

test.describe("静态合成图导出（T6R.19：真实栅格化与多页下载）", () => {
  test("学生长题干＋草稿原稿 → 复习包合成图多页 PNG：文件名/可解码/2x 宽/页数≥2/无泄露", async ({
    request,
    browser,
  }) => {
    test.setTimeout(240_000);

    // —— 造数（教师 API）：专属课程 + 单题长题干练习 + 学生 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e合成图课程${suffix}`;
    const unitName = `合成图长题练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: longStemPracticeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入课程练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-rimg-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e合成图生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生作答：写草稿 + 选答案，交卷 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      const attemptId = await openChoicePractice(
        studentPage,
        courseId,
        courseName,
        unitName,
        1,
      );
      expect(attemptId).not.toBe("");

      const card = studentPage.locator('article[aria-label="第 1 题"]');
      await card
        .getByRole("button", { name: /草稿纸/ })
        .first()
        .click();
      const noteCanvas = card.locator('[data-slot="note-paper"] canvas');
      await expect(noteCanvas).toBeVisible();
      await drawStrokeWithPointerEvents(noteCanvas);
      await card
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/).first()).toBeVisible({
        timeout: 30_000,
      });

      // 分析图补图（派生图不随草稿自动跑——展开原稿视图点重建，再轮询就绪）
      const questionId = `${unitName}-1`;
      await card.getByRole("button", { name: "第 1 题查看草稿原稿" }).click();
      const rebuildButton = card.getByRole("button", {
        name: "重建分析图片",
      });
      await expect(rebuildButton).toBeVisible({ timeout: 15_000 });
      await rebuildButton.click();
      await teacherEvidenceOf(request, attemptId, questionId, {
        pollUntil: { analysisReady: true },
      });

      // —— 复习包面板：第四出口「导出合成图（PNG）」 ——
      await card.getByRole("button", { name: "第 1 题 AI 复习包" }).click();
      await expect(studentPage.getByText("附件清单")).toBeVisible({
        timeout: 15_000,
      });
      // 学生红线：合成图与文字包同口径（不含参考答案）
      await expect(studentPage.getByText(/合成图与文字包同口径/)).toBeVisible();

      // 多页下载收集：先等成功文案给出页数，再收齐等量 download
      const downloads: Download[] = [];
      studentPage.on("download", (download) => {
        downloads.push(download);
      });
      await card.getByRole("button", { name: /导出合成图/ }).click();
      const doneLocator = studentPage.getByText(/已导出 \d+ 张 PNG/);
      await expect(doneLocator).toBeVisible({ timeout: 120_000 });
      const doneContent = await doneLocator.textContent();
      const pageCount = Number(/\d+/.exec(doneContent ?? "")?.[0] ?? "0");
      expect(pageCount).toBeGreaterThanOrEqual(2); // 长题干驱动分页真实发生
      await expect
        .poll(async () => downloads.length, { timeout: 30_000 })
        .toBe(pageCount);

      // 逐张校验：文件名（题号+学生视角+页号）、可解码 PNG、宽恒 1440（2x）
      for (let i = 0; i < pageCount; i += 1) {
        const download = downloads[i];
        if (download === undefined) {
          throw new Error(`第 ${i + 1} 页下载缺失`);
        }
        expect(download.suggestedFilename()).toBe(
          `review-image-q1-student-${String(i + 1).padStart(2, "0")}.png`,
        );
        const downloadPath = await download.path();
        if (downloadPath === null) {
          throw new Error(`第 ${i + 1} 页下载文件无本地路径`);
        }
        const { readFileSync } = await import("node:fs");
        const png = readFileSync(downloadPath);
        expectDecodablePng(png, download.suggestedFilename());
        const size = pngSize(png);
        expect(
          size,
          `${download.suggestedFilename()} IHDR 可解析`,
        ).not.toBeNull();
        expect(size?.width, "合成图宽=720 逻辑宽×2 像素比").toBe(1440);
        expect(size?.height).toBeGreaterThan(0);
      }

      // 学生端全程无泄露告警
      expect(leak.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }
  });
});
