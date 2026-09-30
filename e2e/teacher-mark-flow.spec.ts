import { devices, expect, test } from "@playwright/test";
import {
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  handwriteOneStroke,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T3.2b 批注与待批队列（D3/D4）：学生作答（判断对 + 手写题只写笔迹不填最终
 * 答案）交卷 → 教师打开 /t/data/pending 按学生筛出该手写题卡片（参考答案/
 * 未作答（仅笔迹）/笔迹缩略图/来源上下文）→ 评语框填评语后键盘 1 标对 →
 * 队列清空、进度 1/1、刷新后空态「没有待批题」→ 详情页见教师判定与评语、
 * 状态已批改 → 学生端刷新作业状态「已批改」。全程学生端网络层泄露拦截不变。
 */

/** 两题小作业：判断（可自动判分）+ solve 手写（最终答案留空 → 待批，落笔迹） */
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

test.describe("教师批改流（T3.2b：待批队列 → 学生已批）", () => {
  test("学生手写题只写笔迹交卷，教师队列键盘批改并留评语，学生端作业「已批改」", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(150_000);

    // —— 造数（教师 API）：专属课程 + 两题单元 + 学生 + 按课布置作业 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e批改课程${suffix}`;
    const unitName = `有理数批改小练${suffix}`;
    const assignmentTitle = `E2E批改作业${suffix}`;
    const studentName = `e2e批改生${suffix}`;
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
    // 导入响应带 DSL 单元 id（作业 unitIds 用；作业通道与课程可见性无关，隐藏即可）
    const importBody = (await importRes.json()) as {
      data: { units: { id: string }[] };
    };
    const unitId = importBody.data.units[0]?.id;
    if (unitId === undefined) {
      throw new Error("导入响应缺少单元 id");
    }

    const loginName = `e2e-mark-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: studentName, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    const assignmentRes = await request.post("/api/teacher/assignments", {
      data: {
        unitIds: [unitId],
        studentIds: [student.id],
        title: assignmentTitle,
        courseId,
      },
    });
    if (!assignmentRes.ok()) {
      throw new Error(`布置作业失败：HTTP ${assignmentRes.status()}`);
    }

    // —— 学生端：iPad 独立 context，作答（判断对 + 手写只写笔迹）并交卷 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      const studentCard = studentPage.locator("li", {
        hasText: assignmentTitle,
      });
      await expect(studentCard).toHaveCount(1);
      await expect(studentCard.getByText("未开始")).toBeVisible();
      await studentCard.getByRole("link", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/assignments/**");

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
      // 判对 1（判断）+ 待批 1（手写只写笔迹）
      await expect(studentPage.getByText("答对 1 题")).toBeVisible();
      await expect(studentPage.getByText("待批 1 题")).toBeVisible();
      expect(leak.violations().join("\n")).toBe("");

      // —— 教师端 UI：登录 → 待批队列（按学生筛选隔离并行 worker 的数据）——
      await page.goto("/t/login");
      await page.fill("#login-name", TEACHER_LOGIN_NAME);
      await page.fill("#login-password", TEACHER_PASSWORD);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL("**/t/library");

      await page.goto("/t/data/pending");
      // 学生下拉选项异步加载（useStudents）；option 在合拢的 select 里恒为
      // hidden，等 attached 而不是 visible
      await page
        .locator("#pending-student-filter option", { hasText: studentName })
        .waitFor({ state: "attached" });
      await page.selectOption("#pending-student-filter", {
        label: studentName,
      });
      const card = page.locator(
        `article[aria-label="待批卡片：${studentName}"]`,
      );
      await expect(card).toBeVisible();
      // 卡片要素：参考答案 / 学生最终答案（未作答仅笔迹）/ 手写缩略图 / 来源上下文
      await expect(card.getByText("参考答案：")).toBeVisible();
      await expect(card.getByText("3", { exact: true })).toBeVisible();
      await expect(card.getByText("未作答（仅笔迹）")).toBeVisible();
      const inkImg = card.locator('img[alt*="手写笔迹"]');
      await expect(inkImg).toBeVisible();
      await expect
        .poll(async () =>
          inkImg.evaluate((el: HTMLImageElement) => el.naturalWidth),
        )
        .toBeGreaterThan(0);
      // 来源上下文（assignment 来源：作业标题（课程名））
      await expect(
        card.getByText(`${assignmentTitle}（${courseName}）`),
      ).toBeVisible();
      // 进度 0/1（进入时队列总数 1）
      await expect(page.getByTestId("mark-progress")).toHaveText("0/1");

      // 评语框填评语 → 键盘 1 标对（评语随判定一并提交）。fill 后焦点在
      // 评语框内（快捷键被输入守卫跳过），先 Tab 移出再按键。
      await page.fill("#pending-comment-input", "过程清晰，答对了");
      await page.keyboard.press("Tab");
      await page.keyboard.press("1");
      // 队列清空 + 进度 1/1
      await expect(card).toHaveCount(0);
      await expect(page.getByText("本组待批题已全部批完")).toBeVisible();
      await expect(page.getByTestId("mark-progress")).toHaveText("1/1");
      // 刷新后服务端确已无待批（空态「没有待批题」）
      await page.reload();
      await page
        .locator("#pending-student-filter option", { hasText: studentName })
        .waitFor({ state: "attached" });
      await page.selectOption("#pending-student-filter", {
        label: studentName,
      });
      await expect(page.getByText("没有待批题")).toBeVisible();

      // —— 教师详情页：教师判定 / 评语 / 已批改状态（D2 联动核对）——
      await page.goto(`/t/data?studentId=${student.id}`);
      const detailLink = page.getByRole("link", {
        name: `查看 ${studentName} 的作答详情（已批改）`,
      });
      await expect(detailLink).toBeVisible();
      // 数据页有同名筛选项（select option），徽章断言限定在卡片链接内
      await expect(
        detailLink.getByText("已批改", { exact: true }),
      ).toBeVisible();
      await detailLink.click();
      await page.waitForURL("**/t/data/attempts/**");
      // 数据页→详情切换的瞬间旧页仍在 DOM（严格模式撞同名筛选项），
      // 先等详情头渲染，徽章断言限定在页头卡片内
      await expect(
        page.getByRole("heading", { name: studentName }),
      ).toBeVisible();
      await expect(
        page.locator("header").getByText("已批改", { exact: true }),
      ).toBeVisible();
      // 最终得分大数字（2/2 题判对 → 100；scoreAuto 也是 100，用大字号定位区分）
      await expect(page.locator("b.text-2xl")).toHaveText("100");
      const q2Detail = page.locator('article[aria-label="第 2 题"]');
      // 判定区（dl 内的 dd；内联编辑按钮同文案，用 dl 作用域区分）
      await expect(
        q2Detail.locator("dl").getByText("判对", { exact: true }),
      ).toBeVisible();
      // 评语同时出现在判定区 dd 与编辑框初始值（textarea 子文本节点），限定 dl
      await expect(
        q2Detail.locator("dl").getByText("过程清晰，答对了"),
      ).toBeVisible();

      // —— 学生端刷新：作业状态「已批改」（得分徽章数据源为 attempt.status）——
      await studentPage.goto("/s/home");
      const gradedCard = studentPage.locator("li", {
        hasText: assignmentTitle,
      });
      await expect(gradedCard).toHaveCount(1);
      await expect(gradedCard.getByText("已批改")).toBeVisible();

      // 泄露检查：批改前后所有 /api/student/* 响应无禁用键、无提示/详解原文
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
