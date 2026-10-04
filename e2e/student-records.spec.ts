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
 * T3.5 学生「我的记录」与错题本（D9/D10/D11）——T3.2b 批改用例的延伸：
 * 学生作答（判断题**答错** + 手写题只写笔迹不填最终答案）交卷 → 教师待批队列
 * 评语 + 键盘 1 标对手写题 → 学生刷新「我的记录」看到该条目「已批改」徽章与
 * 得分（50 = 1/2）→ 进结果视图见老师评语与最终判定（手写题判对、判断题答错、
 * 最终得分大数字）→ 错题本出现做错的判断题（首次做错标记、本人最近答案、
 * 正确答案、详解折叠展开）。全程学生端网络层泄露拦截不变（交卷后放行口径
 * 与 teacher-mark-flow 一致）。
 */

/** 两题小作业：判断（学生答错 → 进错题本）+ solve 手写（只写笔迹 → 待批，落评语） */
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

test.describe("学生我的记录与错题本（T3.5：批改延伸）", () => {
  test("学生答错判断+手写交卷，教师批改后学生在我的记录见「已批」与评语，错题本出现错题", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(150_000);

    // —— 造数（教师 API）：专属课程 + 两题单元 + 学生 + 按课布置作业 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e记录课程${suffix}`;
    const unitName = `有理数记录小练${suffix}`;
    const assignmentTitle = `E2E记录作业${suffix}`;
    const studentName = `e2e记录生${suffix}`;
    const commentText = `字迹工整，这题对了${suffix}`;
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
    const importBody = (await importRes.json()) as {
      data: { units: { id: string }[] };
    };
    const unitId = importBody.data.units[0]?.id;
    if (unitId === undefined) {
      throw new Error("导入响应缺少单元 id");
    }

    const loginName = `e2e-records-${suffix}`;
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

    // —— 学生端：iPad 独立 context，作答（判断答错 + 手写只写笔迹）并交卷 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      const studentCard = studentPage.locator("li", {
        hasText: assignmentTitle,
      });
      await studentCard.getByRole("link", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/assignments/**");

      // 第 1 题判断：答「错」（可自动判分 → 答错，进错题本）
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await q1
        .getByRole("radio", { name: "错", exact: true })
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
      // 判错 1（判断答错）+ 待批 1（手写只写笔迹）
      await expect(studentPage.getByText("答错 1 题")).toBeVisible();
      await expect(studentPage.getByText("待批 1 题")).toBeVisible();
      expect(leak.violations().join("\n")).toBe("");

      // —— 教师端 UI：登录 → 待批队列 → 评语 + 键盘 1 标对（同 T3.2b 流程）——
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
      // 评语框填评语 → 键盘 1 标对（评语随判定一并提交；先 Tab 移出输入守卫）
      await page.fill("#pending-comment-input", commentText);
      await page.keyboard.press("Tab");
      await page.keyboard.press("1");
      // 队列清空 + 空态出现（空态来自 refetch，确保服务端已落库再切学生端）
      await expect(card).toHaveCount(0);
      await expect(page.getByText("本组待批题已全部批完")).toBeVisible();

      // —— 学生端：「我的记录」看到该条目「已批改」徽章与得分（1/2 = 50）——
      await studentPage.goto("/s/records");
      const recordLink = studentPage.getByRole("link", {
        name: `查看结果：${assignmentTitle}（已批改）`,
      });
      await expect(recordLink).toBeVisible();
      // 来源徽章（exact：标题本身也含「作业」两字）；得分同样 exact——
      // 随机后缀里可能恰好含「50」子串，模糊匹配会撞标题/课程名（曾致 flake）
      await expect(recordLink.getByText("作业", { exact: true })).toBeVisible();
      await expect(recordLink.getByText("50", { exact: true })).toBeVisible();
      // 2026-10 IA 调整：错题本入口升为顶栏导航（记录页页头入口已移除）
      await expect(
        studentPage.getByRole("link", { name: "错题本" }),
      ).toBeVisible();

      // —— 进结果视图：老师评语与最终判定（D9）——
      await recordLink.click();
      await studentPage.waitForURL("**/s/attempts/**");
      // 汇总：最终得分大数字 50（text-4xl 定位，避开随机后缀里的同数字子串）
      // + 「含老师批改」标签；待批 0
      await expect(studentPage.locator("span.text-4xl")).toHaveText("50");
      await expect(studentPage.getByText(/最终得分（含老师批改/)).toBeVisible();
      // 手写题（第 2 题）：老师批改块「判对」+ 评语；图标答对
      const q2Result = studentPage.locator('article[aria-label="第 2 题"]');
      await expect(q2Result.getByText(/老师批改：判对/)).toBeVisible();
      await expect(q2Result.getByText(commentText)).toBeVisible();
      await expect(q2Result.getByLabel("答对")).toBeVisible();
      // 判断题（第 1 题）：答错（无批改块）
      const q1Result = studentPage.locator('article[aria-label="第 1 题"]');
      await expect(q1Result.getByLabel("答错")).toBeVisible();
      await expect(q1Result.getByText(/老师批改/)).toHaveCount(0);

      // —— 错题本（D11；2026-10 轮次史视图）：默认待复习 + 按练习分组 ——
      await studentPage.goto("/s/wrong");
      // 组头 = 归属单元标题 + 待复习计数（按练习分组的依据是题目归属单元）
      await expect(
        studentPage.getByRole("heading", {
          name: `${unitName} · 待复习 1 题`,
        }),
      ).toBeVisible();
      // 紧凑行（默认形态）：错 1 · 对 0；手写题已批对 → 不在错题本
      const wrongRow = studentPage.getByRole("button", { name: /错 1 · 对 0/ });
      await expect(wrongRow).toBeVisible();
      await expect(
        studentPage.getByText("有理数加法", { exact: true }),
      ).toHaveCount(0);
      // 点击行展开完整卡片
      await wrongRow.click();
      const wrongCard = studentPage.locator("article", {
        hasText: "有理数的概念",
      });
      await expect(wrongCard).toBeVisible();
      await expect(wrongCard.getByText("首次做错")).toBeVisible();
      // 本人最近答案「错误」（serializeStudentAnswer 的判断题文本口径）与正确答案「对」
      await expect(wrongCard.getByText("我的最近答案：")).toBeVisible();
      await expect(wrongCard.getByText("错误", { exact: true })).toBeVisible();
      await expect(wrongCard.getByText("正确答案：")).toBeVisible();
      await expect(wrongCard.getByText("对", { exact: true })).toBeVisible();
      // 轮次史区块（2026-10）：只做过 1 轮（错）；来源标题与页脚「最近来源」都会
      // 带作业标题（substring 命中两处，取 first）
      await expect(
        wrongCard.getByText("已做错 1 次 · 做对 0 次"),
      ).toBeVisible();
      await expect(wrongCard.getByText("第 1 轮")).toBeVisible();
      await expect(wrongCard.getByText(assignmentTitle).first()).toBeVisible();
      // 详解默认折叠，展开后可见（KaTeX 渲染，用纯文本片段断言）
      await expect(wrongCard.getByText(/大于/)).toHaveCount(0);
      await wrongCard.getByRole("button", { name: /查看详解/ }).click();
      await expect(wrongCard.getByText(/大于/)).toBeVisible();

      // 旧路径 /s/records/wrong 重定向到 /s/wrong（2026-10 路由迁移，书签不 404）
      await studentPage.goto("/s/records/wrong");
      await studentPage.waitForURL("**/s/wrong");

      // 泄露检查：全程 /api/student/* 响应无禁用键、无提示/详解原文（交卷后放行）
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
