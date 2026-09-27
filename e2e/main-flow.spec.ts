import { devices, expect, test } from "@playwright/test";
import {
  attachLeakMonitor,
  getStudentLinkToken,
  handwriteOneStroke,
  importPracticeSample,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T2.13 主流程：教师建学生与作业 → 学生链接登录 → 答客观题（判断/单选/多选/
 * 填空）+ 鼠标模拟手写一道题 → 交卷 → 看结果；全程对学生端响应做泄露检查。
 * 内容准备（导入练习样例）按任务口径走教师 API，其余教师操作走 UI。
 */
test.describe("主流程：布置作业 → 学生作答与交卷 → 结果与泄露检查", () => {
  test("教师 UI 建学生布置作业，学生链接登录答完客观题并手写一题后交卷", async ({
    page,
    request,
    browser,
  }) => {
    // 本机 ~15s；CI 2 核 runner + vite 冷编译 40-60s。与全局一致并显式声明：
    // 卡死时 120s 快速失败（重试由 config 的 CI retries 吸收抖动），不拖满 job
    test.setTimeout(120_000);

    // —— 准备：教师 API 会话（首个用例负责 setup 教师）+ 导入练习样例 ——
    await teacherApiLogin(request);
    await importPracticeSample(request);

    // —— 教师端 UI：登录（教师已由 API setup，走密码登录页）——
    await page.goto("/t/login");
    await page.fill("#login-password", TEACHER_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");

    // —— 教师端 UI：建学生（拿到专属链接；初始密码留空由服务端生成）——
    const studentName = `e2e学生${uniqueSuffix()}`;
    await page.goto("/t/students");
    await page.getByRole("button", { name: "新增学生" }).first().click();
    await page.fill("#student-display-name", studentName);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    // 初始密码一次性弹窗（未填密码 → 服务端随机生成）：确认出现后关闭
    await expect(
      page.getByRole("heading", { name: /的初始密码/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expect(page.getByText(studentName).first()).toBeVisible();

    // 学生 token 属教师侧数据（学生端不下发），经教师 API 查询
    const linkToken = await getStudentLinkToken(request, studentName);

    // —— 教师端 UI：布置作业（默认第一个单元=练习四，勾选学生；标题唯一化——
    //     两个浏览器项目并行跑同一份数据，不能断言全局计数）——
    const assignmentTitle = `E2E作业${uniqueSuffix()}`;
    await page.goto("/t/assignments");
    await page.getByRole("button", { name: "布置作业" }).first().click();
    await expect(page.getByText("正在加载单元与学生…")).toBeHidden();
    await expect(page.locator("#assignment-unit option")).toContainText(
      "练习四",
    );
    await page.fill("#assignment-title", assignmentTitle);
    await page.getByRole("checkbox", { name: studentName }).check();
    await page.getByRole("button", { name: "确认布置" }).click();
    // 弹层关闭 + 列表出现本 run 的作业卡片（含指派学生与单元题数）
    await expect(
      page.getByRole("button", { name: "布置作业" }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(assignmentTitle, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(`单元：练习四（8 题）`).first()).toBeVisible();

    // —— 学生端：独立 context（教师/学生会话共用同一 Cookie 名，避免互相覆盖）——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      // 泄露检查：链接登录之前挂上拦截（交卷后的响应允许答案，见 helper）
      const leak = attachLeakMonitor(studentPage);

      // 专属链接登录：打开 /s/:token 自动写会话并进首页
      await studentPage.goto(`/s/${linkToken}`);
      await studentPage.waitForURL("**/s/home");
      await expect(studentPage.getByText(studentName).first()).toBeVisible();

      // 进入作业（not_started 入口文案「开始练习」）
      await studentPage.getByRole("link", { name: "开始练习" }).first().click();
      await studentPage.waitForURL("**/s/assignments/**");
      await expect(
        studentPage.locator('article[aria-label="第 1 题"]'),
      ).toBeVisible();
      await expect(
        studentPage.locator('article[aria-label="第 8 题"]'),
      ).toBeVisible();

      // —— 答客观题（练习样例：8 题 = 判断/单选/多选/填空×2/手写×3）——
      // 选择控件是 sr-only input（label 包裹）：check() 点不中 1px 输入框，
      // 改点可见的 label（与真实用户触屏点按一致，label 会转发给关联控件）
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await q1
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      const q2 = studentPage.locator('article[aria-label="第 2 题"]');
      await q2
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      const q3 = studentPage.locator('article[aria-label="第 3 题"]');
      await q3
        .getByRole("checkbox", { name: "选项 A" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await q3
        .getByRole("checkbox", { name: "选项 C" })
        .locator("xpath=ancestor::label[1]")
        .click();
      const q4 = studentPage.locator('article[aria-label="第 4 题"]');
      await q4.getByLabel("第1空").fill("4");
      await q4.getByLabel("第2空").fill("-7");
      await q4.getByLabel("第3空").fill("0.5");
      const q5 = studentPage.locator('article[aria-label="第 5 题"]');
      await q5.getByLabel("第1空").fill("-3");

      // —— 手写一题（第 6 题 solve：展开手写区 + 鼠标拖动画布 + 最终答案）——
      const q6 = studentPage.locator('article[aria-label="第 6 题"]');
      await q6.getByRole("button", { name: "展开手写区" }).click();
      const canvas = q6.locator("canvas[data-slot=ink-canvas]");
      await expect(canvas).toBeVisible();
      await handwriteOneStroke(studentPage, canvas);
      await q6.getByLabel("最终答案").fill("-3");

      // 文本类答案有 600ms 防抖：等保存完成（顶栏三态回到「已保存」）
      await expect
        .poll(async () => studentPage.getByTestId("draft-status").textContent())
        .not.toContain("保存中");

      // —— 交卷：已答 6/8（第 7、8 题手写未答）→ 确认弹层 → 服务端判分 ——
      await expect(studentPage.getByText("已答 6 / 8 题")).toBeVisible();
      await studentPage
        .getByRole("button", { name: "交卷", exact: true })
        .click();
      await expect(studentPage.getByText("确认交卷吗？")).toBeVisible();
      await expect(studentPage.getByText("还有 2 题没有作答")).toBeVisible();
      await studentPage
        .getByRole("button", { name: "确认交卷" })
        .first()
        .click();

      // —— 结果视图：得分汇总 + 逐题对错 + 手写笔迹缩略图 ——
      await expect(studentPage.getByText("批改结果")).toBeVisible({
        timeout: 30_000,
      });
      // 6 道可自动判分题（5 客观 + solve 最终答案）全对 → scoreAuto=100
      await expect(studentPage.getByText("100", { exact: true })).toBeVisible();
      await expect(studentPage.getByText("共 8 题")).toBeVisible();
      await expect(studentPage.getByText("答对 6 题")).toBeVisible();
      await expect(studentPage.getByText("答错 0 题")).toBeVisible();
      await expect(studentPage.getByText("待批 2 题")).toBeVisible();

      const r1 = studentPage.locator('article[aria-label="第 1 题"]');
      await expect(r1.getByText("答对", { exact: true })).toBeVisible();
      const r3 = studentPage.locator('article[aria-label="第 3 题"]');
      await expect(r3.getByText("答对", { exact: true })).toBeVisible();
      const r7 = studentPage.locator('article[aria-label="第 7 题"]');
      await expect(r7.getByText("待批改", { exact: true })).toBeVisible();

      // 手写题笔迹缩略图：学生本人 PNG 直出，naturalWidth>0 才算真的画出来了
      const r6 = studentPage.locator('article[aria-label="第 6 题"]');
      const inkImg = r6.locator('img[alt*="手写笔迹"]');
      await expect(inkImg).toBeVisible();
      const naturalWidth = await inkImg.evaluate(
        (el: HTMLImageElement) => el.naturalWidth,
      );
      expect(naturalWidth).toBeGreaterThan(0);

      // —— 泄露检查：交卷前所有 /api/student/* 响应无禁用键、无提示/详解原文 ——
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
