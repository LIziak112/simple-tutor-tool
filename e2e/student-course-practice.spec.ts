import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T2A.6 课程练习全流程（可重做 + 历次记录，D10）：教师造数（用例专属课程 +
 * 小练习单元（2 题）+ 学生入成员）→ 学生链接登录 → 课程目录（未做）→ 单元
 * 落地页 → 开始练习 → 答题交卷 → 结果视图 → 返回落地页（历次记录 1、再做一次
 * 确认「将开始第 2 次，从空白开始」）→ 第二次答错交卷 → 历次记录显示 2 次
 * （首次 100 / 最近 0）。全程对学生端响应做泄露检查。
 */

/**
 * 两题小练习（判断 + 单选，均可自动判分；两次作答制造 100 → 0 的分差）。
 * 2026-10-02 fill 改全人工批改（gradeFill 恒 null）后，「交卷即出分 / 历次
 * 得分独立」的用例意图改由仍自动判分的单选题承载（原第二题为填空题）。
 */
function practiceMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 正数与负数",
    "---",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
    "$1$ 是正数。[[正确]]",
    "",
    ":::solution",
    "$1$ 大于 $0$，是正数。",
    ":::",
    "::::",
    "",
    '::::question{type=choice difficulty=1 knowledge="有理数加法"}',
    "$(-3)+7=$ 的计算结果是（　）",
    "",
    "- [ ] $-10$",
    "- [x] $4$",
    "- [ ] $-4$",
    "- [ ] $10$",
    "",
    ":::solution",
    "$(-3)+7=4$，故选 B。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

test.describe("课程练习：完成单元 → 结果 → 再做一次 → 历次记录（T2A.6）", () => {
  test("学生在课程中完成单元两次，历次记录显示 2 次且得分独立", async ({
    request,
    browser,
  }) => {
    test.setTimeout(150_000);

    // —— 造数（教师 API）：专属课程 + 可见练习单元 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e课程练习${suffix}`;
    const unitName = `有理数课程小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: practiceMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入课程练习失败：HTTP ${importRes.status()}`);
    }
    // 导入兼容路径默认单元隐藏 → 放开可见（D23-3）
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-practice-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e练习生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生端：iPad 独立 context ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      // —— 课程目录：单元项「未做」→ 进入单元落地页 ——
      await studentPage
        .getByRole("link", { name: `打开课程 ${courseName}` })
        .click();
      await studentPage.waitForURL(`**/s/courses/${courseId}`);
      await studentPage
        .getByRole("link", { name: `打开练习 ${unitName}（2 题）` })
        .click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
      );
      await expect(
        studentPage.getByRole("heading", { name: unitName }),
      ).toBeVisible();
      await expect(studentPage.getByText(/共 2 题/)).toBeVisible();
      await expect(studentPage.getByText("还没有做过")).toBeVisible();

      // —— 第一次：开始练习 → 全对 → 交卷 → 结果 ——
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      // 顶部来源行：课程 + 第 n 次（D9/D10）
      await expect(
        studentPage.getByText(`课程：${courseName} · 第 1 次`),
      ).toBeVisible();
      const first = studentPage.locator('article[aria-label="第 1 题"]');
      await first
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      const choice1 = studentPage.locator('article[aria-label="第 2 题"]');
      await choice1
        .getByRole("radio", { name: "选项 B" })
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

      // —— 返回落地页：历次记录 1 次 + 得分汇总；再做一次（确认弹层文案） ——
      await studentPage.getByRole("link", { name: "返回单元练习" }).click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
      );
      await expect(studentPage.getByText(/历次记录（1）/)).toBeVisible();
      await expect(studentPage.getByText(/已做 1 次/)).toBeVisible();
      await expect(
        studentPage.getByText(/首次 100 分 · 最近 100 分 · 最高 100 分/),
      ).toBeVisible();

      await studentPage.getByRole("button", { name: "再做一次" }).click();
      await expect(
        studentPage.getByRole("dialog", { name: "再做一次确认" }),
      ).toBeVisible();
      await expect(
        studentPage.getByText(/将开始第 2 次，从空白开始/),
      ).toBeVisible();
      await studentPage.getByRole("button", { name: "开始新一次" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(
        studentPage.getByText(`课程：${courseName} · 第 2 次`),
      ).toBeVisible();

      // —— 第二次：全错（从空白开始，无上一次答案回填）→ 交卷 ——
      const second = studentPage.locator('article[aria-label="第 1 题"]');
      await expect(
        second.getByRole("radio", { name: "对", exact: true }),
      ).toBeVisible();
      await second
        .getByRole("radio", { name: "错", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      const choice2 = studentPage.locator('article[aria-label="第 2 题"]');
      await choice2
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
      await expect(studentPage.getByText("答错 2 题")).toBeVisible();

      // —— 落地页：历次记录 2 次；首次 100 / 最近 0 / 最高 100（各自独立） ——
      await studentPage.getByRole("link", { name: "返回单元练习" }).click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
      );
      await expect(studentPage.getByText(/历次记录（2）/)).toBeVisible();
      await expect(
        studentPage.getByText(/首次 100 分 · 最近 0 分 · 最高 100 分/),
      ).toBeVisible();
      // 历次列表：第 2 次（最近在前）与第 1 次都可进入回看
      await expect(
        studentPage.getByRole("button", { name: "查看第 2 次记录" }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: "查看第 1 次记录" }),
      ).toBeVisible();

      // —— 回看第 1 次结果（只读；历次各自快照） ——
      await studentPage
        .getByRole("button", { name: "查看第 1 次记录" })
        .click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(
        studentPage.getByText(`课程：${courseName} · 第 1 次`),
      ).toBeVisible();
      await expect(studentPage.getByText("批改结果")).toBeVisible();
      await expect(studentPage.getByText("答对 2 题")).toBeVisible();

      // —— 泄露检查：全程 /api/student/* 响应无禁用键、无提示/详解原文 ——
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
