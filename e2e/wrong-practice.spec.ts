import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  getStudentViaApi,
  setCourseItemVisible,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 错题重练全链路（2026-10 学生端闭环的最后一块）：
 * 课程练习做错两题 → /s/wrong 按考点分组后「重练本组（1 题）」只练 q1 →
 * 答对交卷（来源行「错题重练 · 第 1 次」）→ 返回错题本：第 2 轮 ✓、严格标准
 * （默认）下仍待复习（只连对 1 次）→ 再重练 q1 答对 → 连续 2 次迁入已攻克 →
 * 我的记录来源=错题重练 → 教师数据页（按作业视图）「错题重练」组可见该卷、
 * CSV 导出来源列「错题重练」。全程学生端网络层泄露拦截。
 *
 * 2026-10 结果页直达重练 + 轮次史可点：做错一题的课程卷结果页出
 * 「练习本卷错题（1 题）」（只计判错）→ 从我的记录卡片进结果页点它 →
 * 新重练卷题数=判错数 → 交卷 → 错题本该题轮次史多一轮且每轮可点回看；
 * 全对卷结果页无该按钮（N=0 隐藏）。
 */

/** 两道判断（考点互不相同：按考点分组时各成一组，可只重练一道） */
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
    '::::question{type=judge difficulty=1 knowledge="正数与负数"}',
    "$-1$ 是负数。[[正确]]",
    "",
    ":::solution",
    "$-1$ 小于 $0$，是负数。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

test.describe("错题重练：组卷 → 作答 → 轮次史/攻克 → 教师端可见", () => {
  test("重练只练一题，两次做对后迁入已攻克；教师数据页与 CSV 来源=错题重练", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(300_000);

    // —— 造数（教师 API）：专属课程 + 两题判断单元放开可见 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e重练课程${suffix}`;
    const unitName = `有理数重练小练${suffix}`;
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
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-repractice-${suffix}`;
    const studentName = `e2e重练生${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: studentName, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生端：iPad 独立 context，全程泄露拦截 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      // —— 第 1 轮课程练习：两题都答错 → 都入错题本 ——
      const unitPath = `/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`;
      await studentPage.goto(unitPath);
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(
        studentPage.getByText(`课程：${courseName} · 第 1 次`),
      ).toBeVisible();
      for (const q of [1, 2]) {
        const card = studentPage.locator(`article[aria-label="第 ${q} 题"]`);
        await card
          .getByRole("radio", { name: "错", exact: true })
          .locator("xpath=ancestor::label[1]")
          .click();
      }
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

      // —— /s/wrong：待复习 2 题；页头有「重练全部（2 题）」——
      await studentPage.goto("/s/wrong");
      await expect(
        studentPage.getByRole("heading", { name: `${unitName} · 待复习 2 题` }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        studentPage.getByRole("button", { name: "重练全部（2 题）" }),
      ).toBeEnabled();

      // —— 切按考点：每题各成一组 → 只重练 q1（有理数的概念组）——
      await studentPage.getByRole("button", { name: "按考点" }).click();
      await expect(studentPage).toHaveURL(/group=knowledge/);
      // 组节有可访问名（组头 aria-label）→ 直接按 region 定位，避免命中页面根节
      const q1Group = studentPage.getByRole("region", {
        name: "有理数的概念 · 待复习 1 题",
      });
      await q1Group.getByRole("button", { name: "重练本组（1 题）" }).click();
      await studentPage.waitForURL("**/s/attempts/**");

      // 重练卷：单题卷、来源行「错题重练 · 第 1 次」（教师改题库也不影响这卷）
      await expect(
        studentPage.getByRole("heading", { name: "错题重练", exact: true }),
      ).toBeVisible();
      await expect(studentPage.getByText("错题重练 · 第 1 次")).toBeVisible();
      await expect(
        studentPage.locator('article[aria-label="第 1 题"]'),
      ).toBeVisible();

      // 答对并交卷
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await q1
        .getByRole("radio", { name: "对", exact: true })
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

      // —— 返回错题本：轮次史新增第 2 轮 ✓（来源「错题重练 · 第 1 次」）；
      //    严格标准（默认）下 q1 只连对 1 次 → 仍待复习 ——
      await studentPage.getByRole("link", { name: "返回错题本" }).click();
      await studentPage.waitForURL("**/s/wrong");
      await expect(
        studentPage.getByRole("button", { name: "待复习 2 题" }),
      ).toBeVisible({ timeout: 30_000 });
      // 展开 q1：紧凑行「错 1 · 对 1」+ 轮次史两轮（第 2 轮 ✓ · 错题重练 · 第 1 次）
      await studentPage.getByRole("button", { name: /1 是正数/ }).click();
      const q1Card = studentPage.locator("article", {
        hasText: "有理数的概念",
      });
      await expect(q1Card.getByLabel("轮次史")).toBeVisible();
      await expect(
        q1Card.getByLabel("轮次史").getByText("已做错 1 次 · 做对 1 次"),
      ).toBeVisible();
      await expect(
        q1Card.getByLabel("轮次史").getByText("错题重练 · 第 1 次"),
      ).toBeVisible();
      await expect(
        q1Card.getByLabel("轮次史").getByText("做对", { exact: true }),
      ).toHaveCount(1);

      // —— 再重练 q1（仍按考点分组）并答对 → 连续 2 次 → 迁入已攻克 ——
      await studentPage.getByRole("button", { name: "按考点" }).click();
      const q1GroupAgain = studentPage.getByRole("region", {
        name: "有理数的概念 · 待复习 1 题",
      });
      await q1GroupAgain
        .getByRole("button", { name: "重练本组（1 题）" })
        .click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(studentPage.getByText("错题重练 · 第 2 次")).toBeVisible();
      const q1Again = studentPage.locator('article[aria-label="第 1 题"]');
      await q1Again
        .getByRole("radio", { name: "对", exact: true })
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

      // —— 回错题本：严格标准下连续 2 次做对 → q1 迁入已攻克（q2 仍待复习）——
      await studentPage.getByRole("link", { name: "返回错题本" }).click();
      await studentPage.waitForURL("**/s/wrong");
      await expect(
        studentPage.getByRole("button", { name: "待复习 1 题" }),
      ).toBeVisible({ timeout: 30_000 });
      await studentPage.getByRole("button", { name: "已攻克 1 题" }).click();
      await expect(studentPage).toHaveURL(/tab=conquered/);
      await expect(
        studentPage.getByRole("button", { name: /1 是正数/ }),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: /-1 是负数/ }),
      ).toHaveCount(0);
      // 空分区外的重练入口：已攻克 tab 的重练全部示数 1（可重练已攻克的题）
      await expect(
        studentPage.getByRole("button", { name: "重练全部（1 题）" }),
      ).toBeEnabled();

      // —— 我的记录：来源筛选=错题重练，两次重练卷都在（含来源徽章/标题） ——
      await studentPage.goto("/s/records?sourceType=wrong");
      await expect(
        studentPage.getByText("错题重练 · 第 1 次").first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        studentPage.getByText("错题重练 · 第 2 次").first(),
      ).toBeVisible();
      // 两次重练各一条记录卡（链接文本含来源标题；避免命中筛选下拉的隐藏选项）
      const wrongRecordCards = studentPage.locator("a", {
        hasText: "错题重练 · 第",
      });
      await expect(wrongRecordCards).toHaveCount(2);

      // 泄露检查：全程 /api/student/* 响应无禁用键、无未解锁提示/详解原文
      //（交卷后的结果视图放行口径不变；wrong-practice 响应只有 attempt 摘要）
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }

    // —— 教师端 UI：数据页按作业视图 + 来源筛选 wrong → 「错题重练」组 ——
    await page.goto("/t/login");
    await page.fill("#login-name", TEACHER_LOGIN_NAME);
    await page.fill("#login-password", TEACHER_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");
    await page.goto("/t/data?view=assignment&sourceType=wrong");
    await expect(page.getByRole("heading", { name: "错题重练" })).toBeVisible({
      timeout: 30_000,
    });
    // 两次重练卷都已批改 → 同名卡片取第一张（按时间倒序为第 2 次）
    const wrongCard = page
      .getByRole("link", {
        name: `查看 ${studentName} 的作答详情（已批改）`,
      })
      .first();
    await expect(wrongCard).toBeVisible();
    await expect(page.getByText("错题重练 · 第 2 次").first()).toBeVisible();
    await expect(page.getByText("错题重练 · 第 1 次").first()).toBeVisible();

    // —— 教师 CSV（API 上下文已登录）：来源类型列「错题重练」——
    const csvRes = await request.get(
      "/api/teacher/export/csv?sourceType=wrong",
    );
    expect(csvRes.ok()).toBe(true);
    const csvText = await csvRes.text();
    expect(csvText).toContain("错题重练");
    expect(csvText).toContain(studentName);
  });
});

test.describe("结果页「练习本卷错题」直达重练 + 轮次史可点（2026-10）", () => {
  test("做错一题的课程卷：结果页按钮只圈判错题 → 新卷单题 → 交卷后轮次史多一轮且可点回看；全对卷无按钮", async ({
    request,
    browser,
  }) => {
    test.setTimeout(300_000);

    // —— 造数（教师 API）：专属课程 + 两题判断单元放开可见 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e结果页重练课程${suffix}`;
    const unitName = `结果页重练小练${suffix}`;
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
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-resultpractice-${suffix}`;
    const studentName = `e2e结果页重练生${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: studentName, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生端：iPad 独立 context，全程泄露拦截 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      // —— 第 1 轮课程练习：q1 答「错」（判错）、q2 答「对」（判对）→ 交卷 ——
      const unitPath = `/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`;
      await studentPage.goto(unitPath);
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      // q1 答「错」（判错）、q2 答「对」（判对）
      await studentPage
        .locator('article[aria-label="第 1 题"]')
        .getByRole("radio", { name: "错", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await studentPage
        .locator('article[aria-label="第 2 题"]')
        .getByRole("radio", { name: "对", exact: true })
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
      // 结果页按钮：示数 = 判错题数（q2 答对不计、未答不计）
      await expect(
        studentPage.getByRole("button", { name: "练习本卷错题（1 题）" }),
      ).toBeVisible();

      // —— 我的记录：该课程练习记录卡存在 → 点击进结果视图 ——
      await studentPage.goto("/s/records");
      const recordCard = studentPage.getByRole("link", {
        name: `查看结果：${unitName} · 第 1 次（已批改）`,
      });
      await expect(recordCard).toBeVisible({ timeout: 30_000 });
      await recordCard.click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(studentPage.getByText("批改结果")).toBeVisible({
        timeout: 30_000,
      });
      const firstAttemptPath = new URL(studentPage.url()).pathname;

      // —— 点「练习本卷错题」→ 新重练卷题数 = 判错数（单题、来源错题重练）——
      await studentPage
        .getByRole("button", { name: "练习本卷错题（1 题）" })
        .click();
      await studentPage.waitForURL(
        (url) => url.pathname !== firstAttemptPath,
        { timeout: 30_000 },
      );
      await expect(
        studentPage.getByRole("heading", { name: "错题重练", exact: true }),
      ).toBeVisible();
      await expect(
        studentPage.getByText("错题重练 · 第 1 次"),
      ).toBeVisible();
      await expect(
        studentPage.locator('article[aria-label="第 1 题"]'),
      ).toBeVisible();
      await expect(
        studentPage.locator('article[aria-label="第 2 题"]'),
      ).toHaveCount(0);

      // —— 重练卷答对并交卷 ——
      await studentPage
        .locator('article[aria-label="第 1 题"]')
        .getByRole("radio", { name: "对", exact: true })
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

      // —— 错题本：该题轮次史多一轮（第 2 轮 ✓ · 错题重练 · 第 1 次），
      //    且每轮一行可点 → 回看该轮作答结果 ——
      await studentPage.goto("/s/wrong");
      await studentPage.getByRole("button", { name: /1 是正数/ }).click();
      const q1Card = studentPage.locator("article", {
        hasText: "有理数的概念",
      });
      const rounds = q1Card.getByLabel("轮次史");
      await expect(rounds).toBeVisible({ timeout: 30_000 });
      await expect(
        rounds.getByText("已做错 1 次 · 做对 1 次"),
      ).toBeVisible();
      const round2Link = rounds.getByRole("link", {
        name: "查看第 2 轮作答：错题重练 · 第 1 次",
      });
      await expect(round2Link).toBeVisible();
      await round2Link.click();
      await studentPage.waitForURL("**/s/attempts/**");
      // 落在重练卷的结果视图（rounds 只含已判定轮，必为已交卷）
      await expect(studentPage.getByText("批改结果")).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        studentPage.getByText("错题重练 · 第 1 次"),
      ).toBeVisible();

      // —— 负例：全对卷（再做一次第 2 次全对）结果页无「练习本卷错题」按钮 ——
      await studentPage.goto(unitPath);
      await studentPage.getByRole("button", { name: "再做一次" }).click();
      await studentPage
        .getByRole("button", { name: "开始新一次" })
        .click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(
        studentPage.getByText(`课程：${courseName} · 第 2 次`),
      ).toBeVisible();
      for (const q of [1, 2]) {
        await studentPage
          .locator(`article[aria-label="第 ${q} 题"]`)
          .getByRole("radio", { name: "对", exact: true })
          .locator("xpath=ancestor::label[1]")
          .click();
      }
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
      await expect(
        studentPage.getByRole("button", { name: /练习本卷错题/ }),
      ).toHaveCount(0);

      // 泄露检查：全程 /api/student/* 响应无禁用键、无未解锁提示/详解原文
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
