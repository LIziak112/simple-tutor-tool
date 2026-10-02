import { devices, expect, test } from "@playwright/test";
import {
  attachLeakMonitor,
  createStudentViaApi,
  getStudentViaApi,
  isolateRegisterRateLimit,
  registerTeacherViaUi,
  teacherApiLogin,
  teacherLoginViaApi,
  uniqueSuffix,
} from "./helpers";

/**
 * T2B.8 全链路用例（Phase 2B 多教师改造的最终串联验收）：
 * 乙自助注册（UI）→ 甲导入单元并发布到共享 → 乙共享页导入 → 乙建课加成员
 * （乙自己的学生）→ 乙按课程经三步向导布置作业 → 乙的学生作答交卷 →
 * 切回甲：乙的课程/学生/作业按 id 访问一律 404（网络层断言），三张列表亦互不可见。
 *
 * 会话切换口径：page 注册后即乙会话（乙的全部 UI 操作）；request 上下文在
 * 甲（teacherApiLogin）与乙（teacherLoginViaApi）之间切换做 API 造数与断言。
 * 限流：注册走 UI 且注入本文件专属 IP 段 10.239.3.x（teacher-register-admin
 * 用 10.239.1.x，互不占额）；开关竞态由 helper 内「等开放 + 重试」吸收。
 * 单元/课程/作业/学生名全部带唯一后缀：两个浏览器项目并行跑同一数据目录互不干扰。
 */
test.describe("T2B.8 多教师全链路：乙注册 → 甲发布 → 乙导入建课布置 → 学生作答 → 甲不可见", () => {
  test("完整链路各环节串联，甲对乙的资源按 id 404 且列表互不可见", async ({
    page,
    request,
    browser,
    browserName,
  }) => {
    // 链条含注册 + 共享导入 + 三步向导 + 学生作答四段 UI：与 full-chain 同量级
    test.setTimeout(150_000);

    const suffix = `${browserName}-${uniqueSuffix()}`;
    const yiLoginName = `e2e乙全-${suffix}`;
    const yiPassword = "e2e-yi-chain-8";
    const unitName = `共享全链单元${suffix}`;
    const courseName = `乙全链课程${suffix}`;
    const assignmentTitle = `乙全链作业${suffix}`;
    const studentName = `乙学生${suffix}`;
    const studentLoginName = `e2e-yi-stu-${suffix}`;

    // —— 1. 保证甲（teacher，管理员）存在：无教师行时注册接口 409 ——
    await teacherApiLogin(request);

    // —— 2. 乙自助注册（UI 表单 → 自动登录；page 会话从此是乙）——
    await isolateRegisterRateLimit(
      page,
      `10.239.3.${browserName === "chromium" ? 1 : 2}`,
    );
    await registerTeacherViaUi(page, request, yiLoginName, yiPassword);

    // —— 3. 甲导入 2 题单元（判断 + 单选，均可自动判分——2026-10-02 fill 改
    //    全人工批改后，本用例「交卷即全对出分」意图改用仍自动判分的单选题承载，
    //    原第二题为填空题）并发布到共享目录 ——
    //    （request 会话仍为甲——注册走的是 page，未动 request）
    const markdown = [
      "---",
      "kind: practice",
      `unit: ${unitName}`,
      "topic: 共享全链",
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
    const commit = await request.post("/api/teacher/import/commit", {
      data: { markdown, filename: `${unitName}.md` },
    });
    expect(commit.ok(), "甲导入单元失败").toBeTruthy();
    const publish = await request.post(
      `/api/teacher/library/units/${encodeURIComponent(unitName)}/publish`,
    );
    expect(publish.ok(), "甲发布单元到共享失败").toBeTruthy();
    const publishedFilename = (
      (await publish.json()) as { data: { filename: string } }
    ).data.filename;

    // —— 4. 乙从共享导入（UI：共享页卡片 → 预览动作清单=新增 → 确认导入）——
    await page.goto("/t/shared");
    const card = page.locator("li", { hasText: unitName });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "导入到我的资源库" }).click();
    await expect(page.getByText(`新增单元「${unitName}」`)).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "确认导入" }).click();
    await expect(page.getByText(/导入完成/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "完成" }).click();

    // —— 5. 乙建课 + 建自己的学生 + 加目录条目与成员（API 造数；request 切到乙）——
    await teacherLoginViaApi(request, yiLoginName, yiPassword);
    const course = await request.post("/api/teacher/courses", {
      data: { title: courseName },
    });
    expect(course.ok(), "乙建课失败").toBeTruthy();
    const courseId = ((await course.json()) as { data: { id: string } }).data
      .id;

    await createStudentViaApi(request, studentName, studentLoginName);
    const student = await getStudentViaApi(request, studentLoginName);

    const addItem = await request.post(
      `/api/teacher/courses/${courseId}/items`,
      { data: { items: [{ kind: "unit", refId: unitName }], visible: true } },
    );
    expect(addItem.ok(), "乙把共享导入的单元加进课程失败").toBeTruthy();
    const addMember = await request.post(
      `/api/teacher/courses/${courseId}/members`,
      { data: { studentIds: [student.id] } },
    );
    expect(addMember.ok(), "乙加课程成员失败").toBeTruthy();

    // —— 6. 乙按课程布置作业（UI 三步向导：①对象 → ②内容 → ③确认）——
    await page.goto("/t/assignments");
    await page.getByRole("button", { name: "布置作业" }).first().click();

    // ① 对象：选乙的课程 → 名单自动带出乙的学生（默认全选，保持勾选）
    const courseOption = page.locator("#wizard-course option", {
      hasText: courseName,
    });
    await expect(courseOption).toHaveCount(1);
    const courseValue = await courseOption.getAttribute("value");
    if (courseValue === null) {
      throw new Error("乙的课程 option 缺少 value");
    }
    await page.selectOption("#wizard-course", courseValue);
    const studentCheck = page.getByRole("checkbox", { name: studentName });
    await expect(studentCheck).toBeVisible();
    await expect(studentCheck).toBeChecked();
    await expect(page.getByText("已选 1 人")).toBeVisible();
    await page.getByRole("button", { name: "下一步", exact: true }).click();

    // ② 内容：勾选共享导入的单元（乙域内的独立副本），共 2 题
    const courseUnitList = page.getByRole("list", {
      name: "本课程练习单元列表",
    });
    await expect(courseUnitList).toBeVisible();
    await courseUnitList
      .getByRole("checkbox", { name: new RegExp(unitName) })
      .check();
    await expect(page.getByText("已选 1 个单元 · 共 2 题")).toBeVisible();
    await page.getByRole("button", { name: "下一步", exact: true }).click();

    // ③ 确认：该学生没做过课程练习 → 无「已做过」提示；摘要分节后提交
    await expect(page.locator("#wizard-title")).toBeVisible();
    await expect(
      page.getByText("以下学生已在课程练习中做过所选单元"),
    ).not.toBeVisible();
    await expect(
      page.getByText("作业内容（按作答顺序，共 2 题）"),
    ).toBeVisible();
    await expect(page.getByText(`1. ${unitName}（2 题）`)).toBeVisible();
    await page.fill("#wizard-title", assignmentTitle);
    await page
      .getByRole("button", { name: "布置作业（1 个单元 · 2 题）" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const assignmentCard = page.locator("li", { hasText: assignmentTitle });
    await expect(assignmentCard).toHaveCount(1);
    await expect(assignmentCard.getByText("共 2 题")).toBeVisible();

    // 乙按标题取作业 id（甲断言 404 的探针要用）
    const assignList = await request.get("/api/teacher/assignments");
    expect(assignList.ok()).toBeTruthy();
    const assignmentId = (
      (await assignList.json()) as {
        data: { assignments: { id: string; title: string }[] };
      }
    ).data.assignments.find((item) => item.title === assignmentTitle)?.id;
    if (assignmentId === undefined) {
      throw new Error(`乙的作业列表中未找到「${assignmentTitle}」`);
    }

    // —— 7. 乙的学生作答交卷（专属链接登录；学生端接口零变化——T2B.5 红线）——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    try {
      const studentPage = await studentContext.newPage();
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      await expect(studentPage.getByText(studentName).first()).toBeVisible();

      // 作业卡（单单元口径：「单元：标题」）→ 开始练习
      const studentCard = studentPage.locator("li", {
        hasText: assignmentTitle,
      });
      await expect(studentCard).toHaveCount(1);
      await expect(studentCard.getByText(`单元：${unitName}`)).toBeVisible();
      await expect(studentCard.getByText("共 2 题")).toBeVisible();
      await studentCard.getByRole("link", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/assignments/**");
      await expect(
        studentPage.locator('article[aria-label="第 2 题"]'),
      ).toBeVisible();
      // 单单元作业不渲染单元节标题（T2A.7：节头仅多单元分节时显示）——
      // 断言全卷题目数即可（h2 计数为 0 顺带固化该口径）
      await expect(studentPage.locator("h2")).toHaveCount(0);
      await expect(studentPage.locator("article[aria-label]")).toHaveCount(2);

      // 第 1 题判断答「对」；第 2 题单选选 B（选择控件点可见 label，与主流程一致）
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
      await expect
        .poll(async () => studentPage.getByTestId("draft-status").textContent())
        .not.toContain("保存中");

      await expect(studentPage.getByText("已答 2 / 2 题")).toBeVisible();
      await studentPage
        .getByRole("button", { name: "交卷", exact: true })
        .click();
      await studentPage
        .getByRole("button", { name: "确认交卷" })
        .first()
        .click();

      // 结果：2 题全部自动判分且全对
      await expect(studentPage.getByText("批改结果")).toBeVisible({
        timeout: 30_000,
      });
      await expect(studentPage.getByText("100", { exact: true })).toBeVisible();
      await expect(studentPage.getByText("共 2 题")).toBeVisible();
      await expect(studentPage.getByText("答对 2 题")).toBeVisible();
      await expect(studentPage.getByText("待批 0 题")).toBeVisible();

      // 泄露检查：交卷前所有 /api/student/* 响应无禁用键、无提示/详解原文
      await studentPage.waitForTimeout(800); // 等最后一批响应体读完
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }

    // —— 8. 甲访问乙的课程/学生/作业 → 404（网络层断言，D12 不暴露存在性）——
    await teacherApiLogin(request); // request 切回甲

    const courseDenied = await request.get(`/api/teacher/courses/${courseId}`);
    expect(courseDenied.status(), "甲访问乙的课程应 404").toBe(404);
    expect(((await courseDenied.json()) as { error: string }).error).toBe(
      "COURSE_NOT_FOUND",
    );

    const assignmentDenied = await request.get(
      `/api/teacher/assignments/${assignmentId}`,
    );
    expect(assignmentDenied.status(), "甲访问乙的作业应 404").toBe(404);
    expect(((await assignmentDenied.json()) as { error: string }).error).toBe(
      "ASSIGNMENT_NOT_FOUND",
    );

    // 学生无独立详情接口：用按 id 的重置链接探针（404 时无任何副作用）
    const studentDenied = await request.post(
      `/api/teacher/students/${student.id}/reset-link`,
    );
    expect(studentDenied.status(), "甲访问乙的学生应 404").toBe(404);
    expect(((await studentDenied.json()) as { error: string }).error).toBe(
      "STUDENT_NOT_FOUND",
    );

    // 列表级互不可见：甲的三张列表均不含乙的任何资源
    const courseListBody = (await (
      await request.get("/api/teacher/courses")
    ).json()) as { data: { courses: { title: string }[] } };
    expect(
      courseListBody.data.courses.some((item) => item.title === courseName),
      "甲的课程列表不应出现乙的课程",
    ).toBe(false);

    const studentListBody = (await (
      await request.get("/api/teacher/students")
    ).json()) as {
      data: { students: { displayName: string; loginName: string }[] };
    };
    expect(
      studentListBody.data.students.some(
        (item) =>
          item.loginName === studentLoginName ||
          item.displayName === studentName,
      ),
      "甲的学生列表不应出现乙的学生",
    ).toBe(false);

    const assignmentListBody = (await (
      await request.get("/api/teacher/assignments")
    ).json()) as { data: { assignments: { title: string }[] } };
    expect(
      assignmentListBody.data.assignments.some(
        (item) => item.title === assignmentTitle,
      ),
      "甲的作业列表不应出现乙的作业",
    ).toBe(false);

    // —— 清理：甲删掉本用例发布的共享文件，避免共享页卡片越积越多 ——
    const cleanup = await request.delete(
      `/api/teacher/shared/${encodeURIComponent(publishedFilename)}`,
    );
    expect(cleanup.ok(), "甲清理共享文件失败").toBeTruthy();
  });
});
