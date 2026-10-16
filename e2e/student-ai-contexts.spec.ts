import { devices, expect, test } from "@playwright/test";
import {
  chatCompletionJson,
  FAKE_AI_BASE_URL,
  FAKE_AI_MODEL,
  fakeAiControl,
} from "./fake-ai-provider";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  createStudentViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * SAI-33 四题型覆盖（B18 任务 2）：课程练习 / 错题重练 / 讲练逐题 三条
 * 学生来源（普通作业在主 spec student-ai.spec.ts 全链覆盖）各自的 AI 伴学
 * 行为 + 结果页共存断言（AI 复盘开栏在场时 原稿/订正/圈画/历史返回/保存
 * 保护/答案公布 互不干扰）。假供应商与出站分流架构同主 spec（见
 * e2e/fake-ai-provider.ts 头注）。
 *
 * 验收对照（B18 SAI-33）：
 * - 课程/错题/讲练的作答中求助：出站载荷含题面与答案解析（允许场景双断言，
 *   AGENTS 学生端 AI 例外），完成态（课程/错题=attempt 已交；讲练=该题
 *   submittedAt）后复盘可用；
 * - 讲练题级释放：已显示答案的题解析直出（无折叠按钮），未提交题页面文本
 *   仍无任何详解/题块原文；
 * - 共存：AI 开栏在场时圈画/草稿可正常落笔，交卷前保存保护（draft-status
 *   不停在「保存中」），结果页 查看详解/本次原稿/订正/本题历史 与 AI 复盘
 *   可先后使用且互不破坏（历史返回后复盘面板仍可用）。
 */

/** 两道判断（考点互异）：错题本按考点分组时可只重练一题（同 wrong-practice） */
function twoJudgeMarkdown(unitName: string): string {
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

/** 两题讲练（choice + judge）：详解带唯一标记词供题级释放/防泄露断言 */
function miniLessonMarkdown(unitName: string, lectureTitle: string): string {
  return [
    "---",
    "kind: lesson",
    `unit: ${unitName}`,
    "topic: 相反数",
    "---",
    "",
    `# ${lectureTitle}`,
    "",
    "段落一：相反数的引入。符号相反、绝对值相同的两个数互为相反数。",
    "",
    '::::question{type=choice difficulty=1 knowledge="相反数讲练甲"}',
    "$7$ 的相反数是（　）",
    "",
    "- [x] $-7$",
    "- [ ] $7$",
    "- [ ] $\\dfrac{1}{7}$",
    "",
    ":::solution",
    "讲练甲详解：$7$ 的相反数只有符号不同，是 $-7$。",
    ":::",
    "::::",
    "",
    "段落二：零的特殊性。",
    "",
    '::::question{type=judge difficulty=1 knowledge="相反数讲练乙"}',
    "$0$ 的相反数是 $0$。[[正确]]",
    "",
    ":::solution",
    "讲练乙详解：$0$ 的相反数是它本身，说法正确。",
    ":::",
    "::::",
    "",
    "段落三：小结。",
    "",
  ].join("\n");
}

/** 造「课程 + 可见练习单元 + 学生（已入成员）」并返回造数身份 */
async function makeCourseWorld(
  request: import("@playwright/test").APIRequestContext,
  suffix: string,
  markdown: (unitName: string) => string,
  unitVisible: boolean,
): Promise<{
  courseId: string;
  unitName: string;
  loginName: string;
}> {
  await teacherApiLogin(request);
  const courseId = await createCourseViaApi(request, `e2e-sai题型课${suffix}`);
  const unitName = `sai题型单元${suffix}`;
  const importRes = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: markdown(unitName),
      filename: `${unitName}.md`,
      courseId,
    },
  });
  if (!importRes.ok()) {
    throw new Error(`导入练习失败：HTTP ${importRes.status()}`);
  }
  if (unitVisible) {
    await setCourseItemVisible(request, courseId, unitName, true);
  }
  const loginName = `e2e-saictx-${suffix}`;
  await createStudentViaApi(request, `e2e题型生${suffix}`, loginName);
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  return { courseId, unitName, loginName };
}

/** 学生专属链接登录（iPad） */
async function loginStudent(
  browser: import("@playwright/test").Browser,
  linkToken: string,
) {
  const context = await browser.newContext(devices["iPad (gen 7)"]);
  const page = await context.newPage();
  await page.goto(`/s/${linkToken}`);
  await page.waitForURL("**/s/home");
  return { context, page };
}

/** API 快轨建默认 inapp 连接（连接 UI 已在主 spec 覆盖） */
async function connectInapp(
  studentApi: import("@playwright/test").APIRequestContext,
) {
  const res = await studentApi.post("/api/student/ai/connections", {
    data: {
      channel: "inapp",
      baseUrl: FAKE_AI_BASE_URL,
      model: FAKE_AI_MODEL,
      apiKey: "e2e-fake-key",
      isDefault: true,
    },
  });
  expect(res.status()).toBe(201);
}

test.describe("SAI-33 四题型与结果页共存", () => {
  // 串行：共享同一假供应商控制端（捕获/剧本是全局 FIFO）
  test.describe.configure({ mode: "serial" });

  test("课程练习与错题重练：作答中求助出站含答案，完成后复盘可用", async ({
    browser,
    request,
  }) => {
    test.setTimeout(300_000);
    const suffix = uniqueSuffix();
    const control = fakeAiControl(request);
    await control.reset();
    const world = await makeCourseWorld(
      request,
      suffix,
      twoJudgeMarkdown,
      true,
    );
    const student = await getStudentViaApi(request, world.loginName);
    const seed = await loginStudent(browser, student.linkToken);
    const page = seed.page;
    const studentApi = seed.context.request;
    const leak = attachLeakMonitor(page);
    try {
      await connectInapp(studentApi);

      // —— 课程练习：单元入口开卷（第 1 次）——
      const unitPath = `/s/courses/${world.courseId}/units/${encodeURIComponent(world.unitName)}`;
      await page.goto(unitPath);
      await page.getByRole("button", { name: "开始练习" }).click();
      await page.waitForURL("**/s/attempts/**");
      const q1 = page.locator('article[aria-label="第 1 题"]');
      await q1.waitFor({ state: "visible" });

      // —— 作答中求助：出站载荷含题面 + 答案 + 解析（允许场景双断言）——
      const reply = "课程回信：1 大于 0，是正数。";
      await control.script({ body: chatCompletionJson(reply) });
      await page.getByRole("button", { name: "AI 助教" }).click();
      await expect(page.getByText("当前：开放伴学")).toBeVisible();
      await page.getByPlaceholder("写下你想问的问题").fill("课程练习求助");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const outbound = await control.waitForRequest((r) =>
        r.body.includes("课程练习求助"),
      );
      expect(outbound.body, "出站应含题干").toContain("是正数");
      expect(outbound.body, "出站应含参考答案").toContain("正确");
      expect(outbound.body, "出站应含官方解析").toContain("大于");

      // —— 保存保护：AI 开栏在场时草稿保存不被卡在「保存中」——
      await expect
        .poll(async () => page.getByTestId("draft-status").textContent())
        .not.toContain("保存中");
      // 窄屏下面板是 Sheet 浮层：收起后再作答（草稿与求助记录不因收起丢失）
      await page.keyboard.press("Escape");

      // 两题都答错 → 入错题本；交卷
      for (const no of [1, 2]) {
        await page
          .locator(`article[aria-label="第 ${no} 题"]`)
          .getByRole("radio", { name: "错", exact: true })
          .locator("xpath=ancestor::label[1]")
          .click();
      }
      await page.getByRole("button", { name: "交卷", exact: true }).click();
      await page.getByRole("button", { name: "确认交卷" }).first().click();
      await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });

      // —— 课程卷完成态：AI 复盘可用（attempt 已提交 → open_study）——
      await page.getByRole("button", { name: "AI 复盘" }).click();
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
      ).toBeEnabled();

      // —— 错题本：按考点只重练 q1（有理数的概念组）——
      await page.goto("/s/wrong");
      await expect(
        page.getByRole("heading", {
          name: `${world.unitName} · 待复习 2 题`,
        }),
      ).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "按考点" }).click();
      const q1Group = page.getByRole("region", {
        name: "有理数的概念 · 待复习 1 题",
      });
      await q1Group.getByRole("button", { name: "重练本组（1 题）" }).click();
      await page.waitForURL("**/s/attempts/**");
      await expect(
        page.getByRole("heading", { name: "错题重练", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("错题重练 · 第 1 次")).toBeVisible();

      // —— 重练卷作答中求助：同一冻结投影（题面/答案/解析仍进出站）——
      const reReply = "重练回信：注意符号判断。";
      await control.script({ body: chatCompletionJson(reReply) });
      await page.getByRole("button", { name: "AI 助教" }).click();
      await expect(page.getByText("当前：开放伴学")).toBeVisible();
      await page.getByPlaceholder("写下你想问的问题").fill("错题重练求助");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const reOutbound = await control.waitForRequest((r) =>
        r.body.includes("错题重练求助"),
      );
      expect(reOutbound.body, "重练出站应含题干").toContain("是正数");
      expect(reOutbound.body, "重练出站应含参考答案").toContain("正确");
      await page.keyboard.press("Escape");

      // 答对交卷：重练完成
      await q1
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect
        .poll(async () => page.getByTestId("draft-status").textContent())
        .not.toContain("保存中");
      await page.getByRole("button", { name: "交卷", exact: true }).click();
      await page.getByRole("button", { name: "确认交卷" }).first().click();
      await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });

      expect(leak.violations(), "全程学生端响应无禁键").toEqual([]);
    } finally {
      await seed.context.close();
    }
  });

  test("讲练逐题：作答中可求助，显示答案后题级释放且未提交题零泄露", async ({
    browser,
    request,
  }) => {
    test.setTimeout(300_000);
    const suffix = uniqueSuffix();
    const control = fakeAiControl(request);
    await control.reset();
    const lectureTitle = `SAI讲练${suffix}`;
    const world = await makeCourseWorld(
      request,
      suffix,
      (unitName) => miniLessonMarkdown(unitName, lectureTitle),
      false,
    );
    const student = await getStudentViaApi(request, world.loginName);
    const seed = await loginStudent(browser, student.linkToken);
    const page = seed.page;
    const studentApi = seed.context.request;
    const leak = attachLeakMonitor(page);
    try {
      await connectInapp(studentApi);

      // —— 讲义列表直达讲练页 → 开始练习 ——
      await page.getByRole("link", { name: "按讲义浏览" }).click();
      await page.waitForURL("**/s/lectures");
      await page
        .getByRole("link", { name: `打开讲练 ${lectureTitle}` })
        .click();
      await page.waitForURL(/\/s\/lectures\/[^/]+\/lesson(\?|$)/);
      await page
        .getByRole("button", { name: `开始练习 ${lectureTitle}` })
        .click();
      await page.waitForURL(/\/s\/lectures\/[^/]+\/lesson\/run/);

      const q1 = page.locator('article[aria-label="第 1 题"]');
      const q2 = page.locator('article[aria-label="第 2 题"]');
      await q1.waitFor({ state: "visible" });

      // —— 未提交时：页面文本无任何详解/题块原文（讲练防泄露根基）——
      let bodyText = await page.locator("body").innerText();
      for (const marker of ["讲练甲详解", "讲练乙详解", "[[", ":::solution"]) {
        expect(bodyText.includes(marker), `页面不应出现「${marker}」`).toBe(
          false,
        );
      }

      // —— 讲练作答中求助（open_study 默认）：出站含题面与答案解析 ——
      const reply = "讲练回信：相反数只差一个符号。";
      await control.script({ body: chatCompletionJson(reply) });
      await page.getByRole("button", { name: "AI 助教" }).click();
      await expect(page.getByText("当前：开放伴学")).toBeVisible();
      await page.getByPlaceholder("写下你想问的问题").fill("讲练页求助");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const outbound = await control.waitForRequest((r) =>
        r.body.includes("讲练页求助"),
      );
      expect(outbound.body, "讲练出站应含题干").toContain("相反数");
      expect(outbound.body, "讲练出站应含官方解析").toContain("讲练甲详解");

      // —— q1 显示答案（答对）：题级释放——解析直出、行级锁定 ——
      await page.keyboard.press("Escape");
      await q1
        .getByRole("radio", { name: "选项 A" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await q1.getByRole("button", { name: "显示答案" }).click();
      await expect(q1.getByText("答对", { exact: true }).first()).toBeVisible();
      await expect(q1.getByText(/讲练甲详解/)).toBeVisible();
      await expect(
        q1.getByRole("button", { name: /草稿纸|圈画题干/ }),
      ).toHaveCount(0);

      // —— q2 未提交：零泄露 + AI 仍可用（open_study 作答中即可求助）——
      bodyText = await page.locator("body").innerText();
      expect(bodyText.includes("讲练乙详解"), "未提交题不得出现详解").toBe(
        false,
      );
      await page.getByRole("button", { name: "AI 助教" }).click();
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
      ).toBeEnabled();

      // —— 最后一题显示答案 → 事务内自动收尾 → 完成视图 ——
      await page.keyboard.press("Escape");
      await q2
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await q2.getByRole("button", { name: "显示答案" }).click();
      await expect(page.getByText("已完成", { exact: true })).toBeVisible();
      await expect(page.getByText("答对 2 · 答错 0 · 待批 0")).toBeVisible();

      // —— 结果页：来源「讲练」+ AI 复盘可用（两题均已 submittedAt）——
      await page.getByRole("link", { name: "查看结果" }).click();
      await page.waitForURL("**/s/attempts/**");
      await expect(page.getByText("批改结果")).toBeVisible();
      await expect(
        page.getByText(`讲练：${lectureTitle} · 第 1 次`),
      ).toBeVisible();
      await page.getByRole("button", { name: "AI 复盘" }).click();
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
      ).toBeEnabled();

      expect(leak.violations(), "全程学生端响应无禁键").toEqual([]);
    } finally {
      await seed.context.close();
    }
  });

  test("结果页共存：AI 复盘与圈画/草稿/保存保护/详解/原稿/订正/历史互不干扰", async ({
    browser,
    request,
  }) => {
    test.setTimeout(300_000);
    const suffix = uniqueSuffix();
    const control = fakeAiControl(request);
    await control.reset();
    await teacherApiLogin(request);
    const courseId = await createCourseViaApi(
      request,
      `e2e-sai共存课${suffix}`,
    );
    const unitName = `sai共存单元${suffix}`;
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: twoJudgeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    expect(importRes.ok()).toBe(true);
    await setCourseItemVisible(request, courseId, unitName, true);
    const loginName = `e2e-saico-${suffix}`;
    await createStudentViaApi(request, "e2e共存生", loginName);
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const seed = await loginStudent(browser, student.linkToken);
    const page = seed.page;
    const studentApi = seed.context.request;
    const leak = attachLeakMonitor(page);
    try {
      await connectInapp(studentApi);

      // 宽视口：圈画/草稿与伴学栏可同屏（窄屏 Sheet 行为已由主 spec 覆盖）
      await page.setViewportSize({ width: 1280, height: 900 });
      const unitPath = `/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`;
      await page.goto(unitPath);
      await page.getByRole("button", { name: "开始练习" }).click();
      await page.waitForURL("**/s/attempts/**");
      const q1 = page.locator('article[aria-label="第 1 题"]');
      await q1.waitFor({ state: "visible" });

      // —— AI 开栏在场：先开伴学栏（面板挂载、发送可用），再落笔圈画与草稿 ——
      await page.getByRole("button", { name: "AI 助教" }).click();
      await expect(page.getByText("当前：开放伴学")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "关闭 AI 助教" }).click();

      // 圈画：题干标注挂画布、可落笔、收起后笔迹保留（已有 1 笔）
      const annotationTrigger = q1.getByRole("button", { name: /圈画题干/ });
      await annotationTrigger.click();
      const annotationCanvas = q1.locator(
        'canvas[data-slot="annotation-canvas"]',
      );
      await expect(annotationCanvas).toHaveAttribute(
        "data-input-enabled",
        "true",
      );
      await drawStrokeWithPointerEvents(annotationCanvas);
      await expect(annotationTrigger).toHaveAccessibleName(/已有 1 笔/);
      await annotationTrigger.click(); // 再次点击收起，笔迹不丢
      await expect(annotationTrigger).toHaveAccessibleName(/已有 1 笔/);

      // 草稿：纸面可落笔后收起（正式手写归真机/ink 系列 spec）
      const paperTrigger = q1.getByRole("button", {
        name: /^第 1 题草稿纸(?:（|$)/,
      });
      await paperTrigger.click();
      await drawStrokeWithPointerEvents(
        q1.locator('[data-slot="ink-pad-canvas"] canvas'),
      );
      await paperTrigger.click();
      await expect(q1.locator('[data-slot="note-paper"]')).not.toBeVisible();

      // —— 保存保护：有 AI 开栏与两份材料在途时，保存态收敛不卡「保存中」——
      await expect
        .poll(async () => page.getByTestId("draft-status").textContent())
        .not.toContain("保存中");

      // 答对两题 → 交卷
      for (const no of [1, 2]) {
        await page
          .locator(`article[aria-label="第 ${no} 题"]`)
          .getByRole("radio", { name: "对", exact: true })
          .locator("xpath=ancestor::label[1]")
          .click();
      }
      await page.getByRole("button", { name: "交卷", exact: true }).click();
      await page.getByRole("button", { name: "确认交卷" }).first().click();
      await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });

      // —— 结果页：AI 复盘开栏 + 单行操作栏逐项共存 ——
      await page.getByRole("button", { name: "AI 复盘" }).click();
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "关闭 AI 助教" }).click();

      const resultCard = page.getByRole("article", {
        name: "第 1 题",
        exact: true,
      });
      const tools = resultCard.getByRole("region", {
        name: "第 1 题材料与订正",
      });
      const row = tools.getByRole("group", {
        name: "第 1 题操作（可横向滚动）",
      });

      // 答案公布：查看详解展开解析（判分已在服务端完成）
      await row.getByRole("button", { name: "查看详解", exact: true }).click();
      await expect(resultCard.getByText(/大于/)).toBeVisible();

      // 原稿：切换到本次原稿视图（题卡持续挂载，AI 面板不受影响）
      await row.getByRole("button", { name: "本次原稿", exact: true }).click();
      await expect(
        resultCard.getByRole("button", { name: "第 1 题查看草稿原稿" }),
      ).toBeVisible();

      // 订正：原稿视图让位订正（互斥切换；AI 复盘面板仍开）
      await row.getByRole("button", { name: "订正", exact: true }).click();
      await expect(
        resultCard.getByRole("button", { name: "第 1 题查看草稿原稿" }),
      ).toBeHidden();
      await expect(
        resultCard.getByRole("button", { name: "添加订正标画", exact: false }),
      ).toBeVisible();

      // 历史返回：进本题历史 → 返回作答结果，AI 复盘面板仍可用
      await resultCard.getByRole("link", { name: "第 1 题本题历史" }).click();
      await expect(
        page.getByRole("link", { name: "返回作答结果" }),
      ).toBeVisible();
      await page.getByRole("link", { name: "返回作答结果" }).click();
      await expect(resultCard).toBeInViewport();
      // 历史返回后重开 AI 复盘仍可用（控制器持续挂载，不因导航丢状态）
      await page.getByRole("button", { name: "AI 复盘" }).click();
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
        "历史返回后 AI 复盘仍可用",
      ).toBeEnabled();

      expect(leak.violations(), "全程学生端响应无禁键").toEqual([]);
    } finally {
      await seed.context.close();
    }
  });
});
