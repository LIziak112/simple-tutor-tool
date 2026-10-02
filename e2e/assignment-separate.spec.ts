import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createStudentViaApi,
  ensureDefaultCourse,
  getStudentViaApi,
  importJudgeUnit,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 组合方式 separate（2026-10 产品决策：默认不合并）端到端验收：
 * 教师一次布置 2 个单元（保持默认「每个单元一份作业」、不填标题）→ 服务端
 * 建 2 份独立作业（每份标题 = 各自单元标题、题数各自统计）→ 学生端出现
 * 2 张独立作业卡 → 完成其中一份交卷（全对自动判分 → 已批改），另一份仍
 * 「未开始」。学生端代码零改动（N 份独立作业 = N 张现有卡片，天然兼容）。
 * 内容准备走教师 API（单元 A 两题 = 判断 + 单选；单元 B 一题判断），
 * 布置交互走教师 UI 三步向导，作答走学生 UI。
 */
test.describe("布置作业组合方式：每个单元一份（separate）", () => {
  test("教师两单元不合并 → 学生两张独立作业卡，完成一份另一份仍未开始", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(120_000);

    // —— 准备：教师 API 会话 + 默认课程 + 两个单元（A 两题 / B 一题）+ 学生入成员 ——
    await teacherApiLogin(request);
    const courseId = await ensureDefaultCourse(request);
    const unitAName = `e2e分单元A${uniqueSuffix()}`;
    const unitBName = `e2e分单元B${uniqueSuffix()}`;
    const unitAMd = [
      "---",
      "kind: practice",
      `unit: ${unitAName}`,
      "topic: 方程",
      "---",
      "",
      "::::question{type=judge difficulty=1}",
      "等式两边同时加上同一个数，等式仍然成立。[[正确]]",
      "::::",
      "",
      "::::question{type=choice difficulty=2}",
      "解方程 $x+1=3$，则 $x=$（　）",
      "",
      "- [x] $2$",
      "- [ ] $1$",
      "- [ ] $3$",
      "::::",
      "",
    ].join("\n");
    const importA = await request.post("/api/teacher/import/commit", {
      data: { markdown: unitAMd, filename: `${unitAName}.md`, courseId },
    });
    expect(importA.ok(), "导入单元 A 失败").toBeTruthy();
    await importJudgeUnit(request, courseId, unitBName);

    const studentName = `e2e学生${uniqueSuffix()}`;
    await createStudentViaApi(request, studentName, studentName);
    const student = await getStudentViaApi(request, studentName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 教师端 UI：登录 → 三步向导布置（默认「每个单元一份」，不填标题）——
    await page.goto("/t/login");
    await page.fill("#login-name", TEACHER_LOGIN_NAME);
    await page.fill("#login-password", TEACHER_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");

    await page.goto("/t/assignments");
    await page.getByRole("button", { name: "布置作业" }).first().click();

    // ① 对象：选「默认课程」→ 名单自动带出该学生（默认全选，保持勾选）
    const courseOption = page.locator("#wizard-course option", {
      hasText: "默认课程",
    });
    await expect(courseOption).toHaveCount(1);
    const courseValue = await courseOption.getAttribute("value");
    if (courseValue === null) {
      throw new Error("「默认课程」option 缺少 value");
    }
    await page.selectOption("#wizard-course", courseValue);
    const studentCheck = page.getByRole("checkbox", { name: studentName });
    await expect(studentCheck).toBeVisible();
    await expect(studentCheck).toBeChecked();
    await page.getByRole("button", { name: "下一步", exact: true }).click();

    // ② 内容：勾选单元 A、B（勾选顺序 = 份次顺序），共 3 题
    const courseUnitList = page.getByRole("list", {
      name: "本课程练习单元列表",
    });
    await expect(courseUnitList).toBeVisible();
    await courseUnitList
      .getByRole("checkbox", { name: new RegExp(unitAName) })
      .check();
    await courseUnitList
      .getByRole("checkbox", { name: new RegExp(unitBName) })
      .check();
    await expect(page.getByText("已选 2 个单元 · 共 3 题")).toBeVisible();
    await page.getByRole("button", { name: "下一步", exact: true }).click();

    // ③ 确认：默认选中「每个单元一份作业（推荐）」；不填标题（每份用各自单元
    //    标题）；提交按钮份数口径
    await expect(page.locator("#wizard-title")).toBeVisible();
    await expect(
      page.getByRole("radio", { name: /每个单元一份作业（推荐）/ }),
    ).toBeChecked();
    await expect(
      page.getByText("学生端分别看到 2 份作业，各自作答与交卷"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "布置作业（2 份 · 共 3 题）" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // —— 教师列表：两张独立作业卡，标题 = 各自单元标题、题数各自统计 ——
    const cardA = page.locator("li", { hasText: unitAName });
    const cardB = page.locator("li", { hasText: unitBName });
    await expect(cardA).toHaveCount(1);
    await expect(cardB).toHaveCount(1);
    await expect(cardA.getByText("共 2 题")).toBeVisible();
    await expect(cardB.getByText("共 1 题")).toBeVisible();

    // —— 学生端：独立 context + 泄露监控，链接登录 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    try {
      const studentPage = await studentContext.newPage();
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      await expect(studentPage.getByText(studentName).first()).toBeVisible();

      // 两张独立作业卡：各单元标题、单单元行「单元：标题」、各自题数、均未开始
      const sCardA = studentPage.locator("li", { hasText: unitAName });
      const sCardB = studentPage.locator("li", { hasText: unitBName });
      await expect(sCardA).toHaveCount(1);
      await expect(sCardB).toHaveCount(1);
      await expect(sCardA.getByText(`单元：${unitAName}`)).toBeVisible();
      await expect(sCardA.getByText("共 2 题")).toBeVisible();
      await expect(sCardB.getByText(`单元：${unitBName}`)).toBeVisible();
      await expect(sCardB.getByText("共 1 题")).toBeVisible();
      await expect(sCardA.getByText("未开始", { exact: true })).toBeVisible();
      await expect(sCardB.getByText("未开始", { exact: true })).toBeVisible();

      // 完成单元 A 那份：两题全对（判断「对」+ 单选「选项 A」）→ 交卷 → 已批改
      await sCardA.getByRole("link", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/assignments/**");
      await expect(
        studentPage.locator('article[aria-label="第 2 题"]'),
      ).toBeVisible();
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await q1
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      const q2 = studentPage.locator('article[aria-label="第 2 题"]');
      await q2
        .getByRole("radio", { name: "选项 A" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect
        .poll(async () => studentPage.getByTestId("draft-status").textContent())
        .not.toContain("保存中");
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
      await expect(studentPage.getByText("答对 2 题")).toBeVisible();

      // 回首页：A 那份已批改（入口变「查看结果」），B 那份仍「未开始」
      await studentPage.goto("/s/home");
      await expect(sCardA.getByText("已批改", { exact: true })).toBeVisible();
      await expect(
        sCardA.getByRole("link", { name: "查看结果" }),
      ).toBeVisible();
      await expect(sCardB.getByText("未开始", { exact: true })).toBeVisible();
      await expect(
        sCardB.getByRole("link", { name: "开始练习" }),
      ).toBeVisible();

      // 泄露检查：交卷前所有 /api/student/* 响应无禁用键/原文
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
