import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  ensureDefaultCourse,
  getStudentViaApi,
  handwriteOneStroke,
  importJudgeUnit,
  importPracticeSample,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T2.13 主流程：教师建学生与作业 → 学生链接登录 → 答客观题（判断/单选/多选/
 * 填空）+ 鼠标模拟手写一道题 → 交卷 → 看结果；全程对学生端响应做泄露检查。
 * 内容准备（导入练习样例）按任务口径走教师 API，其余教师操作走 UI。
 * T2A.7：布置作业改走三步向导（对象 → 内容 → 确认），作业含两个单元
 * （练习四 8 题 + 追加的判断题小单元 1 题，共 9 题），学生答题页按单元分节、
 * 题号全卷连续；判分口径（2026-10-02 fill 改全人工批改后）= 可自动判分 5 题
 * （判断/单选/多选 + solve 最终答案 + 追加判断题），练习四的填空 2 题（第 4、
 * 5 题，均有作答）不再自动判对错 → 与手写未答 2 题（第 7、8 题）共 4 题待批。
 */
test.describe("主流程：布置作业 → 学生作答与交卷 → 结果与泄露检查", () => {
  test("教师 UI 建学生经三步向导布置两单元作业，学生答完客观题并手写一题后交卷", async ({
    page,
    request,
    browser,
  }) => {
    // 本机 ~15s；CI 2 核 runner + vite 冷编译 40-60s。与全局一致并显式声明：
    // 卡死时 120s 快速失败（重试由 config 的 CI retries 吸收抖动），不拖满 job
    test.setTimeout(120_000);

    // —— 准备：教师 API 会话（首个用例负责 setup 教师）+ 导入两个练习单元 ——
    //     （练习四 8 题 + 唯一后缀的判断题小单元 1 题，进同一默认课程）
    await teacherApiLogin(request);
    await importPracticeSample(request);
    const extraUnitName = `e2e加练小单元${uniqueSuffix()}`;
    await importJudgeUnit(
      request,
      await ensureDefaultCourse(request),
      extraUnitName,
    );

    // —— 教师端 UI：登录（教师已由 API setup，走密码登录页）——
    await page.goto("/t/login");
    await page.fill("#login-name", TEACHER_LOGIN_NAME);
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
    const student = await getStudentViaApi(request, studentName);
    // T2A.5（D5）：学生能看到课程内容的前提是课程成员——导入挂默认课程，这里入成员
    await addCourseMemberViaApi(
      request,
      await ensureDefaultCourse(request),
      student.id,
    );

    // —— 教师端 UI：布置作业（T2A.7 三步向导：①对象 → ②内容 → ③确认）——
    //     标题唯一化：两个浏览器项目并行跑同一份数据，不能断言全局计数。
    //     课程下拉的「默认课程」option 文案带动态成员数，按文本定位后取 value 选中。
    const assignmentTitle = `E2E作业${uniqueSuffix()}`;
    await page.goto("/t/assignments");
    await page.getByRole("button", { name: "布置作业" }).first().click();

    // ① 对象：选「默认课程」→ 名单自动带出该学生（D13 默认全选，保持勾选）
    const courseOption = page.locator("#wizard-course option", {
      hasText: "默认课程",
    });
    await expect(courseOption).toHaveCount(1);
    const defaultCourseValue = await courseOption.getAttribute("value");
    if (defaultCourseValue === null) {
      throw new Error("「默认课程」option 缺少 value");
    }
    await page.selectOption("#wizard-course", defaultCourseValue);
    const studentCheck = page.getByRole("checkbox", { name: studentName });
    await expect(studentCheck).toBeVisible();
    await expect(studentCheck).toBeChecked();
    await page.getByRole("button", { name: "下一步", exact: true }).click();

    // ② 内容：「本课程练习」页签按可访问名勾选 练习四 + 新单元（勾选顺序 =
    //    作答顺序，练习四在前）。追加单元导入后在目录默认隐藏（D23-3）——页签
    //    含隐藏条目并标注状态，可直接选（作业通道与课程可见性无关）。
    const courseUnitList = page.getByRole("list", {
      name: "本课程练习单元列表",
    });
    await expect(courseUnitList).toBeVisible();
    const practiceCheck = courseUnitList.getByRole("checkbox", {
      name: /练习四/,
    });
    await expect(practiceCheck).toHaveCount(1);
    const extraRow = courseUnitList.locator("li", { hasText: extraUnitName });
    await expect(extraRow).toHaveCount(1);
    await expect(extraRow.getByText("隐藏", { exact: true })).toBeVisible();
    await practiceCheck.check();
    await extraRow.getByRole("checkbox").check();
    await expect(page.getByText("已选 2 个单元 · 共 9 题")).toBeVisible();
    await page.getByRole("button", { name: "下一步", exact: true }).click();

    // ③ 确认：组合方式默认「每个单元一份」（2026-10）——本用例保持合并口径，
    //    显式切「合并为一份作业」；D15「已做过」检查完成（该学生没做过课程练习
    //    → 无提示行）；内容摘要按作答顺序分节；填唯一化标题后提交
    await page.getByRole("radio", { name: /合并为一份作业/ }).check();
    await expect(page.locator("#wizard-title")).toBeVisible();
    await expect(
      page.getByText("正在检查名单学生在课程练习中的已做过记录…"),
    ).toHaveCount(0);
    await expect(
      page.getByText("以下学生已在课程练习中做过所选单元"),
    ).not.toBeVisible();
    await expect(
      page.getByText("作业内容（按作答顺序，共 9 题）"),
    ).toBeVisible();
    await expect(page.getByText("1. 练习四（8 题）")).toBeVisible();
    await expect(page.getByText(`2. ${extraUnitName}（1 题）`)).toBeVisible();
    await page.fill("#wizard-title", assignmentTitle);
    await page
      .getByRole("button", { name: "布置作业（2 个单元 · 9 题）" })
      .click();

    // 弹层关闭 + 列表出现本 run 的作业卡片（含单元清单与合计 9 题）
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const assignmentCard = page.locator("li", { hasText: assignmentTitle });
    await expect(assignmentCard).toHaveCount(1);
    await expect(assignmentCard.getByText("共 9 题")).toBeVisible();
    await expect(assignmentCard.getByText("练习四（8 题）")).toBeVisible();
    await expect(
      assignmentCard.getByText(`${extraUnitName}（1 题）`),
    ).toBeVisible();

    // —— 学生端：独立 context（教师/学生会话共用同一 Cookie 名，避免互相覆盖）——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      // 泄露检查：链接登录之前挂上拦截（交卷后的响应允许答案，见 helper）
      const leak = attachLeakMonitor(studentPage);

      // 专属链接登录：打开 /s/:token 自动写会话并进首页
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      await expect(studentPage.getByText(studentName).first()).toBeVisible();

      // 作业卡（多单元口径）：「n 个单元（…）」+ 合计题数；进入作业（not_started
      // 入口文案「开始练习」，按本 run 的标题圈定卡片，避免并行作业卡片干扰）
      const studentCard = studentPage.locator("li", {
        hasText: assignmentTitle,
      });
      await expect(studentCard).toHaveCount(1);
      await expect(
        studentCard.getByText(`2 个单元（练习四、${extraUnitName}）`),
      ).toBeVisible();
      await expect(studentCard.getByText("共 9 题")).toBeVisible();
      await studentCard.getByRole("link", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/assignments/**");
      await expect(
        studentPage.locator('article[aria-label="第 1 题"]'),
      ).toBeVisible();
      await expect(
        studentPage.locator('article[aria-label="第 9 题"]'),
      ).toBeVisible();
      // 多单元按布置顺序分节（T2A.7）：答题页渲染单元节标题，练习四在前
      const unitHeaders = studentPage.locator("h2");
      await expect(unitHeaders).toHaveCount(2);
      await expect(unitHeaders.nth(0)).toHaveText("练习四");
      await expect(unitHeaders.nth(1)).toHaveText(extraUnitName);

      // —— 答客观题（练习四 8 题 = 判断/单选/多选/填空×2/手写×3；题号全卷连续，
      //     第 9 题 = 追加单元的判断题）——
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

      // —— 第 9 题（追加单元的判断题，可自动判分）：答「对」——
      const q9 = studentPage.locator('article[aria-label="第 9 题"]');
      await q9
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();

      // 文本类答案有 600ms 防抖：等保存完成（顶栏三态回到「已保存」）
      await expect
        .poll(async () => studentPage.getByTestId("draft-status").textContent())
        .not.toContain("保存中");

      // —— 交卷：已答 7/9（第 7、8 题手写未答）→ 确认弹层 → 服务端判分 ——
      await expect(studentPage.getByText("已答 7 / 9 题")).toBeVisible();
      await studentPage
        .getByRole("button", { name: "交卷", exact: true })
        .click();
      await expect(studentPage.getByText("确认交卷吗？")).toBeVisible();
      await expect(studentPage.getByText("还有 2 题没有作答")).toBeVisible();
      await studentPage
        .getByRole("button", { name: "确认交卷" })
        .first()
        .click();

      // —— 结果视图：得分汇总 + 分节标题 + 逐题对错 + 手写笔迹缩略图 ——
      await expect(studentPage.getByText("批改结果")).toBeVisible({
        timeout: 30_000,
      });
      // 5 道可自动判分题（判断/单选/多选 + solve 最终答案 + 第 9 题判断）全对 →
      // scoreAuto=100；共 9 题 = 答对 5 + 待批 4（填空第 4、5 题——fill 全人工
      // 批改后不自动判对错 + 手写未答第 7、8 题），未答 2 = 手写第 7、8 题
      await expect(studentPage.getByText("100", { exact: true })).toBeVisible();
      await expect(studentPage.getByText("共 9 题")).toBeVisible();
      await expect(studentPage.getByText("答对 5 题")).toBeVisible();
      await expect(studentPage.getByText("答错 0 题")).toBeVisible();
      await expect(studentPage.getByText("待批 4 题")).toBeVisible();
      await expect(studentPage.getByText("未答 2 题")).toBeVisible();

      // 多单元分节（结果视图 h3 = 单元标题，按布置顺序）；题号 1–9 连续
      const resultUnitHeaders = studentPage.locator("h3");
      await expect(resultUnitHeaders).toHaveCount(2);
      await expect(resultUnitHeaders.nth(0)).toHaveText("练习四");
      await expect(resultUnitHeaders.nth(1)).toHaveText(extraUnitName);
      await expect(studentPage.locator("article[aria-label]")).toHaveCount(9);

      const r1 = studentPage.locator('article[aria-label="第 1 题"]');
      await expect(r1.getByText("答对", { exact: true })).toBeVisible();
      const r3 = studentPage.locator('article[aria-label="第 3 题"]');
      await expect(r3.getByText("答对", { exact: true })).toBeVisible();
      // 第 9 题（追加单元判断题）答「对」判对
      const r9 = studentPage.locator('article[aria-label="第 9 题"]');
      await expect(r9.getByText("答对", { exact: true })).toBeVisible();
      const r7 = studentPage.locator('article[aria-label="第 7 题"]');
      await expect(r7.getByText("待批改", { exact: true })).toBeVisible();
      // 填空第 4 题（3 空，均已作答）不再自动判分 → 待批改（2026-10-02 口径）
      const r4 = studentPage.locator('article[aria-label="第 4 题"]');
      await expect(r4.getByText("待批改", { exact: true })).toBeVisible();

      // 手写题笔迹缩略图：学生本人 PNG 直出，naturalWidth>0 才算真的画出来了
      // （toBeVisible 不等图片加载完成——单次 evaluate 会踩解码竞态，
      // expect.poll 轮询到解码完成为止）
      const r6 = studentPage.locator('article[aria-label="第 6 题"]');
      const inkImg = r6.locator('img[alt*="手写笔迹"]');
      await expect(inkImg).toBeVisible();
      await expect
        .poll(() => inkImg.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBeGreaterThan(0);

      // —— 泄露检查：交卷前所有 /api/student/* 响应无禁用键、无提示/详解原文 ——
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
