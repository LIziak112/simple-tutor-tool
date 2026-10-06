import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  setCourseItemVisible,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T6R.11 双角色原稿查看 E2E（真实 Chromium + 真实服务端）：
 * 学生写草稿交卷 → 结果页只读**本次**原稿（证据行定位）→ 教师详情页同视角
 * 查看 → 同题错题重练（新卷新空白草稿）→ 旧 attempt 原稿仍在（证据引用不变、
 * 页面仍可查看）→ 教师连续查看 5 题无多画布堆积（离屏渲染画布即用即弃）。
 * 服务端冻结事实的矩阵断言不在此重复（见 routes/attempt-submit-evidence.test
 * 与 e2e/note-submit-evidence.spec）。
 */

/** 六题全客观小练（3 判断 + 3 单选；判断第 1 题供答错进错题本，其余可判对） */
function sixObjectiveQuestionsMarkdown(unitName: string): string {
  const lines: string[] = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 有理数",
    "---",
    "",
  ];
  for (let i = 1; i <= 3; i += 1) {
    lines.push(
      `::::question{type=judge difficulty=1 knowledge="有理数的概念"}`,
      `$${i}$ ${i === 1 ? "" : "不"}是正数。[[${i === 1 ? "正确" : "错误"}]]`,
      "",
      ":::solution",
      "按正负定义判断。",
      ":::",
      "::::",
      "",
    );
  }
  for (let i = 1; i <= 3; i += 1) {
    lines.push(
      `::::question{type=choice difficulty=1 knowledge="有理数加法"}`,
      `$(-${i})+${i + 4}=$ 的计算结果是（　）`,
      "",
      "- [ ] $-4$",
      `- [x] $${4}$`,
      "- [ ] $0$",
      "",
      ":::solution",
      "按加法法则计算，故选 B。",
      ":::",
      "::::",
      "",
    );
  }
  return lines.join("\n");
}

/** 教师端读某 attempt 某题的证据行（重练前后对照原稿引用不变） */
async function teacherEvidenceOf(
  request: import("@playwright/test").APIRequestContext,
  attemptId: string,
  questionId: string,
): Promise<{ state: string; versionId: string | null }> {
  const res = await request.get(
    `/api/teacher/attempts/${attemptId}/evidence/${encodeURIComponent(questionId)}`,
  );
  if (!res.ok()) {
    throw new Error(`教师证据读取失败：HTTP ${res.status()}`);
  }
  const body = (await res.json()) as {
    data: { evidence: { state: string; versionId: string | null } | null };
  };
  if (body.data.evidence === null) {
    throw new Error("证据行为空（交卷事务未固定原稿）");
  }
  return body.data.evidence;
}

test.describe("双角色原稿查看与重练（T6R.11）", () => {
  test("学生交卷→结果页看原稿→教师查看→同题重练→旧原稿仍在→教师连看 5 题无画布堆积", async ({
    request,
    browser,
    page,
  }) => {
    test.setTimeout(300_000);

    // —— 造数（教师 API）：专属课程 + 六题客观练习 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e原稿双角色${suffix}`;
    const unitName = `双角色小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: sixObjectiveQuestionsMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入课程练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-orig2-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e双角色生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    let attempt1 = "";
    let attempt2 = "";
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      // —— 第一轮：课程练习（第 1 次）——
      await studentPage
        .getByRole("link", { name: `打开课程 ${courseName}` })
        .click();
      await studentPage.waitForURL(`**/s/courses/${courseId}`);
      await studentPage
        .getByRole("link", { name: `打开练习 ${unitName}（6 题）` })
        .click();
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      attempt1 = studentPage.url().split("/").pop() ?? "";
      expect(attempt1).not.toBe("");

      // 每题：开草稿纸写一笔 + 作答（判断三题全答「错」——第 1 题正解为对
      // 即判错进错题本，第 2/3 题正解为错即答对；单选三题均选 B 答对）
      for (let no = 1; no <= 6; no += 1) {
        const card = studentPage.locator(`article[aria-label="第 ${no} 题"]`);
        await card.getByRole("button", { name: /草稿纸/ }).first().click();
        const canvas = card.locator('[data-slot="note-paper"] canvas');
        await expect(canvas).toBeVisible();
        await drawStrokeWithPointerEvents(canvas);
        const answerLabel = no <= 3 ? "错" : null;
        if (answerLabel !== null) {
          await card
            .getByRole("radio", { name: answerLabel, exact: true })
            .locator("xpath=ancestor::label[1]")
            .click();
          await expect(
            card.getByRole("radio", { name: answerLabel, exact: true }),
          ).toBeChecked();
        } else {
          await card
            .getByRole("radio", { name: "选项 B" })
            .locator("xpath=ancestor::label[1]")
            .click();
          await expect(
            card.getByRole("radio", { name: "选项 B" }),
          ).toBeChecked();
        }
      }

      // 交卷（证据声明随请求上行，服务端事务固定原稿）
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 60_000,
      });

      // —— 结果页只读本次原稿：第 1 题面板（轮次标注 + 渲染页图）——
      const q1Card = studentPage.locator('article[aria-label="第 1 题"]');
      await q1Card
        .getByRole("button", { name: "第 1 题查看草稿原稿" })
        .click();
      const q1Panel = q1Card.locator('[data-slot="note-original-view"]');
      await expect(q1Panel.getByText("第 1 次课程练习")).toBeVisible();
      await expect(q1Panel.getByText(/交卷时固定于/)).toBeVisible();
      await expect(q1Panel.getByRole("img")).toBeVisible({
        timeout: 15_000,
      });
      // 结果页无驻留 canvas（离屏渲染画布即用即弃；后台补图队列的画布同为
      // 瞬态，断言自动重试至清零）
      await expect(studentPage.locator("canvas")).toHaveCount(0, {
        timeout: 20_000,
      });

      // —— 同题重练：练习本卷错题（第 1 题判错 → 1 题）→ 新卷新空白草稿 ——
      await studentPage
        .getByRole("button", { name: "练习本卷错题（1 题）" })
        .click();
      // 当前 URL 已在 /s/attempts/**——等待它**换卷**（尾段不再是 attempt1）
      await studentPage.waitForURL(
        (url) =>
          url.pathname.includes("/s/attempts/") &&
          (url.pathname.split("/").pop() ?? "") !== attempt1,
        { timeout: 30_000 },
      );
      attempt2 = studentPage.url().split("/").pop() ?? "";
      expect(attempt2).not.toBe("");
      expect(attempt2).not.toBe(attempt1);

      const reCard = studentPage.locator('article[aria-label="第 1 题"]');
      await reCard.getByRole("button", { name: /草稿纸/ }).first().click();
      const reCanvas = reCard.locator('[data-slot="note-paper"] canvas');
      await expect(reCanvas).toBeVisible();
      await drawStrokeWithPointerEvents(reCanvas);
      await reCard
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 60_000,
      });

      // 重练卷面板轮次标注 = 第 1 次错题重练
      const reResultCard = studentPage.locator('article[aria-label="第 1 题"]');
      await reResultCard
        .getByRole("button", { name: "第 1 题查看草稿原稿" })
        .click();
      await expect(
        reResultCard
          .locator('[data-slot="note-original-view"]')
          .getByText("第 1 次错题重练"),
      ).toBeVisible();
      await expect(
        reResultCard.locator('[data-slot="note-original-view"] img'),
      ).toBeVisible({ timeout: 15_000 });

      // —— 旧原稿仍在：回到第一轮结果页（历史显式查看），面板照常渲染 ——
      await studentPage.goto(`/s/attempts/${attempt1}`);
      await expect(studentPage.getByText(/批改结果/)).toBeVisible({
        timeout: 30_000,
      });
      const oldCard = studentPage.locator('article[aria-label="第 1 题"]');
      await oldCard
        .getByRole("button", { name: "第 1 题查看草稿原稿" })
        .click();
      await expect(
        oldCard.locator('[data-slot="note-original-view"] img'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        oldCard
          .locator('[data-slot="note-original-view"]')
          .getByText("第 1 次课程练习"),
      ).toBeVisible();

      // 学生端响应无泄露
      expect(leak.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }

    // —— 服务端事实：重练后旧 attempt 证据引用不变（frozen 同版本）——
    const q1Id = `${unitName}-1`;
    const oldEvidence = await teacherEvidenceOf(request, attempt1, q1Id);
    expect(oldEvidence.state).toBe("frozen");
    expect(oldEvidence.versionId).not.toBeNull();

    // —— 教师端 UI：登录 → 详情页连续查看 5 题，无多画布堆积 ——
    await page.goto("/t/login");
    await page.fill("#login-name", TEACHER_LOGIN_NAME);
    await page.fill("#login-password", TEACHER_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");

    await page.goto(`/t/data/attempts/${attempt1}`);
    await expect(
      page.getByRole("heading", { name: `e2e双角色生${suffix}` }),
    ).toBeVisible();

    // 连续打开第 1–5 题原稿面板：每次渲染页图可见；画布不随查看次数堆积
    for (let no = 1; no <= 5; no += 1) {
      const card = page.locator(`article[aria-label="第 ${no} 题"]`);
      await card
        .getByRole("button", { name: `第 ${no} 题查看草稿原稿` })
        .click();
      await expect(
        card.locator('[data-slot="note-original-view"] img'),
      ).toBeVisible({ timeout: 15_000 });
      // 渲染完成即回收离屏画布——页面驻留 canvas 恒 0（教师详情页无其它画布）
      await expect(page.locator("canvas")).toHaveCount(0);
    }

    // 重练后旧证据引用仍是原版本（双保险：UI 可看 + 服务端不换原稿）
    const oldEvidenceAfter = await teacherEvidenceOf(request, attempt1, q1Id);
    expect(oldEvidenceAfter.versionId).toBe(oldEvidence.versionId);
  });
});
