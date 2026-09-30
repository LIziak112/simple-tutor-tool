import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  getStudentViaApi,
  handwriteOneStroke,
  setCourseItemVisible,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T3.1 教师端作答数据页（D5–D8）：教师造数（专属课程 + 判断/手写两题小练习 +
 * 学生入成员）→ 学生课程练习作答（判断答对 + 手写题只写笔迹不填最终答案 →
 * 交卷后待批 1）→ 教师打开 /t/data 默认按课程视图看到该练习卡片 → 进详情看
 * 逐题与手写缩略图并可放大（lightbox）→ 返回数据页 → 切按学生视图仍可见。
 */

/** 两题小练习：判断（可自动判分）+ solve 手写（最终答案留空 → 待批，落笔迹） */
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
    '::::question{type=solve difficulty=2 knowledge="有理数加法"}',
    "计算：$(-2)+5=$，写出过程。",
    "",
    ":::answer",
    "3",
    ":::",
    "",
    ":::solution",
    "$(-2)+5=3$。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

test.describe("教师端作答数据页（T3.1：三视图 + 详情手写放大）", () => {
  test("学生课程练习交卷后，数据页按课程视图可见、进详情见手写图、切按学生视图仍可见", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(150_000);

    // —— 造数（教师 API）：专属课程 + 可见练习单元 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e数据页课程${suffix}`;
    const unitName = `有理数数据页小练${suffix}`;
    const studentName = `e2e数据生${suffix}`;
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

    const loginName = `e2e-data-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: studentName, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生端：iPad 独立 context，课程练习作答（判断对 + 手写笔迹）并交卷 ——
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
        .getByRole("link", { name: `打开练习 ${unitName}（2 题）` })
        .click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
      );
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");

      // 第 1 题判断：答「对」（可自动判分 → 答对）
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await q1
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      // 第 2 题手写：展开手写区 + 画一笔；最终答案留空（只写笔迹 → 交卷后待批）
      const q2 = studentPage.locator('article[aria-label="第 2 题"]');
      await q2.getByRole("button", { name: "展开手写区" }).click();
      const canvas = q2.locator("canvas[data-slot=ink-canvas]");
      await expect(canvas).toBeVisible();
      await handwriteOneStroke(studentPage, canvas);
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

    // —— 教师端 UI：登录 → 打开 /t/data（默认按课程视图）——
    await page.goto("/t/login");
    await page.fill("#login-name", TEACHER_LOGIN_NAME);
    await page.fill("#login-password", TEACHER_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");

    await page.goto("/t/data");
    // 默认按课程视图：课程分组头 + 该练习卡片（学生名 + 来源上下文 + 已交卷 + 待批）
    await expect(page.getByRole("heading", { name: courseName })).toBeVisible();
    const card = page.getByRole("link", {
      name: `查看 ${studentName} 的作答详情（已交卷）`,
    });
    await expect(card).toBeVisible();
    await expect(card.getByText("课程练习", { exact: true })).toBeVisible();
    await expect(
      card.getByText(`${courseName} · ${unitName} · 第 1 次`),
    ).toBeVisible();
    await expect(card.getByText("待批 1")).toBeVisible();
    await expect(card.getByText("100", { exact: true })).toBeVisible();

    // —— 详情：来源头 + 得分汇总 + 逐题 + 手写缩略图放大 ——
    await card.click();
    await page.waitForURL("**/t/data/attempts/**");
    await expect(
      page.getByRole("heading", { name: studentName }),
    ).toBeVisible();
    await expect(page.getByText("已交卷", { exact: true })).toBeVisible();
    await expect(page.getByText(`课程：${courseName} · 第 1 次`)).toBeVisible();
    await expect(page.getByText("答对 1 题")).toBeVisible();
    await expect(page.getByText("答错 0 题")).toBeVisible();
    await expect(page.getByText("待批 1 题")).toBeVisible();
    await expect(page.getByText("未批", { exact: true })).toBeVisible();
    // 逐题（单单元不显示节头）：第 1 题判对、第 2 题待批（手写）
    await expect(
      page.locator('article[aria-label="第 1 题"]').getByText("答对"),
    ).toBeVisible();
    const q2Card = page.locator('article[aria-label="第 2 题"]');
    await expect(q2Card.getByText("待批", { exact: true })).toBeVisible();
    await expect(q2Card.getByText("学生答案：").first()).toBeVisible();

    // 手写缩略图（教师端 PNG 直出）+ 点击放大 lightbox + 关闭
    const inkImg = q2Card.locator('img[alt="第 2 题的手写笔迹"]');
    await expect(inkImg).toBeVisible();
    // naturalWidth > 0 才算真的拿到了 PNG（同 main-flow 的口径）
    await expect
      .poll(async () =>
        inkImg.evaluate((el: HTMLImageElement) => el.naturalWidth),
      )
      .toBeGreaterThan(0);
    await q2Card
      .getByRole("button", { name: "放大查看第 2 题的手写笔迹" })
      .click();
    const lightbox = page.locator('[aria-label="手写笔迹放大查看"]');
    await expect(lightbox).toBeVisible();
    const zoomedImg = lightbox.locator("img");
    await expect
      .poll(async () =>
        zoomedImg.evaluate((el: HTMLImageElement) => el.naturalWidth),
      )
      .toBeGreaterThan(0);
    await lightbox.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(lightbox).not.toBeVisible();

    // —— 返回数据页（筛选 URL 保留）→ 切按学生视图仍可见 ——
    await page.getByRole("button", { name: "返回数据页" }).click();
    await page.waitForURL("**/t/data");
    await expect(page.getByRole("heading", { name: courseName })).toBeVisible();

    await page.getByRole("button", { name: "按学生" }).click();
    await expect(page).toHaveURL(/\/t\/data\?view=student/);
    const studentCard = page.getByRole("link", {
      name: `查看 ${studentName} 的作答详情（已交卷）`,
    });
    await expect(
      page.getByRole("heading", { name: studentName }),
    ).toBeVisible();
    await expect(studentCard).toBeVisible();
    await expect(
      studentCard.getByText(`${courseName} · ${unitName} · 第 1 次`),
    ).toBeVisible();
  });
});
