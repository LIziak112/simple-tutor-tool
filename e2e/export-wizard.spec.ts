import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  getStudentViaApi,
  setCourseItemVisible,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T4.7 导出向导全流程 E2E（T4.4 五步走到下载）：教师造数（专属课程 +
 * 1 题判断单元 + 学生成员 → 学生作答交卷，保证作答汇总与题目模块有数据）→
 * /t/export 五步：① 勾学生 ② 勾「逐题答案与对错判定」（内容模块门槛）→
 * ③ 默认诊断模板 → ④ 默认化名 → ⑤ 预览清单出现后「生成并下载」→
 * 拦截 download 事件：文件名 .zip 结尾、文件前两字节为 zip 魔数 PK
 * （不解包——打包结构与模块勾选由 T4.3 服务测试覆盖）。
 */

/** 一题判断单元（学生答对，交卷即 graded） */
function practiceMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 有理数",
    "---",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
    "$1$ 是正数。[[正确]]",
    "::::",
    "",
  ].join("\n");
}

test.describe("导出向导全流程（T4.7：五步走到下载）", () => {
  test("五步向导 → 预览清单 → 下载 zip（文件名与魔数）", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    // —— 造数（教师 API）——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e导出课程${suffix}`;
    const unitName = `导出小练${suffix}`;
    const studentName = `e2e导出生${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: practiceMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-exp-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: studentName, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生作答交卷（作答汇总与逐题模块的数据源）——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      await studentPage
        .getByRole("link", { name: `打开课程 ${courseName}` })
        .click();
      await studentPage.waitForURL(`**/s/courses/${courseId}`);
      await studentPage
        .getByRole("link", { name: `打开练习 ${unitName}（1 题）` })
        .click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
      );
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await q1
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await studentPage
        .getByRole("button", { name: "交卷", exact: true })
        .click();
      await studentPage
        .getByRole("button", { name: "确认交卷" })
        .first()
        .click();
      await expect(studentPage.getByText("批改结果")).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await studentContext.close();
    }

    // —— 教师端：五步向导 ——
    await page.goto("/t/login");
    await page.fill("#login-name", TEACHER_LOGIN_NAME);
    await page.fill("#login-password", TEACHER_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");

    await page.goto("/t/export");
    await expect(
      page.getByRole("heading", { name: "导出给 AI" }),
    ).toBeVisible();

    // ① 范围：勾选学生（label 含学生名）
    await page
      .getByRole("list", { name: "学生名单" })
      .getByText(studentName, { exact: true })
      .click();
    await expect(page.getByText("已选 1 人")).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();

    // ② 内容：勾「逐题答案与对错判定、教师评语」
    await page.getByText("逐题答案与对错判定、教师评语").click();
    await page.getByRole("button", { name: "下一步" }).click();

    // ③ 目标：默认「诊断薄弱点」模板（四模板卡片可见，不改选择）
    await expect(page.getByText("诊断薄弱点", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();

    // ④ 隐私：默认化名（不开启真实姓名）
    await expect(page.getByText("化名导出（默认开启）")).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();

    // ⑤ 预览：文件清单出现（pack.json / prompt.md / summary.md）
    await expect(page.getByRole("list", { name: "文件清单" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("list", { name: "文件清单" }).getByText("pack.json"),
    ).toBeVisible();
    await expect(page.getByText(/超过 50 MB 上限/)).toHaveCount(0);

    // 生成并下载：拦截 download 事件，断言文件名与 zip 魔数 PK
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.getByRole("button", { name: "生成并下载" }).click(),
    ]);
    const filename = download.suggestedFilename();
    expect(filename.endsWith(".zip")).toBe(true);
    const path = await download.path();
    if (path === undefined) {
      throw new Error("下载文件无本地路径（download.path() 为空）");
    }
    const { readFileSync } = await import("node:fs");
    const head = readFileSync(path).subarray(0, 2);
    expect(head[0]).toBe(0x50); // 'P'
    expect(head[1]).toBe(0x4b); // 'K'
  });
});
