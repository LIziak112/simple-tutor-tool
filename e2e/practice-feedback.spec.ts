import {
  type APIRequestContext,
  devices,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  attachLeakMonitor,
  chooseAnswer,
  createCourseViaApi,
  createStudentViaApi,
  expectResultCount,
  FORBIDDEN_EXACT_KEYS,
  FORBIDDEN_KEY_PREFIXES,
  getStudentViaApi,
  importUnitToCourse,
  openUnitLanding,
  prepareCourseStudent,
  teacherApiLogin,
  uniqueSuffix,
  waitForDraftSaved,
} from "./helpers";

/**
 * 练习反馈升级 M1–M5 逐题反馈全链 E2E（2026-10-22 计划 §5/§6/§10）：
 * 1. 课程自由练习默认逐题（新协议）：摘要行 → 提交本题 → 原位反馈（结论 +
 *    参考答案 + 解析）→ 已提交行锁定 → 草稿取卷不含未交题答案（键级断言）→
 *    最后一题自动收尾 → 查看本次结果；
 * 2. 作业粒度授权（allowPerQuestionFeedback=true）：/s/assignments/:id 进入，
 *    与 1 同款逐题流；
 * 3. 教师未授权作业（收紧）：整卷节奏 + 节奏组禁用 + 隐藏逐题提交入口
 *    （服务端拒绝由路由测试覆盖）→ 整卷交卷出结果；
 * 4. 作答中节奏切换（M5-D3 PATCH CAS）：切「交卷后查看」后摘要更新、逐题
 *    提交不再即时反馈，整卷交卷收尾；
 * 5. 开始页推荐预选（M5）：frontmatter practice 推荐单题 + 交卷后查看 →
 *    落地页「本单元推荐」→ 建卷即交卷后节奏（单题布局）。
 * 全程挂 attachLeakMonitor（场景 6）：逐题提交后监控不停止，草稿取卷等后续
 * 响应仍受键名/内容级检查；逐题提交→反馈可见耗时以「测量记录非阈值」注解
 * 输出（场景 7，只记录不设阈值）。
 */

/** 判断 + 单选两题小练习（逐题反馈断言用：两题均可自动判分且都有解析） */
function perQuestionPracticeMarkdown(unitName: string): string {
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

/** 带做题方式推荐的练习（M5：frontmatter practice 推荐单题 + 交卷后查看） */
function recommendedPracticeMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 正数与负数",
    "practice:",
    "  layout: single",
    "  feedback: after_attempt",
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

/** 教师布置一份单单元作业（allowPerQuestionFeedback 控制逐题反馈授权） */
async function createAssignmentViaApi(
  request: APIRequestContext,
  input: {
    title: string;
    unitName: string;
    studentId: string;
    allowPerQuestionFeedback: boolean;
  },
): Promise<string> {
  const res = await request.post("/api/teacher/assignments", {
    data: {
      title: input.title,
      unitIds: [input.unitName],
      studentIds: [input.studentId],
      allowPerQuestionFeedback: input.allowPerQuestionFeedback,
    },
  });
  if (!res.ok()) {
    throw new Error(`布置作业失败：HTTP ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data: { assignments: Array<{ id: string }> };
  };
  const id = body.data.assignments[0]?.id;
  if (id === undefined) {
    throw new Error("布置作业响应缺少作业 id");
  }
  return id;
}

/** 递归收集禁键路径（草稿取卷防泄露的键级断言）：
 *  复用泄露监控导出的 FORBIDDEN_EXACT_KEYS/FORBIDDEN_KEY_PREFIXES，与服务端
 *  assert-no-leak 及监控同口径；answerRelease 是公布时机策略串，非答案） */
function collectSecretKeyPaths(node: unknown, path: string): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) =>
      collectSecretKeyPaths(item, `${path}[${index}]`),
    );
  }
  if (typeof node !== "object" || node === null) return [];
  const hits: string[] = [];
  for (const [key, child] of Object.entries(node)) {
    const keyPath = path === "" ? key : `${path}.${key}`;
    if (
      FORBIDDEN_EXACT_KEYS.has(key) ||
      FORBIDDEN_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      hits.push(keyPath);
    }
    hits.push(...collectSecretKeyPaths(child, keyPath));
  }
  return hits;
}

/**
 * 直接 GET /api/student/attempts/:id（学生上下文）断言草稿取卷响应：
 * 全卷任何题目（含未交的第 2 题）都不携带参考答案/详解禁键。
 */
async function expectDraftFetchClean(
  page: Page,
  attemptId: string,
): Promise<void> {
  const res = await page.request.get(`/api/student/attempts/${attemptId}`);
  expect(res.ok(), `草稿取卷应成功：HTTP ${res.status()}`).toBe(true);
  const body = (await res.json()) as { data?: unknown };
  const data = body.data;
  expect(data, "草稿取卷响应应携带 data").toBeDefined();
  const leaked = collectSecretKeyPaths(data, "");
  expect(leaked.join("、"), "草稿取卷不得携带任何题目的参考答案/详解键").toBe(
    "",
  );
  // 明确核对未交的第 2 题条目（题号顺序 = units 平铺顺序）
  const units = (data as { units?: Array<{ questions?: unknown[] }> }).units;
  const questions = units?.[0]?.questions ?? [];
  expect(questions.length, "草稿取卷应包含 2 道题").toBe(2);
  expect(
    collectSecretKeyPaths(questions[1], "").join("、"),
    "未交卷的第 2 题条目不得有参考答案/详解禁键",
  ).toBe("");
}

/** 记录「测量记录非阈值」注解（场景 7：只记录不设阈值；list 报告器不打印
 * 注解，同步 console.log 一份让数值进运行日志） */
function annotateLatency(label: string, elapsedMs: number): void {
  const description = `${label} ${elapsedMs}ms（${test.info().project.name}）`;
  test.info().annotations.push({
    type: "测量记录非阈值",
    description,
  });
  console.log(`[测量记录非阈值] ${description}`);
}

test.describe("练习反馈升级 M1–M5：逐题反馈全链", { tag: ["@student"] }, () => {
  for (const mode of ["列表逐题", "单题逐题", "统一交卷"] as const) {
    test(`整卷交卷回归：${mode}提交全部剩余题并结束整卷`, async ({
      request,
      browser,
    }) => {
      await teacherApiLogin(request);
      const suffix = uniqueSuffix();
      const courseName = `交卷回归课程${suffix}`;
      const unitName = `交卷回归小练${suffix}`;
      const courseId = await createCourseViaApi(request, courseName);
      await importUnitToCourse(
        request,
        courseId,
        unitName,
        perQuestionPracticeMarkdown(unitName),
      );
      const student = await prepareCourseStudent(
        request,
        courseId,
        `submit-${suffix}`,
        `交卷生${suffix}`,
      );
      const context = await browser.newContext(devices["iPad (gen 7)"]);
      const page = await context.newPage();
      try {
        const leak = attachLeakMonitor(page);
        await openUnitLanding(
          page,
          student.linkToken,
          courseId,
          courseName,
          unitName,
        );
        await page
          .getByRole("radio", {
            name: mode === "单题逐题" ? "单题专注" : "列表作答",
            exact: true,
          })
          .check();
        await page
          .getByRole("radio", {
            name: mode === "统一交卷" ? "交卷后查看" : "每题提交后查看",
            exact: true,
          })
          .check();
        await page.getByRole("button", { name: "开始练习" }).click();
        await page.waitForURL("**/s/attempts/**");
        const q1 = page.locator('article[aria-label="第 1 题"]');
        await chooseAnswer(page, 1, "对", true);
        await waitForDraftSaved(page);
        if (mode !== "统一交卷") {
          // 单题专注的提交入口在吸底栏，列表在题卡内。
          await page
            .getByRole("button", { name: "提交本题", exact: true })
            .first()
            .click();
          await expect(
            q1.getByRole("region", { name: "本题反馈" }),
          ).toBeVisible();
          await expect(
            q1.getByRole("radio", { name: "对", exact: true }),
          ).toBeDisabled();
        } else {
          await expect(
            page.getByRole("button", { name: "提交本题", exact: true }),
          ).toHaveCount(0);
        }
        // 第二题留空也能交卷，不强迫先逐题提交。
        const responsePromise = page.waitForResponse(
          (response) =>
            /\/api\/student\/attempts\/[^/]+\/submit$/.test(response.url()) &&
            response.request().method() === "POST",
        );
        await page
          .getByRole("button", {
            name: mode === "单题逐题" ? "提前交卷" : "交卷",
            exact: true,
          })
          .click();
        await page
          .getByRole("button", { name: "确认交卷", exact: true })
          .click();
        const response = await responsePromise;
        expect(response.status()).toBe(200);
        const sent = response.request().postDataJSON() as {
          revisions: unknown[];
          evidence: unknown[];
        };
        expect(sent.revisions).toHaveLength(2);
        expect(sent.evidence).toHaveLength(mode === "统一交卷" ? 2 : 1);
        await expect(page.getByText("批改结果", { exact: true })).toBeVisible();
        await expectResultCount(page, "答对", 1);
        await expect(
          page.getByRole("button", { name: "确认交卷", exact: true }),
        ).toHaveCount(0);
        await leak.drain();
        expect(leak.violations().join("\n")).toBe("");
      } finally {
        await context.close();
      }
    });
  }

  test("课程自由练习默认逐题：原位反馈 + 行锁定 + 未交题不泄露 + 自动收尾", async ({
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    // —— 造数：专属课程 + 两题练习 + 学生入成员 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e逐题反馈课程${suffix}`;
    const unitName = `逐题反馈小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importUnitToCourse(
      request,
      courseId,
      unitName,
      perQuestionPracticeMarkdown(unitName),
    );
    const student = await prepareCourseStudent(
      request,
      courseId,
      `e2e-feedback-${suffix}`,
      `e2e反馈生${suffix}`,
    );

    // —— 学生端：iPad 独立 context，全程泄露监控 ——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await openUnitLanding(
        studentPage,
        student.linkToken,
        courseId,
        courseName,
        unitName,
      );

      // —— 开始练习：摘要行默认逐题（新协议）——
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      const attemptId =
        studentPage.url().match(/\/s\/attempts\/([^/?#]+)/)?.[1] ?? "";
      expect(attemptId).not.toBe("");
      await expect(
        studentPage.getByText("做题方式：列表 · 每题提交后查看"),
      ).toBeVisible();

      // —— 第 1 题：作答 → 提交本题 → 原位反馈（参考答案 + 解析；进行中卷
      // 对错判定按 M2 设计不下发——finalCorrect 恒 null，徽章为待批文案）——
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await chooseAnswer(studentPage, 1, "对", true);
      await waitForDraftSaved(studentPage);
      const submitStart = Date.now();
      await q1.getByRole("button", { name: "提交本题" }).click();
      const feedback = q1.getByRole("region", { name: "本题反馈" });
      await expect(feedback).toBeVisible();
      annotateLatency("课程练习逐题提交→反馈可见", Date.now() - submitStart);
      await expect(feedback.getByText("回答正确")).toBeVisible();
      await expect(feedback.getByText("参考答案：")).toBeVisible();
      await expect(feedback.getByText("解析", { exact: true })).toBeVisible();
      await expect(feedback.getByText(/是正数/)).toBeVisible();

      // —— 已提交行锁定：答案控件只读（组件测试同款断言）——
      await expect(
        q1.getByRole("radio", { name: "对", exact: true }),
      ).toBeDisabled();
      await expect(q1.getByRole("button", { name: "提交本题" })).toHaveCount(0);

      // —— 未交的第 2 题无反馈区；草稿取卷键级断言（逐题提交后监控仍在）——
      const q2 = studentPage.locator('article[aria-label="第 2 题"]');
      await expect(q2.getByRole("region", { name: "本题反馈" })).toHaveCount(0);
      await expectDraftFetchClean(studentPage, attemptId);

      // —— 第 2 题（最后一题）：提交即自动收尾——回执按已收尾口径携带对错
      // 判定（finalCorrect 不再置 null），徽章为「回答正确」——
      await chooseAnswer(studentPage, 2, "选项 B");
      await waitForDraftSaved(studentPage);
      const lastStart = Date.now();
      await q2.getByRole("button", { name: "提交本题" }).click();
      const q2Feedback = q2.getByRole("region", { name: "本题反馈" });
      await expect(q2Feedback).toBeVisible();
      await expect(q2Feedback.getByText("回答正确")).toBeVisible();
      annotateLatency("课程练习末题提交→反馈可见", Date.now() - lastStart);
      await expect(
        studentPage.getByRole("button", { name: "查看本次结果" }),
      ).toBeVisible();
      await studentPage.getByRole("button", { name: "查看本次结果" }).click();
      await expect(studentPage.getByText("批改结果")).toBeVisible({
        timeout: 30_000,
      });
      await expectResultCount(studentPage, "总题数", 2);
      await expectResultCount(studentPage, "答对", 2);

      // —— 泄露检查：逐题提交后的草稿取卷等响应同样受检 ——
      // 等在途响应体检查落定（替代固定 800ms 采样窗，慢响应体不漏检）
      await leak.drain();
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });

  test("作业授权逐题（allowPerQuestionFeedback）：/s/assignments 进入同款逐题流", async ({
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    // —— 造数：练习单元入资源库 + 授权作业（不挂课程）+ 专属学生 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const unitName = `作业逐题单元${suffix}`;
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: perQuestionPracticeMarkdown(unitName),
        filename: `${unitName}.md`,
      },
    });
    if (!importRes.ok()) {
      throw new Error(
        `导入作业单元失败：HTTP ${importRes.status()} ${await importRes.text()}`,
      );
    }
    const loginName = `e2e-feedback-a${suffix}`;
    await createStudentViaApi(request, `e2e作业逐题生${suffix}`, loginName);
    const student = await getStudentViaApi(request, loginName);
    const assignmentId = await createAssignmentViaApi(request, {
      title: `e2e授权逐题作业${suffix}`,
      unitName,
      studentId: student.id,
      allowPerQuestionFeedback: true,
    });

    // —— 学生端：链接登录 → 直达 /s/assignments/:id（进入即幂等建卷）——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      const attemptRespPromise = studentPage.waitForResponse(
        (r) =>
          /\/api\/student\/assignments\/[^/]+\/attempt/.test(r.url()) &&
          r.request().method() === "POST" &&
          r.status() === 200,
      );
      await studentPage.goto(`/s/assignments/${assignmentId}`);
      const attemptResp = await attemptRespPromise;
      const attemptBody = (await attemptResp.json()) as {
        data?: { id?: string };
      };
      const attemptId = attemptBody.data?.id ?? "";
      expect(attemptId).not.toBe("");

      // —— 授权作业默认逐题（新协议）——
      await expect(
        studentPage.getByText("做题方式：列表 · 每题提交后查看"),
      ).toBeVisible();

      // —— 第 1 题：提交本题 → 原位反馈（显示授权的自动判定）+ 行锁定 ——
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await chooseAnswer(studentPage, 1, "对", true);
      await waitForDraftSaved(studentPage);
      const submitStart = Date.now();
      await q1.getByRole("button", { name: "提交本题" }).click();
      const feedback = q1.getByRole("region", { name: "本题反馈" });
      await expect(feedback).toBeVisible();
      annotateLatency("作业逐题提交→反馈可见", Date.now() - submitStart);
      await expect(feedback.getByText("回答正确")).toBeVisible();
      await expect(feedback.getByText("参考答案：")).toBeVisible();
      await expect(
        q1.getByRole("radio", { name: "对", exact: true }),
      ).toBeDisabled();

      // —— 未交的第 2 题：草稿取卷键级断言 ——
      await expectDraftFetchClean(studentPage, attemptId);

      // —— 第 2 题（最后一题）自动收尾（回执带对错）→ 查看本次结果 ——
      const q2 = studentPage.locator('article[aria-label="第 2 题"]');
      await chooseAnswer(studentPage, 2, "选项 B");
      await waitForDraftSaved(studentPage);
      await q2.getByRole("button", { name: "提交本题" }).click();
      const q2Feedback = q2.getByRole("region", { name: "本题反馈" });
      await expect(q2Feedback).toBeVisible();
      await expect(q2Feedback.getByText("回答正确")).toBeVisible();
      await studentPage.getByRole("button", { name: "查看本次结果" }).click();
      await expect(studentPage.getByText("批改结果")).toBeVisible({
        timeout: 30_000,
      });
      await expectResultCount(studentPage, "答对", 2);

      // 等在途响应体检查落定（替代固定 800ms 采样窗，慢响应体不漏检）
      await leak.drain();
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });

  test("教师未授权作业：整卷节奏 + 节奏组禁用 + 隐藏逐题入口 + 交卷出结果", async ({
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    // —— 造数：同款单元 + 未授权作业（不携带 allowPerQuestionFeedback）——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const unitName = `作业整卷单元${suffix}`;
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: perQuestionPracticeMarkdown(unitName),
        filename: `${unitName}.md`,
      },
    });
    if (!importRes.ok()) {
      throw new Error(
        `导入作业单元失败：HTTP ${importRes.status()} ${await importRes.text()}`,
      );
    }
    const loginName = `e2e-feedback-r${suffix}`;
    await createStudentViaApi(request, `e2e整卷作业生${suffix}`, loginName);
    const student = await getStudentViaApi(request, loginName);
    const assignmentId = await createAssignmentViaApi(request, {
      title: `e2e整卷作业${suffix}`,
      unitName,
      studentId: student.id,
      allowPerQuestionFeedback: false,
    });

    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");
      await studentPage.goto(`/s/assignments/${assignmentId}`);

      // —— 整卷节奏摘要 + 教师限制说明 ——
      await expect(
        studentPage.getByText("做题方式：列表 · 交卷后查看"),
      ).toBeVisible();
      await expect(studentPage.getByText("老师要求交卷后公布")).toBeVisible();

      // —— 展开做题方式：反馈节奏整组禁用（canChangeFeedback=false）——
      await studentPage.getByRole("button", { name: "调整做题方式" }).click();
      await expect(
        studentPage.getByRole("radio", { name: "每题提交后查看" }),
      ).toBeDisabled();
      await expect(
        studentPage.getByRole("radio", { name: "交卷后查看" }),
      ).toBeDisabled();

      // —— 教师限制下不提供逐题提交，普通作答不出现反馈 ——
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await chooseAnswer(studentPage, 1, "对", true);
      await waitForDraftSaved(studentPage);
      await expect(
        studentPage.getByRole("button", { name: "提交本题", exact: true }),
      ).toHaveCount(0);
      await expect(
        studentPage.getByRole("button", {
          name: "不会，提交并看解析",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(q1.getByRole("region", { name: "本题反馈" })).toHaveCount(0);
      await expect(
        q1.getByRole("radio", { name: "对", exact: true }),
      ).toBeEnabled();

      // —— 整卷作答交卷 → 结果可见 ——
      await chooseAnswer(studentPage, 2, "选项 B");
      await waitForDraftSaved(studentPage);
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
      await expectResultCount(studentPage, "答对", 2);

      // 等在途响应体检查落定（替代固定 800ms 采样窗，慢响应体不漏检）
      await leak.drain();
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });

  test("作答中切换反馈节奏（PATCH CAS）：切交卷后逐题提交不再即时反馈", async ({
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    // —— 造数：课程自由练习（教师策略未配置 → 两种节奏均可选）——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e节奏切换课程${suffix}`;
    const unitName = `节奏切换小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importUnitToCourse(
      request,
      courseId,
      unitName,
      perQuestionPracticeMarkdown(unitName),
    );
    const student = await prepareCourseStudent(
      request,
      courseId,
      `e2e-feedback-${suffix}`,
      `e2e反馈生${suffix}`,
    );

    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await openUnitLanding(
        studentPage,
        student.linkToken,
        courseId,
        courseName,
        unitName,
      );
      await studentPage.getByRole("button", { name: "开始练习" }).click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(
        studentPage.getByText("做题方式：列表 · 每题提交后查看"),
      ).toBeVisible();

      // —— 首次提交前展开做题方式，反馈节奏切「交卷后查看」（PATCH CAS）——
      await studentPage.getByRole("button", { name: "调整做题方式" }).click();
      const patchPromise = studentPage.waitForResponse(
        (r) =>
          /\/api\/student\/attempts\/[^/]+\/workflow/.test(r.url()) &&
          r.request().method() === "PATCH" &&
          r.status() === 200,
      );
      await studentPage.getByRole("radio", { name: "交卷后查看" }).click();
      await patchPromise;
      await expect(
        studentPage.getByText("做题方式：列表 · 交卷后查看"),
      ).toBeVisible();

      // —— 切换后收起逐题提交入口，不出现即时反馈 ——
      const q1 = studentPage.locator('article[aria-label="第 1 题"]');
      await chooseAnswer(studentPage, 1, "对", true);
      await waitForDraftSaved(studentPage);
      await expect(
        studentPage.getByRole("button", { name: "提交本题", exact: true }),
      ).toHaveCount(0);
      await expect(
        studentPage.getByRole("button", {
          name: "不会，提交并看解析",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(q1.getByRole("region", { name: "本题反馈" })).toHaveCount(0);
      await expect(
        q1.getByRole("radio", { name: "对", exact: true }),
      ).toBeEnabled();

      // —— 整卷作答交卷 → 结果可见（已答题行正常判定）——
      await chooseAnswer(studentPage, 2, "选项 B");
      await waitForDraftSaved(studentPage);
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
      await expectResultCount(studentPage, "答对", 2);

      // 等在途响应体检查落定（替代固定 800ms 采样窗，慢响应体不漏检）
      await leak.drain();
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });

  test("开始页推荐预选（M5）：单题 + 交卷后推荐直达作答页节奏", async ({
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    // —— 造数：带 practice 推荐的单元（单题 + 交卷后查看）——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e推荐预选课程${suffix}`;
    const unitName = `推荐预选小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importUnitToCourse(
      request,
      courseId,
      unitName,
      recommendedPracticeMarkdown(unitName),
    );
    const student = await prepareCourseStudent(
      request,
      courseId,
      `e2e-feedback-${suffix}`,
      `e2e反馈生${suffix}`,
    );

    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    try {
      const leak = attachLeakMonitor(studentPage);
      await openUnitLanding(
        studentPage,
        student.linkToken,
        courseId,
        courseName,
        unitName,
      );

      // —— 落地页展示「本单元推荐：单题 · 交卷后查看」——
      await expect(
        studentPage.getByText(/本单元推荐：单题 · 交卷后查看/),
      ).toBeVisible();

      // —— 不触碰选择器直接开始：服务端按推荐档建卷（单题 + 交卷后）——
      await studentPage
        .getByRole("button", { name: `开始练习 ${unitName}` })
        .click();
      await studentPage.waitForURL("**/s/attempts/**");
      await expect(
        studentPage.getByText("第 1 / 2 题 · 已填写 0 题"),
      ).toBeVisible();
      await expect(
        studentPage.getByRole("button", { name: "调整做题方式" }),
      ).toHaveCount(0);

      // —— 单题布局作答两题（下一题导航），整卷交卷出结果 ——
      await chooseAnswer(studentPage, 1, "对", true);
      await waitForDraftSaved(studentPage);
      await studentPage.getByRole("button", { name: "下一题" }).click();
      await expect(
        studentPage.locator('article[aria-label="第 2 题"]'),
      ).toBeVisible();
      await chooseAnswer(studentPage, 2, "选项 B");
      await waitForDraftSaved(studentPage);
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
      await expectResultCount(studentPage, "答对", 2);

      // 等在途响应体检查落定（替代固定 800ms 采样窗，慢响应体不漏检）
      await leak.drain();
      expect(leak.violations().join("\n")).toBe("");
    } finally {
      await studentContext.close();
    }
  });
});
