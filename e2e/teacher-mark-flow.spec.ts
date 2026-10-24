import { devices, expect, test } from "@playwright/test";
import {
  attachLeakMonitor,
  createCourseViaApi,
  expectResultCount,
  getStudentViaApi,
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
 *
 * 2026-10-02 fill 改全人工批改（防回归核心流，第二用例）：学生答含 LaTeX
 * 等价答案的填空题（[[\frac{1}{2}|0.5]] 型）交卷 → 学生端该题「待批改」、
 * 汇总「待批 1 题」（fill 不再自动判对错）→ 教师队列键盘 1 批对 → 学生端
 * 「我的记录」查看结果见判对、最终得分与渲染成公式的参考答案（.katex 节点
 * 存在、无裸 \frac 文本——参考答案显示侧 LaTeX 启发式的端到端防线）。
 */

/**
 * 第二用例的两题小作业：判断（自动判分）+ fill（LaTeX 等价答案
 * [[\frac{1}{2}|0.5]] 型——标记内禁 $ 是 lint 红线，答案存为裸 LaTeX，由
 * 显示侧 mathifyAnswerText 包 $ 走 KaTeX；全人工批改 → 交卷进待批）。
 */
function fillPracticeMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 分数加法",
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
    '::::question{type=fill difficulty=2 knowledge="分数加法"}',
    "计算：$\\frac{1}{8}+\\frac{3}{8}=$ [[\\frac{1}{2}|0.5]]（填分数或小数均可）。",
    "",
    ":::solution",
    "$\\frac{1}{8}+\\frac{3}{8}=\\frac{4}{8}=\\frac{1}{2}$。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

test.describe("教师批改流（T3.2b：待批队列 → 学生已批）", {
  tag: ["@teacher"],
}, () => {
  test("学生填空题（LaTeX 等价答案）交卷进待批，教师批对后学生端见判对与公式化参考答案", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(150_000);

    // —— 造数（教师 API）：专属课程 + 判断/fill 两题单元 + 学生 + 按课布置作业 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e填空批改课程${suffix}`;
    const unitName = `分数加法批改小练${suffix}`;
    const assignmentTitle = `E2E填空批改作业${suffix}`;
    const studentName = `e2e填空批改生${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: fillPracticeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入练习失败：HTTP ${importRes.status()}`);
    }
    const importBody = (await importRes.json()) as {
      data: { units: { id: string }[] };
    };
    const unitId = importBody.data.units[0]?.id;
    if (unitId === undefined) {
      throw new Error("导入响应缺少单元 id");
    }

    const loginName = `e2e-fillmark-${suffix}`;
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

    // —— 学生端：iPad 独立 context，答判断（对）+ 填空（0.5，等价答案之一）交卷 ——
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
      await studentCard.getByRole("link", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/assignments/**");

      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await q1
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      const q2 = studentPage.locator('article[aria-label="第 2 题"]');
      await q2.getByLabel("第1空").fill("0.5");
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
      // 判断题自动判对；fill 全人工批改 → 不自动判对错：该题「待批改」、
      // 汇总「待批 1 题」（未批完不显示最终得分）
      await expectResultCount(studentPage, "答对", 1);
      await expectResultCount(studentPage, "待批", 1);
      const q2Pending = studentPage.locator('article[aria-label="第 2 题"]');
      await expect(
        q2Pending.getByText("待批改", { exact: true }),
      ).toBeVisible();
      expect(leak.violations().join("\n")).toBe("");

      // —— 教师端 UI：登录 → 待批队列按学生筛出该填空题 → 键盘 1 批对 ——
      await page.goto("/t/login");
      await page.fill("#login-name", TEACHER_LOGIN_NAME);
      await page.fill("#login-password", TEACHER_PASSWORD);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL("**/t/library");

      await page.goto("/t/data/pending");
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
      // 学生最终答案 0.5 在卡；参考答案（\frac{1}{2} 或 0.5）走显示侧 LaTeX
      // 启发式包 $ 渲染成公式——教师侧卡片同样以 .katex 呈现
      await expect(card.getByText("学生最终答案：")).toBeVisible();
      await expect(card.getByText("0.5").first()).toBeVisible();
      await expect(card.locator(".katex").first()).toBeVisible();
      // 点卡内非交互文本把焦点移出筛选 select（快捷键守卫跳过 SELECT 上的按键），
      // 再按 1 批对
      await card.getByText("学生最终答案：").click();
      await page.keyboard.press("1");
      await expect(card).toHaveCount(0);
      await expect(page.getByText("本组待批题已全部批完")).toBeVisible();

      // —— 学生端「我的记录」→ 查看结果：判对 + 最终得分 + 公式化参考答案 ——
      await studentPage.goto("/s/records");
      const recordLink = studentPage.getByRole("link", {
        name: `查看结果：${assignmentTitle}（已批改）`,
      });
      await expect(recordLink).toBeVisible();
      await recordLink.click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(studentPage.getByText("批改结果")).toBeVisible();
      await expect(
        studentPage.getByText("最终得分", { exact: true }),
      ).toBeVisible();
      await expect(
        studentPage.getByText("含老师批改，满分 100", { exact: true }),
      ).toBeVisible();
      await expect(studentPage.locator("span.text-4xl")).toHaveText("100");
      await expectResultCount(studentPage, "待批", 0);
      const q2Final = studentPage.locator('article[aria-label="第 2 题"]');
      await expect(q2Final.getByText(/老师批改：判对/)).toBeVisible();
      await expect(q2Final.getByLabel("答对")).toBeVisible();
      // 参考答案容器：等价答案「\frac{1}{2}（裸 LaTeX 显示侧包 $ 走 KaTeX）
      // 或 0.5」——公式节点恰 1 个；除 KaTeX 的 mathml 注释（TeX 源，辅助技术
      // 用）外无裸 \frac 文本，即答案确以公式呈现而非明文
      const refAnswer = q2Final
        .getByText("参考答案：", { exact: true })
        .locator("..");
      await expect(refAnswer.locator(".katex")).toHaveCount(1);
      const bareText = await refAnswer.evaluate((el) => {
        const clone = el.cloneNode(true) as HTMLElement;
        for (const node of clone.querySelectorAll(".katex-mathml")) {
          node.remove();
        }
        return clone.textContent ?? "";
      });
      expect(bareText).not.toContain("\\frac");

      // 泄露检查：批改前后所有 /api/student/* 响应无禁用键、无提示/详解原文
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
