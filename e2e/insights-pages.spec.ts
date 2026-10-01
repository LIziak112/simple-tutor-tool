import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  getStudentViaApi,
  importLectureSample,
  setCourseItemVisible,
  teacherApiLogin,
  teacherLoginViaApi,
  uniqueSuffix,
} from "./helpers";

/**
 * T4.7 学情页 E2E：种子口径的最小确定性造数（1 门课 + 讲义 + 2 题练习
 * 〔填空答错 + 判断答对 → 交卷即 graded、正确率 50%〕+ 1 名学生读讲义后
 * 作答交卷），教师端依次验证：
 * - 总览：关键计数（总正确率 50%、对 1/已判定 2、待批 0）+ 完成矩阵
 *   （学生名 + 课程单元列「已批 / 做过 1 次 · 首次 50 分」），点学生名进画像；
 * - 画像：周趋势与考点条形图容器（ECharts canvas）、讲义阅读地图含该讲义、
 *   错题列表含判错的填空题与学生答案；
 * - 题目视角：行展开显示题干全文与高频错误答案（fill 题型聚合「6 × 1」）。
 *
 * **独立教师域**：总览是教师全域聚合（另一 worker 的共用教师数据会污染
 * 计数断言），本用例经管理员 API 建专属教师（不走注册接口，避开按 IP 限流）
 * 并以其会话造数与登录。
 */

/** 独立教师初始密码（e2e 内约定；仅本 run 的临时库有效） */
const INSIGHTS_TEACHER_PASSWORD = "e2e-ins-pass-8";

/** 两题练习：填空（学生会答错 → 高频错误答案可聚合）+ 判断（答对） */
function practiceMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 有理数",
    "---",
    "",
    '::::question{type=fill difficulty=1 knowledge="二十以内加法"}',
    "计算：$2+3=$ [[5]]",
    "",
    ":::solution",
    "$2+3=5$。",
    ":::",
    "::::",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
    "$1$ 是正数。[[正确]]",
    "::::",
    "",
  ].join("\n");
}

test.describe("学情页三视图（T4.7：总览矩阵/计数 + 画像图表与阅读地图 + 题目行展开）", () => {
  test("种子造数下总览计数与矩阵正确，画像图表/阅读地图/错题可见，题目行可展开", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    // —— 造数（独立教师域）：管理员（首启 teacher）建专属教师，切换到其会话 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const teacherName = `e2e-ins-t-${suffix}`;
    const created = await request.post("/api/admin/teachers", {
      data: { loginName: teacherName, password: INSIGHTS_TEACHER_PASSWORD },
    });
    if (!created.ok()) {
      throw new Error(`创建学情专属教师失败：HTTP ${created.status()}`);
    }
    await teacherLoginViaApi(request, teacherName, INSIGHTS_TEACHER_PASSWORD);

    const courseName = `e2e学情课程${suffix}`;
    const unitName = `学情小练${suffix}`;
    const studentName = `e2e学情生${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importLectureSample(request, courseId);
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

    const loginName = `e2e-ins-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: studentName, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生端：先读讲义（阅读地图数据），再做练习（填空错 + 判断对）并交卷 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      await studentPage
        .getByRole("link", { name: `打开课程 ${courseName}` })
        .click();
      await studentPage.waitForURL(`**/s/courses/${courseId}`);
      // 讲义阅读页（阅读事件自动注入；停留数秒出 section_focus）
      await studentPage
        .getByRole("link", { name: /阅读讲义 第1讲 有理数/ })
        .click();
      await studentPage.waitForURL(/\/s\/lectures\/[^/]+/);
      await expect(
        studentPage.getByRole("heading", { name: "第1讲 有理数" }).first(),
      ).toBeVisible();
      await studentPage.waitForTimeout(2500);
      await studentPage.goBack();
      await studentPage
        .getByRole("link", { name: `打开练习 ${unitName}（2 题）` })
        .click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
      );
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");

      // 第 1 题填空：答 6（判错 → 错题列表与高频错误答案数据）
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await q1.getByLabel("第1空").fill("6");
      // 第 2 题判断：答「对」（判对）
      const q2 = studentPage.locator('article[aria-label="第 2 题"]');
      await q2
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      // 等防抖草稿保存完成再交卷（填空答案不丢）
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
    } finally {
      await studentContext.close();
    }

    // —— 教师端 UI：登录（学情专属教师）→ 学情总览 ——
    await page.goto("/t/login");
    await page.fill("#login-name", teacherName);
    await page.fill("#login-password", INSIGHTS_TEACHER_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");

    await page.goto("/t/insights");
    // 关键计数：全判断自动判 → 交卷即 graded，正确率 50%（D4：判对 1 / 已判定 2）
    await expect(page.getByText("总正确率")).toBeVisible();
    const overall = page.getByText("总正确率").locator("..");
    await expect(overall.getByText("50%", { exact: true })).toBeVisible();
    await expect(overall.getByText(/对 1 \/ 已判定 2 题/)).toBeVisible();
    await expect(
      page.getByText("待批题").locator("..").getByText("0", { exact: true }),
    ).toBeVisible();

    // 完成矩阵：学生名（链接画像）+ 课程单元列（已批 + 做过 1 次首次 50 分）
    const matrix = page.locator('section[aria-label="完成矩阵"]');
    await expect(matrix).toBeVisible();
    const studentCell = matrix.getByRole("link", { name: studentName });
    await expect(studentCell).toBeVisible();
    await expect(matrix.getByText("已批", { exact: true })).toBeVisible();
    await expect(matrix.getByText(/做过 1 次 · 首次 50 分/)).toBeVisible();

    // 点学生名 → 画像页
    await studentCell.click();
    await page.waitForURL(`**/t/insights/students/${student.id}*`);
    await expect(
      page.getByRole("heading", { name: studentName }),
    ).toBeVisible();

    // 画像：两张图表容器渲染出 ECharts canvas（种子数据非空 → 不落空态文案）
    await expect(
      page.locator('section[aria-label="正确率周趋势"] canvas'),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-label="考点正确率"] canvas'),
    ).toBeVisible();

    // 阅读地图：该讲义出现在条目里
    const readingMap = page.locator('section[aria-label="讲义阅读地图"]');
    await expect(readingMap.getByText("第1讲 有理数")).toBeVisible();

    // 错题列表：判错的填空题（学生答案 6）
    const wrongList = page.locator('section[aria-label="错题列表"]');
    await expect(wrongList.getByText("学生答案：6")).toBeVisible();

    // —— 题目视角：行展开（题干全文 + 高频错误答案「6 × 1」，fill 聚合口径） ——
    await page.goto("/t/insights/questions");
    const rowButton = page.locator("tbody th button[aria-expanded]").first();
    await expect(rowButton).toBeVisible();
    await rowButton.click();
    await expect(
      page.getByRole("row").filter({ hasText: "高频错误答案" }),
    ).toBeVisible();
    await expect(page.getByText("6 × 1")).toBeVisible();
  });
});
