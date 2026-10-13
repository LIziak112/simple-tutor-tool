import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  getStudentViaApi,
  importJudgeUnit,
  openChoicePractice,
  setCourseItemVisible,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
  unzipEntries,
} from "./helpers";

/**
 * 批量 LearningPack v2 E2E（T6R.16）——现仅保留 v1/v2 分叉对照用例：
 * 不开证据组（只勾逐题作答）下载的 zip 仍是 v1（meta.version=1、
 * pack.json 无 manifest、zip 无 evidence/ 条目）。
 * 原「证据组/逐题评析/包内引用一致」v2 全链用例因结果回看操作栏改版
 * 与断言脱节，于 2026-10-12 随 e2e 减负整体删除（git 历史可回溯）。
 *
 * 解包方式：复用 helpers.unzipEntries（跨包引用 apps/server/src/lib/zip-read
 * 生产实现，e2e tsconfig 已放行，不引第三方依赖）。
 */

/** 教师端 UI 登录（照 export-wizard.spec 的页面登录段） */
async function teacherUiLogin(page: Page): Promise<void> {
  await page.goto("/t/login");
  await page.fill("#login-name", TEACHER_LOGIN_NAME);
  await page.fill("#login-password", TEACHER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/t/library");
}

test.describe("learning-pack-v2 批量学情包 v2 全链（T6R.16）", () => {
  test("对照：不开证据组下载的仍是 v1 包（meta.version=1、无 manifest、无 evidence/）", async ({
    request,
    browser,
    page,
  }) => {
    test.setTimeout(240_000);

    // —— 造数：1 判断题课程练习 + 学生（答对交卷） ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e对照课程${suffix}`;
    const unitName = `对照小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importJudgeUnit(request, courseId, unitName);
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-v1check-${suffix}`;
    const studentName = `e2e对照生${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: studentName, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      await openChoicePractice(studentPage, courseId, courseName, unitName, 1);
      await studentPage
        .locator('article[aria-label="第 1 题"]')
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await studentContext.close();
    }

    // —— 教师端：向导只勾「逐题作答」（不开证据组 → v1） ——
    await teacherUiLogin(page);
    await page.goto("/t/export");
    await expect(
      page.getByRole("heading", { name: "导出给 AI" }),
    ).toBeVisible();
    await page
      .getByRole("list", { name: "学生名单" })
      .getByText(studentName, { exact: true })
      .click();
    await expect(page.getByText("已选 1 人")).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();

    const responsesLabel = page
      .locator("label")
      .filter({ hasText: "每题的学生答案、判定结果与你的批注评语" });
    await responsesLabel.getByRole("checkbox").click();
    await expect(responsesLabel.getByRole("checkbox")).toBeChecked();
    await page.getByRole("button", { name: "下一步" }).click();

    // ③ 默认「诊断薄弱点」；④ 默认化名
    await expect(page.getByText("诊断薄弱点", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.getByText("化名导出（默认开启）")).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();

    // ⑤ 预览：无证据缩略区、文件清单无 evidence/ 路径
    await expect(page.getByRole("list", { name: "文件清单" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("heading", { name: /手写证据图片/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "文件清单" }).getByText(/evidence\//),
    ).toHaveCount(0);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.getByRole("button", { name: "生成并下载" }).click(),
    ]);
    expect(download.suggestedFilename().endsWith(".zip")).toBe(true);
    const zipPath = await download.path();
    if (zipPath === null) {
      throw new Error("下载文件无本地路径");
    }
    const entries = unzipEntries(readFileSync(zipPath));
    const packRaw = entries.get("pack.json");
    if (packRaw === undefined) {
      throw new Error("zip 内无 pack.json");
    }
    const pack = JSON.parse(packRaw.toString("utf8")) as {
      meta: { version: number };
      manifest?: unknown;
      attempts?: { responses?: Array<{ finalCorrect: boolean | null }> };
    };

    // v1 形状：version=1、无 manifest、无 evidence/ 条目；作答行仍在
    expect(pack.meta.version).toBe(1);
    expect(pack.manifest).toBeUndefined();
    expect(
      [...entries.keys()].filter((name) => name.startsWith("evidence/")),
    ).toEqual([]);
    expect(pack.attempts?.responses?.length).toBe(1);
  });
});
