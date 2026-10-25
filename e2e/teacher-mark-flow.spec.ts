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
 * 新冻结填空题先对照自评，不进入教师待批；学生自评后，教师仍可从作答详情
 * 改判。验证教师判定优先、最终得分联动、公式化参考答案与网络层防泄露。
 */

/**
 * 两题小作业：判断（自动判分）+ fill（LaTeX 等价答案
 * [[\frac{1}{2}|0.5]] 型——标记内禁 $ 是 lint 红线，答案存为裸 LaTeX，由
 * 显示侧 mathifyAnswerText 包 $ 走 KaTeX；交卷后对照自评，教师可改判）。
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

test.describe("教师改判流：学生自评 → 教师判定优先", {
  tag: ["@teacher"],
}, () => {
  test("填空题对照自评后教师仍可改判，学生端保留公式化参考答案", async ({
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
      // 新冻结行的填空先待学生自评，不混入教师待批；教师随后仍可改判。
      await expectResultCount(studentPage, "答对", 1);
      await expectResultCount(studentPage, "待批", 0);
      await expect(studentPage.getByText("另有 1 题待自评")).toBeVisible();
      const q2Pending = studentPage.locator('article[aria-label="第 2 题"]');
      await expect(
        q2Pending.getByText("已完成，待自评", { exact: true }),
      ).toBeVisible();
      await q2Pending
        .getByRole("button", { name: "错了", exact: true })
        .click();
      await expect(
        q2Pending.getByText("自评错误", { exact: true }),
      ).toBeVisible();
      expect(leak.violations().join("\n")).toBe("");

      // —— 教师端 UI：登录 → 作答详情改判，教师判定覆盖学生自评 ——
      await page.goto("/t/login");
      await page.fill("#login-name", TEACHER_LOGIN_NAME);
      await page.fill("#login-password", TEACHER_PASSWORD);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL("**/t/library");

      const pending = await request.get("/api/teacher/pending-marks");
      expect(pending.ok()).toBe(true);
      expect(JSON.stringify(await pending.json())).not.toContain(studentName);
      await page.goto(`/t/data?view=student&studentId=${student.id}`);
      await page
        .getByRole("link", { name: `查看 ${studentName} 的作答详情` })
        .click();
      await page.waitForURL("**/t/data/attempts/**");
      const card = page.locator('article[aria-label="第 2 题"]');
      await expect(card).toBeVisible();
      // 学生最终答案 0.5 在卡；参考答案（\frac{1}{2} 或 0.5）走显示侧 LaTeX
      // 启发式包 $ 渲染成公式——教师侧卡片同样以 .katex 呈现
      await expect(card.getByText("学生答案：").first()).toBeVisible();
      await expect(card.getByText("0.5").first()).toBeVisible();
      await expect(card.locator(".katex").first()).toBeVisible();
      await card.getByRole("button", { name: "判对", exact: true }).click();
      await card
        .getByRole("button", { name: "保存判定与评语", exact: true })
        .click();
      await expect(card.getByText("已保存", { exact: true })).toBeVisible();

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
      await expect(
        q2Final.getByRole("region", { name: "本题评判" }).getByRole("status"),
      ).toHaveText("教师判定：正确");
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
