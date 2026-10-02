import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  getStudentViaApi,
  setCourseItemVisible,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T2A.9 全链路用例：串起 Phase 2A 主链路（资源库 → 课程 → 成员 → 可见性 →
 * 课程练习可重做 → 按课程布置多单元作业 → 作答交卷），全程对学生端响应做
 * 网络层泄露拦截（attachLeakMonitor；课程练习与作业各用一个全新监控页面）。
 * 步骤：
 * 1. 教师 API 批量导入 3 个 .md（2 个合法单元 + 1 个故意 error 的文件——
 *    预览标红 hasError、逐文件 commit 422 被拒，验证「有 error 自动跳过」口径）；
 * 2. 教师 UI 建课程，从资源库（API 添加目录条目，引用而非复制）加 2 个单元
 *    （其一后用）、加成员 2 名（其一后用）+ 非成员学生 B（403 断言用）；
 * 3. 隐藏第二个单元条目 → 学生 A 课程目录看不到隐藏单元；非成员 B 访问课程
 *    接口 403 COURSE_ACCESS_DENIED（API 级断言）；
 * 4. 学生 A 完成课程练习两次（历次记录 2 次，首次 100 / 最近 0 / 最高 100）；
 * 5. 教师三步向导按课程布置两单元作业（名单带出成员；隐藏单元可选并标注状态；
 *    D15「已做过」提示出现）；学生 A 作答交卷，结果视图按单元分节完整。
 */

/**
 * 主单元：2 题（判断 + 单选，均可自动判分；两次作答制造 100 → 0 的分差）。
 * 2026-10-02 fill 改全人工批改（gradeFill 恒 null）后，「交卷即出分 / 历次得分」
 * 的用例意图改由仍自动判分的单选题承载（原第二题为填空题）。
 */
function courseUnitMarkdown(unitName: string): string {
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
    '::::question{type=choice difficulty=1 knowledge="有理数加法"}',
    "$(-3)+7=$ 的计算结果是（　）",
    "",
    "- [ ] $-10$",
    "- [x] $4$",
    "- [ ] $-4$",
    "- [ ] $10$",
    "",
    ":::solution",
    "$(-3)+7=4$，故选 B。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

/** 作业第二单元：1 道判断题（课程目录中隐藏；作业通道与课程可见性无关） */
function judgeUnitMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 正数与负数",
    "---",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
    "$0$ 是负数。[[错误]]",
    "",
    ":::solution",
    "$0$ 既不是正数也不是负数。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

/** 故意写错的文件：题型不在七种之内（UNKNOWN_QUESTION_TYPE，error 级） */
function brokenMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "---",
    "",
    "::::question{type=quiz difficulty=1}",
    "这题的题型写错了。[[正确]]",
    "::::",
    "",
  ].join("\n");
}

test.describe("全链路：批量导入 → 建课程 → 可见性 → 课程练习两次 → 两单元作业（T2A.9）", () => {
  test("教师批量导入与建课，学生完成课程练习两次后作答两单元作业", async ({
    page,
    request,
    browser,
  }) => {
    // 链条长于主流程（多一轮课程练习与一个非成员 context）：本机 ~30s，
    // CI 2 核 runner 冷编译 60-90s，150s 留余量（卡死快速失败，重试由 CI 吸收）
    test.setTimeout(150_000);

    // —— 1. 教师 API 会话 + 批量导入（2 合法 + 1 故意 error，D20）——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseUnitName = `e2e全链课程练${suffix}`;
    const assignUnitName = `e2e全链作业练${suffix}`;
    const brokenUnitName = `e2e全链坏文件${suffix}`;
    const courseName = `e2e全链课程${suffix}`;
    const assignmentTitle = `e2e全链作业卷${suffix}`;

    const files = [
      {
        path: `e2e/${courseUnitName}.md`,
        markdown: courseUnitMarkdown(courseUnitName),
      },
      {
        path: `e2e/${assignUnitName}.md`,
        markdown: judgeUnitMarkdown(assignUnitName),
      },
      {
        path: `e2e/${brokenUnitName}.md`,
        markdown: brokenMarkdown(brokenUnitName),
      },
    ];
    const preview = await request.post("/api/teacher/import/preview-batch", {
      data: { autoFolderBySubdir: false, files },
    });
    if (!preview.ok()) {
      throw new Error(
        `批量预览失败：HTTP ${preview.status()} ${await preview.text()}`,
      );
    }
    const previewBody = (await preview.json()) as {
      data: { files: Array<{ path: string; hasError: boolean }> };
    };
    const byPath = new Map(
      previewBody.data.files.map((file) => [file.path, file.hasError]),
    );
    // 预览口径：两个合法文件可提交，error 文件标红（提交时自动跳过）
    expect(byPath.get(files[0]?.path as string)).toBe(false);
    expect(byPath.get(files[1]?.path as string)).toBe(false);
    expect(byPath.get(files[2]?.path as string)).toBe(true);

    // 逐文件 commit（batchId 关联批次；error 文件 422 LINT_ERROR，其余照常成功）
    const batchId = crypto.randomUUID();
    for (const [index, file] of files.entries()) {
      const commit = await request.post("/api/teacher/import/commit", {
        data: {
          markdown: file.markdown,
          filename: file.path.split("/").pop() as string,
          sourcePath: file.path,
          batchId,
        },
      });
      if (index < 2) {
        expect(commit.ok()).toBeTruthy();
      } else {
        expect(commit.status()).toBe(422); // 有 error 级 issue 整体拒绝
      }
    }
    // 批次回看：只有 2 个成功文件（error 文件未落库）
    const batch = await request.get(`/api/teacher/import/batches/${batchId}`);
    expect(batch.ok()).toBeTruthy();
    const batchBody = (await batch.json()) as { data: { files: unknown[] } };
    expect(batchBody.data.files).toHaveLength(2);

    // —— 2. 教师 UI：登录 → 建课程（创建后直达课程编辑页，取 URL 中的 courseId）——
    await page.goto("/t/login");
    await page.fill("#login-name", TEACHER_LOGIN_NAME);
    await page.fill("#login-password", TEACHER_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/t/library");

    await page.goto("/t/courses");
    await page.getByRole("button", { name: "新建课程" }).click();
    await page.fill("#course-name", courseName);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.waitForURL(/\/t\/courses\/[0-9a-f-]{36}$/);
    const courseId = (
      page.url().match(/\/t\/courses\/([0-9a-f-]{36})$/) as RegExpMatchArray
    )[1] as string;

    // —— 从资源库添加 2 个单元条目（引用而非复制；D6 默认可见）——
    const addItems = await request.post(
      `/api/teacher/courses/${courseId}/items`,
      {
        data: {
          items: [
            { kind: "unit", refId: courseUnitName },
            { kind: "unit", refId: assignUnitName },
          ],
          visible: true,
        },
      },
    );
    if (!addItems.ok()) {
      throw new Error(
        `添加课程条目失败：HTTP ${addItems.status()} ${await addItems.text()}`,
      );
    }
    const addedBody = (await addItems.json()) as { data: { added: unknown[] } };
    expect(addedBody.data.added).toHaveLength(2);

    // —— 加成员 2 名（其一后用）+ 非成员学生 B（403 断言用）——
    const studentAName = `e2e全链A${suffix}`;
    const studentA2Name = `e2e全链甲${suffix}`;
    const studentBName = `e2e全链B${suffix}`;
    const logins: Array<[string, string]> = [
      [studentAName, `e2e-chain-a-${suffix}`],
      [studentA2Name, `e2e-chain-a2-${suffix}`],
      [studentBName, `e2e-chain-b-${suffix}`],
    ];
    for (const [displayName, loginName] of logins) {
      const res = await request.post("/api/teacher/students", {
        data: { displayName, loginName },
      });
      if (!res.ok()) {
        throw new Error(
          `创建学生失败：HTTP ${res.status()} ${await res.text()}`,
        );
      }
    }
    const studentA = await getStudentViaApi(request, logins[0]?.[1] as string);
    const studentA2 = await getStudentViaApi(request, logins[1]?.[1] as string);
    const studentB = await getStudentViaApi(request, logins[2]?.[1] as string);
    await addCourseMemberViaApi(request, courseId, studentA.id);
    await addCourseMemberViaApi(request, courseId, studentA2.id);

    // —— 隐藏第二个单元条目（D5：学生目录中零信息）——
    await setCourseItemVisible(request, courseId, assignUnitName, false);

    // —— 3a + 4. 学生 A：目录看不到隐藏单元；完成课程练习两次（D10）——
    // 学生 context 覆盖课程练习与作业两段，结束统一关闭
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    try {
      const studentPage = await studentContext.newPage();
      const leakPractice = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${studentA.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      // 课程目录：可见单元在列；隐藏单元零信息（含数量）
      await studentPage
        .getByRole("link", { name: `打开课程 ${courseName}` })
        .click();
      await studentPage.waitForURL(`**/s/courses/${courseId}`);
      await expect(
        studentPage.getByRole("link", {
          name: `打开练习 ${courseUnitName}（2 题）`,
        }),
      ).toBeVisible();
      await expect(studentPage.getByText(assignUnitName)).not.toBeVisible();

      // 进入单元落地页 → 第一次：开始练习 → 全对 → 交卷
      await studentPage
        .getByRole("link", { name: `打开练习 ${courseUnitName}（2 题）` })
        .click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(courseUnitName)}`,
      );
      await expect(
        studentPage.getByRole("heading", { name: courseUnitName }),
      ).toBeVisible();
      await expect(studentPage.getByText("还没有做过")).toBeVisible();

      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(
        studentPage.getByText(`课程：${courseName} · 第 1 次`),
      ).toBeVisible();
      const firstQ1 = studentPage.locator('article[aria-label="第 1 题"]');
      await firstQ1
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      const firstQ2 = studentPage.locator('article[aria-label="第 2 题"]');
      await firstQ2
        .getByRole("radio", { name: "选项 B" })
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
      await expect(studentPage.getByText("答对 2 题")).toBeVisible();

      // 再做一次（确认弹层「从空白开始」）→ 全错 → 历次记录 2 次
      await studentPage.getByRole("link", { name: "返回单元练习" }).click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(courseUnitName)}`,
      );
      await expect(studentPage.getByText(/历次记录（1）/)).toBeVisible();
      await studentPage.getByRole("button", { name: "再做一次" }).click();
      await expect(
        studentPage.getByRole("dialog", { name: "再做一次确认" }),
      ).toBeVisible();
      await expect(
        studentPage.getByText(/将开始第 2 次，从空白开始/),
      ).toBeVisible();
      await studentPage.getByRole("button", { name: "开始新一次" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(
        studentPage.getByText(`课程：${courseName} · 第 2 次`),
      ).toBeVisible();
      const secondQ1 = studentPage.locator('article[aria-label="第 1 题"]');
      await secondQ1
        .getByRole("radio", { name: "错", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      const secondQ2 = studentPage.locator('article[aria-label="第 2 题"]');
      await secondQ2
        .getByRole("radio", { name: "选项 A" })
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
      await expect(studentPage.getByText("答错 2 题")).toBeVisible();
      await studentPage.getByRole("link", { name: "返回单元练习" }).click();
      await studentPage.waitForURL(
        `**/s/courses/${courseId}/units/${encodeURIComponent(courseUnitName)}`,
      );
      await expect(studentPage.getByText(/历次记录（2）/)).toBeVisible();
      await expect(
        studentPage.getByText(/首次 100 分 · 最近 0 分 · 最高 100 分/),
      ).toBeVisible();

      // —— 泄露检查（课程练习段）：全程无禁用键、无提示/详解原文 ——
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leakPractice.violations().join("\n")).toBe("");

      // —— 5a. 教师 UI：三步向导按课程布置两单元作业（T2A.7）——
      await page.goto("/t/assignments");
      await page.getByRole("button", { name: "布置作业" }).first().click();

      // ① 对象：选本 run 的课程 → 名单默认带出 2 名成员（保持全选）
      const courseOption = page.locator("#wizard-course option", {
        hasText: courseName,
      });
      await expect(courseOption).toHaveCount(1);
      const courseValue = await courseOption.getAttribute("value");
      if (courseValue === null) {
        throw new Error("课程 option 缺少 value");
      }
      await page.selectOption("#wizard-course", courseValue);
      const checkA = page.getByRole("checkbox", { name: studentAName });
      await expect(checkA).toBeVisible();
      await expect(checkA).toBeChecked();
      await expect(
        page.getByRole("checkbox", { name: studentA2Name }),
      ).toBeChecked();
      await expect(page.getByText("已选 2 人")).toBeVisible();
      await page.getByRole("button", { name: "下一步", exact: true }).click();

      // ② 内容：勾选主单元 + 隐藏单元（含隐藏条目并标注状态，D12）；
      //    勾选顺序 = 作答顺序（主单元在前），共 3 题
      const courseUnitList = page.getByRole("list", {
        name: "本课程练习单元列表",
      });
      await expect(courseUnitList).toBeVisible();
      await courseUnitList
        .getByRole("checkbox", { name: new RegExp(courseUnitName) })
        .check();
      const hiddenRow = courseUnitList.locator("li", {
        hasText: assignUnitName,
      });
      await expect(hiddenRow).toHaveCount(1);
      await expect(hiddenRow.getByText("隐藏", { exact: true })).toBeVisible();
      await hiddenRow.getByRole("checkbox").check();
      await expect(page.getByText("已选 2 个单元 · 共 3 题")).toBeVisible();
      await page.getByRole("button", { name: "下一步", exact: true }).click();

      // ③ 确认：D15「已做过」提示（学生 A 已在课程练习中做过主单元 2 次）；
      //    内容摘要分节；填唯一化标题后提交
      await expect(
        page.getByText(/以下学生已在课程练习中做过所选单元/),
      ).toBeVisible();
      await expect(
        page.getByText(
          `${studentAName}：已在〈${courseName}〉中做过〈${courseUnitName}〉2 次`,
        ),
      ).toBeVisible();
      await expect(
        page.getByText("作业内容（按作答顺序，共 3 题）"),
      ).toBeVisible();
      await page.fill("#wizard-title", assignmentTitle);
      await page
        .getByRole("button", { name: "布置作业（2 个单元 · 3 题）" })
        .click();

      // 弹层关闭 + 列表出现本 run 的作业卡片（两单元清单与合计 3 题）
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const assignmentCard = page.locator("li", { hasText: assignmentTitle });
      await expect(assignmentCard).toHaveCount(1);
      await expect(assignmentCard.getByText("共 3 题")).toBeVisible();
      await expect(
        assignmentCard.getByText(`${courseUnitName}（2 题）`),
      ).toBeVisible();
      await expect(
        assignmentCard.getByText(`${assignUnitName}（1 题）`),
      ).toBeVisible();

      // —— 5b. 学生 A：作业卡片（两单元分节口径）→ 作答 3 题全对 → 交卷 ——
      // 同一学生 context 开新页面：泄露监控从作业待办状态重新起算（交卷前严格）
      const assignPage = await studentContext.newPage();
      const leakAssignment = attachLeakMonitor(assignPage);
      await assignPage.goto("/s/home");
      const studentCard = assignPage.locator("li", {
        hasText: assignmentTitle,
      });
      await expect(studentCard).toHaveCount(1);
      await expect(
        studentCard.getByText(
          `2 个单元（${courseUnitName}、${assignUnitName}）`,
        ),
      ).toBeVisible();
      await expect(studentCard.getByText("共 3 题")).toBeVisible();
      await studentCard.getByRole("link", { name: "开始练习" }).click();
      await assignPage.waitForURL("**/s/assignments/**");
      await expect(
        assignPage.locator('article[aria-label="第 3 题"]'),
      ).toBeVisible();
      // 按布置顺序分节（答题页 h2 = 单元标题）
      const unitHeaders = assignPage.locator("h2");
      await expect(unitHeaders).toHaveCount(2);
      await expect(unitHeaders.nth(0)).toHaveText(courseUnitName);
      await expect(unitHeaders.nth(1)).toHaveText(assignUnitName);

      const aq1 = assignPage.locator('article[aria-label="第 1 题"]');
      await aq1
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      const aq2 = assignPage.locator('article[aria-label="第 2 题"]');
      await aq2
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      const aq3 = assignPage.locator('article[aria-label="第 3 题"]');
      await aq3
        .getByRole("radio", { name: "错", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect
        .poll(async () => assignPage.getByTestId("draft-status").textContent())
        .not.toContain("保存中");
      await assignPage
        .getByRole("button", { name: "交卷", exact: true })
        .click();
      await assignPage
        .getByRole("button", { name: "确认交卷" })
        .first()
        .click();

      // —— 结果视图：得分汇总 + 按单元分节（h3）+ 题号连续 1–3 ——
      await expect(assignPage.getByText("批改结果")).toBeVisible({
        timeout: 30_000,
      });
      await expect(assignPage.getByText("100", { exact: true })).toBeVisible();
      await expect(assignPage.getByText("共 3 题")).toBeVisible();
      await expect(assignPage.getByText("答对 3 题")).toBeVisible();
      await expect(assignPage.getByText("答错 0 题")).toBeVisible();
      await expect(assignPage.getByText("待批 0 题")).toBeVisible();
      const resultUnitHeaders = assignPage.locator("h3");
      await expect(resultUnitHeaders).toHaveCount(2);
      await expect(resultUnitHeaders.nth(0)).toHaveText(courseUnitName);
      await expect(resultUnitHeaders.nth(1)).toHaveText(assignUnitName);
      await expect(assignPage.locator("article[aria-label]")).toHaveCount(3);
      await expect(
        assignPage
          .locator('article[aria-label="第 3 题"]')
          .getByText("答对", { exact: true }),
      ).toBeVisible();

      // —— 泄露检查（作业段）：交卷前所有 /api/student/* 响应无禁用键/原文 ——
      await assignPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leakAssignment.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }

    // —— 3b. 非成员学生 B：访问课程接口 403（API 级断言，D22）——
    const outsiderContext = await browser.newContext(devices["iPad (gen 7)"]);
    const outsiderPage = await outsiderContext.newPage();
    try {
      const leakOutsider = attachLeakMonitor(outsiderPage);
      await outsiderPage.goto(`/s/${studentB.linkToken}`);
      await outsiderPage.waitForURL("**/s/home");
      // page.request 复用浏览器 context 的会话 Cookie（B 的学生会话）
      const denied = await outsiderPage.request.get(
        `/api/student/courses/${courseId}`,
      );
      expect(denied.status()).toBe(403);
      const deniedBody = (await denied.json()) as { error: string };
      expect(deniedBody.error).toBe("COURSE_ACCESS_DENIED");

      await outsiderPage.waitForTimeout(500);
      expect(leakOutsider.violations().join("\n")).toBe("");
    } finally {
      await outsiderContext.close();
    }
  });
});
