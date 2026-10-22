import { devices, expect, test } from "@playwright/test";
import {
  chatCompletionJson,
  FAKE_AI_BASE_URL,
  FAKE_AI_MODEL,
  fakeAiApiKey,
  fakeAiControl,
} from "./fake-ai-provider";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  createStudentViaApi,
  getStudentViaApi,
  TEACHER_LOGIN_NAME,
  TEACHER_PASSWORD,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * SAI-33 学生端 AI 伴学全链 E2E（B18「完整回归与性能」主 spec）。
 *
 * 在真实 server（8899）+ 真实 web（5199）上跑完整业务链：教师设置默认模式 →
 * 学生连接 AI（首次知情 + inapp 连接）→ 作答中打开伴学栏（零自动出站）→
 * 单题求助（题面 + 答案解析按策略进入出站载荷）→ 页内回信 → 追问 → 交卷 →
 * 结果页复盘 → 教师 /t/data/attempts/:id 督学记录。出站的外部 AI 端点经
 * provider-client 的 E2E_FAKE_AI_BASE_URL 应用层注入点分流到 globalSetup
 * 启动的假供应商（127.0.0.1:8898；业务链路全真，不直接改 status 跳业务）；
 * MCP 通道闭环已有 student-mcp-loop.spec.ts，link 通道在第三用例覆盖。
 *
 * 验收场景对照（B18 SAI-33）：
 * - 无 AI 开栏自动出站：打开面板/轮询期间假供应商捕获数为 0、零 POST /ai/tasks；
 * - 轮询不重挂题面：等待回信的 10s 轮询窗口内题卡 DOM 身份不变（expando 标记）；
 * - 教师改设置立即生效：教师切换学生覆盖模式后学生 status 实时变不可用；
 * - 隔离：换账号后他人任务列表为空、直取任务 id 404 同文案。
 */

/** 全链用例的服务器时钟余量（worker 2s 一轮 + UI 10s 轮询 + CI 慢机） */
const FULL_CHAIN_TIMEOUT = 300_000;

/** 教师域造一个「判断 + 单选两题作业 + 一名学生」的世界（沿用 helpers 造数口径） */
async function makeWorld(
  request: import("@playwright/test").APIRequestContext,
  suffix: string,
  assignmentTitle = `SAI全链作业${suffix}`,
): Promise<{
  assignmentId: string;
  loginName: string;
  studentId: string;
}> {
  await teacherApiLogin(request);
  const courseId = await createCourseViaApi(request, `e2e-sai全链课${suffix}`);
  const unitName = `sai全链单元${suffix}`;
  const importRes = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: choiceJudgePracticeMarkdown(unitName),
      filename: `${unitName}.md`,
      courseId,
    },
  });
  if (!importRes.ok()) {
    throw new Error(`导入练习失败：HTTP ${importRes.status()}`);
  }
  const unitId = (
    (await importRes.json()) as { data: { units: { id: string }[] } }
  ).data.units[0]?.id;
  if (unitId === undefined) throw new Error("导入响应缺少单元 id");

  const loginName = `e2e-sai33-${suffix}`;
  await createStudentViaApi(request, `e2e全链生${suffix}`, loginName);
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);

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
  const assignmentId = (
    (await assignmentRes.json()) as { data: { assignments: { id: string }[] } }
  ).data.assignments[0]?.id;
  if (assignmentId === undefined) throw new Error("布置响应缺少作业 id");
  return { assignmentId, loginName, studentId: student.id };
}

/** 学生专属链接登录 → 会话 context + page */
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

/** 教师 UI 登录（独立 context，复用 helpers 常量） */
async function loginTeacherUi(browser: import("@playwright/test").Browser) {
  const context = await browser.newContext(devices["iPad (gen 7)"]);
  const page = await context.newPage();
  await page.goto("/t/login");
  await page.fill("#login-name", TEACHER_LOGIN_NAME);
  await page.fill("#login-password", TEACHER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/t/library");
  return { context, page };
}

/** 学生开卷进入作答页（首页待办卡片 → 开始练习），返回 assignmentId（URL 尾段） */
async function openAssignmentAttempt(
  page: import("@playwright/test").Page,
  assignmentTitle: string,
): Promise<string> {
  const card = page.locator("li", { hasText: assignmentTitle });
  await expect(card).toHaveCount(1);
  await card.getByRole("link", { name: "开始练习" }).click();
  await page.waitForURL("**/s/assignments/**");
  return page.url().split("/").pop() ?? "";
}

/** 取进行中 attempt 的 id（create-or-return 幂等；作答页 URL 只含 assignmentId） */
async function ensureAttemptId(
  request: import("@playwright/test").APIRequestContext,
  assignmentId: string,
): Promise<string> {
  const res = await request.post(
    `/api/student/assignments/${assignmentId}/attempt`,
  );
  if (!res.ok()) {
    throw new Error(`取回进行中作答失败：HTTP ${res.status()}`);
  }
  const id = ((await res.json()) as { data: { id: string } }).data.id;
  if (id === undefined) throw new Error("作答响应缺少 id");
  return id;
}

test("三种助教布局设置往返、侧边回退、分节展开和原稿保留", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(FULL_CHAIN_TIMEOUT);
  const suffix = uniqueSuffix();
  const world = await makeWorld(request, suffix);
  const student = await getStudentViaApi(request, world.loginName);
  const seed = await loginStudent(browser, student.linkToken);
  const page = seed.page;
  try {
    expect(
      (
        await seed.context.request.post("/api/student/ai/connections", {
          data: {
            channel: "inapp",
            baseUrl: FAKE_AI_BASE_URL,
            model: FAKE_AI_MODEL,
            apiKey: fakeAiApiKey(),
            isDefault: true,
          },
        })
      ).ok(),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openAssignmentAttempt(page, `SAI全链作业${suffix}`);
    const q1 = page.getByRole("article", { name: "第 1 题", exact: true });
    const trigger = q1.getByRole("button", { name: "AI 助教", exact: true });
    const workspace = page.getByRole("region", { name: "第 1 题的 AI 助教" });
    await trigger.click();
    await page
      .getByRole("textbox", { name: "补充问题" })
      .fill("保留布局切换前的问题");
    for (const layout of ["侧边对照", "独立弹窗", "题下阅读"]) {
      await workspace.getByRole("button", { name: "AI 设置" }).click();
      await page.getByRole("button", { name: "显示方式设置" }).click();
      await expect(page).toHaveURL(/\/s\/settings\?.*#ai-display$/);
      await page.getByRole("radio", { name: new RegExp(layout) }).check();
      await page.getByRole("button", { name: "保存显示方式" }).click();
      await expect(page.getByRole("status")).toHaveText(/显示方式已保存/);
      await page.screenshot({
        path: testInfo.outputPath(`display-${layout}.png`),
        fullPage: true,
      });
      await page.getByRole("link", { name: "返回本题" }).click();
      await expect(workspace).toBeVisible();
      await expect(page.getByRole("textbox", { name: "补充问题" })).toHaveValue(
        "保留布局切换前的问题",
      );
      if (layout === "侧边对照") {
        await expect(
          page.getByRole("complementary", { name: "AI 对照" }),
        ).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(
          page.getByRole("dialog", { name: /AI 助教/ }),
        ).toBeVisible();
        await expect(page.getByText(/当前空间不足/)).toBeVisible();
        await page.setViewportSize({ width: 1440, height: 1000 });
        await expect(page.getByRole("dialog")).toBeVisible();
      } else if (layout === "独立弹窗")
        await expect(page.getByRole("dialog")).toBeVisible();
      else await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    const control = fakeAiControl(request);
    await control.script({
      body: chatCompletionJson(
        "# 一起看这道题\n\n先看条件。\n\n## 观察\n先试一个例子。\n\n## 计算\n然后计算 $1+1=2$。\n\n## 检查\n回题检查新步骤。",
      ),
    });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page
      .getByRole("button", { name: "查看回信" })
      .click({ timeout: 30_000 });
    const sections = workspace.locator("details[data-ai-section]");
    await expect(sections).toHaveCount(3);
    await expect(sections.nth(1)).not.toHaveAttribute("open");
    const title = sections.nth(1).locator("summary");
    await title.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    await title.click();
    await expect(sections.nth(1)).toHaveAttribute("open");
    expect(
      Math.abs((await page.evaluate(() => window.scrollY)) - before),
    ).toBeLessThan(24);
    await page.getByRole("button", { name: "放大阅读" }).click();
    await expect(
      page.getByRole("dialog").locator("details[data-ai-section][open]"),
    ).toHaveCount(2);
    await expect(page.locator(".ai-reply-markdown .katex")).toHaveCount(1);
    // 正文使用弹窗内容区全宽，不能再叠加固定阅读列限宽。
    await expect
      .poll(() =>
        page
          .getByRole("dialog")
          .locator(".ai-reply-markdown")
          .evaluate((reply) => {
            const host = reply.closest<HTMLElement>("[data-ai-scroll]");
            if (!host) return Number.POSITIVE_INFINITY;
            const style = getComputedStyle(host);
            return (
              host.clientWidth -
              Number.parseFloat(style.paddingLeft) -
              Number.parseFloat(style.paddingRight) -
              (reply as HTMLElement).offsetWidth
            );
          }),
      )
      .toBeLessThanOrEqual(2);
    await page.screenshot({
      path: testInfo.outputPath("display-dialog-wide.png"),
      animations: "disabled",
    });
    await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("display-dialog-320.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "这一步没懂" }).click();
    await page.getByRole("textbox", { name: "继续追问本题" }).fill("保留追问");
    await expect(
      page.locator("[data-ai-input]").getByRole("textbox"),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "还原阅读" }).click();
    await expect(
      page.getByRole("textbox", { name: "继续追问本题" }),
    ).toHaveValue("保留追问");
    await expect(
      sections.filter({ has: page.locator("summary") }).locator(":scope[open]"),
    ).toHaveCount(2);
  } finally {
    await seed.context.close();
  }
});

test("求助记录回题只定位，查看回复遵循三种显示偏好", async ({
  browser,
  request,
}) => {
  test.setTimeout(FULL_CHAIN_TIMEOUT);
  const suffix = uniqueSuffix();
  const world = await makeWorld(request, suffix);
  const student = await getStudentViaApi(request, world.loginName);
  const { page, context } = await loginStudent(browser, student.linkToken);
  try {
    expect(
      (
        await context.request.post("/api/student/ai/connections", {
          data: {
            channel: "inapp",
            baseUrl: FAKE_AI_BASE_URL,
            model: FAKE_AI_MODEL,
            apiKey: fakeAiApiKey(),
            isDefault: true,
          },
        })
      ).ok(),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 700 });
    await openAssignmentAttempt(page, `SAI全链作业${suffix}`);
    const attemptUrl = page.url();
    const q1 = page.getByRole("article", { name: "第 1 题", exact: true });
    const workspace = page.getByRole("region", { name: "第 1 题的 AI 助教" });
    await q1.getByRole("button", { name: "AI 助教", exact: true }).click();
    await fakeAiControl(request).script({
      body: chatCompletionJson("这是按钮语义回归的回复。"),
    });
    await page.getByRole("textbox", { name: "补充问题" }).fill("帮我理解本题");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page
      .getByRole("button", { name: "查看回信" })
      .click({ timeout: 30_000 });

    for (const layout of ["侧边对照", "独立弹窗", "题下阅读"]) {
      await workspace.getByRole("button", { name: "AI 设置" }).click();
      await page.getByRole("button", { name: "显示方式设置" }).click();
      await page.getByRole("radio", { name: new RegExp(layout) }).check();
      await page.getByRole("button", { name: "保存显示方式" }).click();
      await expect(page.getByRole("status")).toHaveText(/显示方式已保存/);
      await page.getByRole("link", { name: "返回本题" }).click();
      await expect(workspace).toBeVisible();
      await page
        .getByRole("button", {
          name: layout === "独立弹窗" ? "关闭弹层" : "收起 AI 助教",
        })
        .click();

      // 同卷直接回题与从记录页跨页回题都不应打开 AI 正文。
      for (const crossPage of [false, true]) {
        if (crossPage) await page.goto("/s/records");
        await page.getByRole("button", { name: /^助教队列/ }).click();
        const queue = page.getByRole("dialog", { name: "求助记录" });
        await queue
          .getByRole("button", { name: "回到本题", exact: true })
          .click();
        await expect(queue).toHaveCount(0);
        await expect(workspace).toHaveCount(0);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(q1).toBeInViewport();
        await expect(page).not.toHaveURL(/aiQuestion|aiTask/);
      }
      await page.getByRole("button", { name: /^助教队列/ }).click();
      await page
        .getByRole("dialog", { name: "求助记录" })
        .getByRole("button", { name: "查看回复", exact: true })
        .click();
      await expect(
        page.getByText("这是按钮语义回归的回复。", { exact: true }),
      ).toBeVisible();
      if (layout === "独立弹窗")
        await expect(
          page.getByRole("dialog", { name: /AI 助教/ }),
        ).toBeVisible();
      else if (layout === "侧边对照")
        await expect(
          page.getByRole("complementary", { name: "AI 对照" }),
        ).toBeVisible();
      else await expect(q1.locator("..", { has: workspace })).toBeVisible();
    }
    expect(attemptUrl).toContain("/s/assignments/");
  } finally {
    await context.close();
  }
});

test.describe("SAI-33 学生端 AI 全链（页内通道）", () => {
  // 组内顺序运行；跨文件和浏览器的剧本、捕获、重置按用例凭据隔离。
  test.describe.configure({ mode: "serial" });

  test("题下助教跨视口阅读、单输入、草稿恢复与原题返回", async ({
    browser,
    request,
  }) => {
    test.setTimeout(FULL_CHAIN_TIMEOUT);
    const suffix = uniqueSuffix();
    const assignmentTitle = `${"有理数专题巩固练习与错因分析，阅读提示后回题尝试。".repeat(3)}${suffix}`;
    const world = await makeWorld(request, suffix, assignmentTitle);
    const student = await getStudentViaApi(request, world.loginName);
    const seed = await loginStudent(browser, student.linkToken);
    const page = seed.page;
    const control = fakeAiControl(request);
    try {
      expect(
        (
          await seed.context.request.post("/api/student/ai/connections", {
            data: {
              channel: "inapp",
              baseUrl: FAKE_AI_BASE_URL,
              model: FAKE_AI_MODEL,
              apiKey: fakeAiApiKey(),
              isDefault: true,
            },
          })
        ).ok(),
      ).toBe(true);
      await page.setViewportSize({ width: 1024, height: 768 });
      await openAssignmentAttempt(page, assignmentTitle);
      const q1 = page.getByRole("article", { name: "第 1 题", exact: true });
      const trigger = q1.getByRole("button", { name: "AI 助教", exact: true });
      await q1.evaluate((element) =>
        element.setAttribute("data-learning-marker", "original"),
      );
      await trigger.click();
      const workspace = page.getByRole("region", { name: "第 1 题的 AI 助教" });
      await expect(workspace).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("textbox")).toHaveCount(1);
      const draft = page.getByRole("textbox", { name: "补充问题" });
      await draft.fill("保留这份提问草稿");
      await page.getByRole("button", { name: "AI 设置" }).click();
      await page.getByRole("link", { name: "管理 AI 连接" }).click();
      await page.waitForURL("**/s/settings/ai**");
      await page.getByRole("link", { name: "返回原题" }).click();
      await expect(workspace).toBeVisible();
      await expect(draft).toHaveValue("保留这份提问草稿");
      expect(await control.requests()).toHaveLength(0);
      // 路由往返后重新标记；后续布局切换必须保持这份新挂载题面。
      await q1.evaluate((element) =>
        element.setAttribute("data-learning-marker", "original"),
      );
      for (const viewport of [
        { width: 768, height: 1024 },
        { width: 320, height: 740 },
        { width: 1440, height: 1000 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(draft).toHaveValue("保留这份提问草稿");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
      }
      await page.getByRole("button", { name: "放大阅读" }).click();
      await expect(page.getByRole("dialog", { name: /AI 助教/ })).toBeVisible();
      await expect(draft).toHaveValue("保留这份提问草稿");
      await page.getByRole("button", { name: "还原阅读" }).click();
      await expect(q1).toHaveAttribute("data-learning-marker", "original");
      await page.getByRole("button", { name: "收起 AI 助教" }).click();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(draft).toHaveValue("保留这份提问草稿");
      await control.script({
        body: chatCompletionJson(
          "先观察题目的条件，再判断符号。\n\n".repeat(30),
        ),
      });
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await page
        .getByRole("button", { name: "查看回信" })
        .click({ timeout: 30_000 });
      await expect(page.getByRole("textbox")).toHaveCount(0);
      await page.getByRole("button", { name: "放大阅读" }).click();
      await expect(page.getByRole("dialog", { name: /AI 助教/ })).toBeVisible();
      await expect(page.getByRole("textbox")).toHaveCount(0);
      await page.getByRole("button", { name: "还原阅读" }).click();
      await expect(workspace).toBeVisible();
      await expect(
        page.getByRole("button", { name: "放大阅读" }),
      ).toBeFocused();
      await page.getByRole("button", { name: "这一步没懂" }).click();
      const followup = page.getByRole("textbox", { name: "继续追问本题" });
      await followup.fill("为什么这样判断？");
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(q1).toBeInViewport();
      await trigger.click();
      await expect(followup).toHaveValue("为什么这样判断？");
      await page.getByRole("button", { name: "带新稿另问" }).click();
      await expect(page.getByRole("textbox")).toHaveCount(1);
      await expect(
        page.getByRole("textbox", { name: "补充问题" }),
      ).toBeVisible();
      const firstTaskCount = (await control.requests()).length;
      await expect(page.getByText(/问法：请检查我新写的步骤/)).toBeVisible();
      expect(firstTaskCount).toBe(1);
      const updatedReply =
        "## 核对新步骤\n\n这里先比较左右两边。\n\n\\[x+2=5 \\quad \\text{或} \\quad x+2=-5\\]\n\n## 再试一次\n\n回题检查符号。" +
        `\n\n| 步骤 | 说明 |\n| --- | --- |\n| ${"long-step".repeat(40)} | 长表格可单独横向查看 |`;
      await control.script({ body: chatCompletionJson(updatedReply) });
      await draft.fill("我新写的步骤：先比较左右两边，再判断符号。");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await page
        .getByRole("button", { name: "查看回信" })
        .click({ timeout: 30_000 });
      await expect(
        page.getByRole("heading", { name: "核对新步骤", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".ai-reply-markdown .katex")).toHaveCount(1);
      const reply = workspace.locator(".ai-reply-markdown");
      const materialSummary = workspace
        .getByRole("article")
        .filter({ has: page.locator(".ai-reply-markdown") })
        .locator("summary", { hasText: "材料：" });
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 768, height: 1024 },
        { width: 320, height: 740 },
      ]) {
        await page.setViewportSize(viewport);
        const replyBox = await reply.boundingBox();
        const summaryBox = await materialSummary.boundingBox();
        if (!replyBox || !summaryBox) throw new Error("阅读区域尚未呈现");
        expect(Math.abs(replyBox.x - summaryBox.x)).toBeLessThanOrEqual(1);
        const section = workspace.locator("details[data-ai-section]", {
          has: page.getByRole("heading", { name: "再试一次", exact: true }),
        });
        await section.locator("summary").click();
        await expect(section).toHaveAttribute("open", "");
        await section.locator("summary").click();
        await expect(section).not.toHaveAttribute("open", "");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
        await workspace.evaluate((element) =>
          element.scrollIntoView({ block: "start" }),
        );
        await page.screenshot({
          path: `e2e/.artifacts/ai-reading-${viewport.width}-${test.info().project.name}.png`,
        });
      }
      await workspace.getByRole("button", { name: "放大阅读" }).click();
      const readingDialog = page.getByRole("dialog", { name: /AI 助教/ });
      const dialogSection = readingDialog.locator("details[data-ai-section]", {
        has: page.getByRole("heading", { name: "再试一次", exact: true }),
      });
      await dialogSection.locator("summary").click();
      await expect(dialogSection).toHaveAttribute("open", "");
      await readingDialog.getByRole("button", { name: "还原阅读" }).click();
      await page.setViewportSize({ width: 320, height: 740 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `e2e/.artifacts/ai-workspace-narrow-${test.info().project.name}.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("button", { name: "回题试一试" }).click();
      await expect(workspace).toHaveCount(0);
      await expect(q1).toBeInViewport();
      const sameUrl = page.url();
      await page.getByRole("button", { name: /助教队列：/ }).click();
      await page
        .getByRole("list", { name: "助教任务列表" })
        .getByRole("button", { name: "查看回复", exact: true })
        .first()
        .click();
      await expect(workspace).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "核对新步骤", exact: true }),
      ).toBeVisible();
      expect(page.url()).toBe(sameUrl);
      await expect(q1).toHaveAttribute("data-learning-marker", "original");
      await page.screenshot({
        path: `e2e/.artifacts/ai-learning-flow-${test.info().project.name}.png`,
      });
      await page.goto("/s/records");
      await page.getByRole("button", { name: /助教队列：/ }).click();
      await page
        .getByRole("list", { name: "助教任务列表" })
        .getByRole("button", { name: "查看回复", exact: true })
        .first()
        .click();
      await expect(
        page.getByRole("heading", { name: "核对新步骤", exact: true }),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toMatch(/^\/s\/attempts\//);
      await expect
        .poll(() => new URL(page.url()).searchParams.has("aiTask"))
        .toBe(false);
    } finally {
      await seed.context.close();
    }
  });

  test("教师设置→学生连接→作答求助→回信追问→交卷复盘→教师记录", async ({
    browser,
    request,
  }) => {
    test.setTimeout(FULL_CHAIN_TIMEOUT);
    const suffix = uniqueSuffix();
    const control = fakeAiControl(request);
    await control.reset();
    expect(
      await control.health(),
      "假供应商应随 globalSetup 激活（见 e2e/global-setup.ts）",
    ).toBe(true);

    const world = await makeWorld(request, suffix);
    const student = await getStudentViaApi(request, world.loginName);

    // —— ① 教师设置：切「完成后可用」保存 → 切回「开放伴学」保存（覆盖
    //    教师设置 UI 读写两条路径；默认即 open_study，先偏移再回正才有写请求） ——
    const teacherUi = await loginTeacherUi(browser);
    try {
      await teacherUi.page.goto("/t/settings");
      await teacherUi.page.getByRole("radio", { name: "完成后可用" }).check();
      await teacherUi.page
        .getByRole("button", { name: "保存 AI 设置" })
        .click();
      await expect(teacherUi.page.getByText("更改已保存")).toBeVisible();
      await teacherUi.page.getByRole("radio", { name: "开放伴学" }).check();
      await teacherUi.page
        .getByRole("button", { name: "保存 AI 设置" })
        .click();
      await expect(teacherUi.page.getByText("更改已保存")).toBeVisible();
    } finally {
      await teacherUi.context.close();
    }

    // —— ② 学生进入作答页；未配置 AI 时打开伴学栏：零自动出站、零任务创建 ——
    const studentUi = await loginStudent(browser, student.linkToken);
    const page = studentUi.page;
    const leak = attachLeakMonitor(page);
    try {
      const assignmentTitle = `SAI全链作业${suffix}`;
      const assignmentId = await openAssignmentAttempt(page, assignmentTitle);

      const q1 = page.locator('article[aria-label="第 1 题"]');
      await q1.waitFor({ state: "visible" });

      let taskCreateCalls = 0;
      page.on("request", (req) => {
        if (
          req.method() === "POST" &&
          /\/api\/student\/ai\/tasks/.test(req.url())
        ) {
          taskCreateCalls += 1;
        }
      });

      await page
        .getByRole("article", { name: "第 1 题", exact: true })
        .getByRole("button", { name: "AI 助教", exact: true })
        .click();
      // 无连接：状态区给设置入口，不出现通道选择（发送主动作被禁用）
      await expect(page.getByText("去设置连接")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
      ).toBeDisabled();
      // 打开面板期间（含状态查询）假供应商零捕获、零任务创建
      await page.waitForTimeout(2_500);
      expect(await control.requests(), "无 AI 开栏不得自动出站").toHaveLength(
        0,
      );
      expect(taskCreateCalls, "打开面板不得创建任务").toBe(0);

      // —— ③ 学生连接 AI：首次知情 + inapp 连接（指向假供应商）——
      await page.getByRole("link", { name: "去设置连接" }).click();
      await page.waitForURL("**/s/settings/ai**");
      await page.getByRole("button", { name: "新增连接", exact: true }).click();
      await page.getByLabel("我已了解数据外发说明").check();
      await page.getByRole("radio", { name: "页内 AI" }).check();
      await page.getByLabel("接口地址").fill(FAKE_AI_BASE_URL);
      await page.getByLabel("模型名称").fill(FAKE_AI_MODEL);
      await page.getByLabel("API Key").fill(fakeAiApiKey());
      await page.getByLabel("设为默认连接").check();
      await page.getByRole("button", { name: "保存连接" }).click();
      await expect(page.getByText("连接已保存").first()).toBeVisible();

      // —— ④ 回到原题（?from= 回跳入口）再求助 ——
      await page.getByRole("link", { name: "返回原题" }).click();
      await page.waitForURL("**/s/assignments/**");
      await q1.waitFor({ state: "visible" });
      // 题卡 DOM 身份标记（整页导航后重打）：后续等待回信的轮询窗口内
      // 题卡不得重挂（expando 属性验证）
      await page.evaluate(() => {
        const el = document.querySelector('article[aria-label="第 1 题"]');
        if (el === null) throw new Error("第 1 题卡不存在");
        (el as HTMLElement & { __sai33Marker?: boolean }).__sai33Marker = true;
      });
      await expect(
        page.getByRole("region", { name: "第 1 题的 AI 助教" }),
      ).toBeVisible();
      // 从连接设置返回已恢复工作区，无需再次点题旁入口。
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
      ).toBeEnabled();
      const settingsToggle = page.getByRole("button", { name: "AI 设置" });
      if ((await settingsToggle.getAttribute("aria-expanded")) !== "true")
        await settingsToggle.click();
      await expect(page.getByText("当前：开放伴学")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "AI 设置" }).click();

      // —— ⑤ 作答中求助：脚本化回信，断言出站载荷含题面/答案解析/学生问题 ——
      // （回信文本避开 $ 公式定界符：KaTeX 渲染会拆散文本节点，文本匹配只认平文） */
      const reply1 = "页内回信：1 大于 0，是正数，判断为正确。";
      await control.script({ body: chatCompletionJson(reply1) });
      const question1 = "这道判断题怎么做？";
      await page.getByPlaceholder("补充卡住的地方（可不填）").fill(question1);
      await page.getByRole("button", { name: "发送", exact: true }).click();

      const outbound1 = await control.waitForRequest((r) =>
        r.body.includes(question1),
      );
      // 允许场景双断言（AGENTS 学生端 AI 例外）：答案/解析确实进入外发载荷
      expect(outbound1.body, "出站应含参考答案").toContain("正确");
      expect(outbound1.body, "出站应含官方解析").toContain("大于");
      expect(outbound1.body, "出站应含题干").toContain("是正数");
      // 鉴权头按连接密钥携带（不进消息体）
      const authHeader =
        outbound1.headers.authorization ?? outbound1.headers.Authorization;
      expect(authHeader).toBe(`Bearer ${fakeAiApiKey()}`);

      // 回信到达会话面板（轮询 ≤10s + worker 2s 一轮）：未读回信折叠为
      // 「查看回信」按钮，点开后正文进入对话记录（受限渲染）
      const viewReply1 = page.getByRole("button", { name: "查看回信" });
      await viewReply1.waitFor({ state: "visible", timeout: 30_000 });
      await viewReply1.click();
      await expect(
        page.getByRole("region", { name: "本题对话记录" }).getByText(reply1),
      ).toBeVisible({ timeout: 15_000 });

      // 等待回信的轮询窗口后：题卡未被重挂（expando 标记仍在同一元素上）
      const markerKept = await page.evaluate(() => {
        const el = document.querySelector('article[aria-label="第 1 题"]');
        return (
          el !== null &&
          (el as HTMLElement & { __sai33Marker?: boolean }).__sai33Marker ===
            true
        );
      });
      expect(markerKept, "轮询不得重挂题面").toBe(true);

      // —— ⑥ 追问：新一轮出站（沿用原任务），第二条脚本回信 ——
      const reply2 = "追问回信：注意题目问的是符号判断。";
      await control.script({ body: chatCompletionJson(reply2) });
      await page.getByRole("button", { name: "这一步没懂" }).click();
      await page.getByTestId("followup-input").fill("能再具体一点吗？");
      await page.getByRole("button", { name: "追问", exact: true }).click();
      const outbound2 = await control.waitForRequest((r) =>
        r.body.includes("能再具体一点吗？"),
      );
      expect(outbound2.body, "追问沿用原对话上下文").toContain(question1);
      // 新回信只作提示，学生主动查看后才刷新正文。
      await page
        .getByRole("button", { name: "查看新回复" })
        .click({ timeout: 30_000 });
      await expect(
        page.getByRole("region", { name: "本题对话记录" }).getByText(reply2),
      ).toBeVisible({ timeout: 30_000 });

      // —— ⑦ 作答 + 交卷（判断题选对；单选选 $4$ = 第 2 个选项）——
      // 交卷前经幂等接口取回进行中 attempt 的 id（结果页 URL 只含 assignmentId，
      // 教师督学页需要 attemptId；交卷后再调会开新卷，必须先取）
      const attemptId = await ensureAttemptId(
        studentUi.context.request,
        assignmentId,
      );
      // 窄屏下伴学面板是 Sheet 浮层盖住主区：Esc 收起后再作答
      await page.keyboard.press("Escape");
      await q1
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      const q2 = page.locator('article[aria-label="第 2 题"]');
      await q2.locator('[role="radiogroup"] label').nth(1).click();
      await expect(q2.getByRole("radio").nth(1)).toBeChecked();
      await page.getByRole("button", { name: "交卷", exact: true }).click();
      await page.getByRole("button", { name: "确认交卷" }).first().click();
      await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });

      // —— ⑧ 结果页复盘：完成后入口变「AI 复盘」，既有对话仍可见 ——
      await page.getByRole("button", { name: "AI 复盘" }).click();
      // 结果页首次查看回信可能折叠为「查看对话/查看回信」：宽容点开再断言
      const viewButtons = page.getByRole("button", {
        name: /查看(回信|对话)/,
      });
      for (let i = 0; i < 2 && (await viewButtons.count()) > 0; i++) {
        await viewButtons.first().click();
      }
      await expect(
        page.getByRole("region", { name: "本题对话记录" }).getByText(reply2),
      ).toBeVisible();
      await page.getByText("之前的回复", { exact: true }).click();
      await expect(
        page.getByRole("region", { name: "本题对话记录" }).getByText(reply1),
      ).toBeVisible({ timeout: 15_000 });

      // —— ⑨ 教师督学：批改详情页按题呈现 AI 求助记录 ——
      const teacherUi2 = await loginTeacherUi(browser);
      try {
        await teacherUi2.page.goto(`/t/data/attempts/${attemptId}`);
        const aiTag = teacherUi2.page.getByRole("button", {
          name: /打开第 1 题的 AI 求助记录（共 1 条）/u,
        });
        await expect(aiTag).toBeVisible({ timeout: 15_000 });
        await aiTag.click();
        await expect(
          teacherUi2.page.getByText("第 1 题 · AI 求助记录"),
        ).toBeVisible();
        // 记录呈现学生问题原文与事实状态，不含教师私注（本卷无私注）
        await expect(teacherUi2.page.getByText(question1)).toBeVisible();
      } finally {
        await teacherUi2.context.close();
      }

      // —— ⑩ 泄露监控收口：全程学生端响应无禁键/教师侧原文（AI 例外仅在出站载荷） ——
      expect(leak.violations()).toEqual([]);
    } finally {
      await studentUi.context.close();
    }
  });

  test("出站错误链：429 退避重试、坏响应待确认后重试成功、断网保输入", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const suffix = uniqueSuffix();
    const control = fakeAiControl(request);
    await control.reset();
    const world = await makeWorld(request, suffix);
    const student = await getStudentViaApi(request, world.loginName);

    // API 快轨建连接（连接 UI 已在主链覆盖；这里聚焦错误链）
    const seed = await loginStudent(browser, student.linkToken);
    const page = seed.page;
    const studentApi = seed.context.request;
    try {
      const connRes = await studentApi.post("/api/student/ai/connections", {
        data: {
          channel: "inapp",
          baseUrl: FAKE_AI_BASE_URL,
          model: FAKE_AI_MODEL,
          apiKey: fakeAiApiKey(),
          isDefault: true,
        },
      });
      expect(connRes.status()).toBe(201);

      const assignmentTitle = `SAI全链作业${suffix}`;
      const assignmentId = await openAssignmentAttempt(page, assignmentTitle);
      const attemptId = await ensureAttemptId(studentApi, assignmentId);
      const questionId = (
        (await (
          await studentApi.get(`/api/student/attempts/${attemptId}`)
        ).json()) as { data: { units: { questions: { id: string }[] }[] } }
      ).data.units.flatMap((unit) => unit.questions)[0]?.id;
      expect(typeof questionId).toBe("string");

      // —— ① 429（Retry-After 1s）→ 退避后重试成功：任务 replied 且含两次出站 ——
      await control.script({ status: 429, headers: { "retry-after": "1" } });
      const recovered = "退避后回信：第一次被限流，这次成功了。";
      await control.script({ body: chatCompletionJson(recovered) });
      const created1 = await studentApi.post("/api/student/ai/tasks", {
        data: {
          attemptId,
          questionId,
          question: "限流场景求助",
          channel: "inapp",
          materials: { annotation: false, draft: false, formalInk: false },
          mutationId: crypto.randomUUID(),
        },
      });
      expect(created1.status()).toBe(201);
      const task1 = ((await created1.json()) as { data: { id: string } }).data
        .id;

      const firstOut = await control.waitForRequest((r) =>
        r.body.includes("限流场景求助"),
      );
      const secondOut = await control.waitForRequest(
        (r) => r.seq > firstOut.seq && r.body.includes("限流场景求助"),
        20_000,
      );
      expect(secondOut.seq).toBeGreaterThan(firstOut.seq);
      // 退避重试后的任务最终收到回信
      let recovered1 = "";
      for (let i = 0; i < 40 && recovered1 !== "replied"; i++) {
        recovered1 = (
          (await (
            await studentApi.get(`/api/student/ai/tasks/${task1}`)
          ).json()) as { data: { task: { status: string } } }
        ).data.task.status;
        if (recovered1 !== "replied") {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      expect(recovered1, "429 退避后重试应成功").toBe("replied");

      // —— ② 200 但响应损坏 → failed（bad_response 是明确失败、可显式重试；
      //    uncertain 只用于超时/响应中断等可能已收费的状态不明形态），
      //    学生显式重试后成功 ——
      const uncertainReply = "重试后的回信：内容恢复正常。";
      await control.script({ body: "{not-a-json" });
      const created2 = await studentApi.post("/api/student/ai/tasks", {
        data: {
          attemptId,
          questionId,
          question: "坏响应场景求助",
          channel: "inapp",
          materials: { annotation: false, draft: false, formalInk: false },
          mutationId: crypto.randomUUID(),
        },
      });
      expect(created2.status()).toBe(201);
      const task2 = ((await created2.json()) as { data: { id: string } }).data
        .id;

      // 等任务进入 failed（worker 对坏响应的归类：明确失败）
      let sawFailed = false;
      for (let i = 0; i < 40 && !sawFailed; i++) {
        const detail = (await (
          await studentApi.get(`/api/student/ai/tasks/${task2}`)
        ).json()) as { data: { task: { status: string } } };
        sawFailed = detail.data.task.status === "failed";
        if (!sawFailed) await new Promise((r) => setTimeout(r, 500));
      }
      expect(sawFailed, "坏响应应收敛为 failed").toBe(true);

      await control.script({ body: chatCompletionJson(uncertainReply) });
      // 失败退避窗（AI_TASK_RETRY_BACKOFF_BASE_MS = 30s）：窗口内 retry 会
      // 409「失败后请稍候再重试」，等窗过后再显式重试
      await new Promise((r) => setTimeout(r, 31_000));
      const retryRes = await studentApi.post(
        `/api/student/ai/tasks/${task2}/retry`,
      );
      expect(retryRes.ok()).toBe(true);
      let recoveredStatus = "";
      for (let i = 0; i < 40 && recoveredStatus !== "replied"; i++) {
        const detail = (await (
          await studentApi.get(`/api/student/ai/tasks/${task2}`)
        ).json()) as {
          data: { task: { status: string }; messages: { role: string }[] };
        };
        recoveredStatus = detail.data.task.status;
        if (recoveredStatus !== "replied") {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      expect(recoveredStatus, "学生重试后应收到回信").toBe("replied");

      // —— ③ 断网发送：页面拦截 /ai/tasks 全部失败 → 输入保留、提示可重试 ——
      await page.route("**/api/student/ai/tasks", async (route) => {
        await route.abort("failed");
      });
      await page
        .getByRole("article", { name: "第 1 题", exact: true })
        .getByRole("button", { name: "AI 助教", exact: true })
        .click();
      const composer = page.getByPlaceholder("补充卡住的地方（可不填）");
      await composer.waitFor({ state: "visible" });
      await composer.fill("断网场景求助");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      // 前端网络失败的统一文案（api.ts fetch 包装）：请求失败提示 + 输入保留
      await expect(page.getByText(/连不上服务器/u).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(composer).toHaveValue("断网场景求助");
      await page.unrouteAll();
    } finally {
      await seed.context.close();
    }
  });

  test("link 通道：生成上下文链接，外部 AI 经公开端点只读本题快照", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const suffix = uniqueSuffix();
    const control = fakeAiControl(request);
    await control.reset();
    const world = await makeWorld(request, suffix);
    const student = await getStudentViaApi(request, world.loginName);
    const seed = await loginStudent(browser, student.linkToken);
    const page = seed.page;
    const studentApi = seed.context.request;
    try {
      // link 连接（通道参数即可；无 baseUrl/Key 字段）。isDefault 必须——
      // 状态端以默认连接定 channelDefault，无默认则面板呈现「未配置」
      const connRes = await studentApi.post("/api/student/ai/connections", {
        data: { channel: "link", isDefault: true },
      });
      expect(connRes.status()).toBe(201);

      const assignmentTitle = `SAI全链作业${suffix}`;
      await openAssignmentAttempt(page, assignmentTitle);

      await page
        .getByRole("article", { name: "第 1 题", exact: true })
        .getByRole("button", { name: "AI 助教", exact: true })
        .click();
      // 通道选择在「AI 设置」抽屉里
      await page.getByRole("button", { name: "AI 设置" }).click();
      await page.getByRole("button", { name: "上下文链接" }).click();
      await page
        .getByPlaceholder("补充卡住的地方（可不填）")
        .fill("链接通道求助");
      await page.getByRole("button", { name: "复制 AI 链接" }).click();

      // 链接以文本呈现（不依赖剪贴板；复制按钮的权限差异归真机/组件测试）
      const shareBox = page.getByRole("region", { name: "AI 链接" });
      await expect(shareBox).toBeVisible({ timeout: 15_000 });
      const ticketUrl = await shareBox.locator("input[readonly]").inputValue();
      expect(ticketUrl, "分享框应包含票据 URL").toMatch(
        /\/api\/public\/ai\/share\/.+/,
      );

      // link 任务停在 created（等待学生把链接交给外部 AI），不自动出站
      await page.waitForTimeout(2_500);
      expect(
        await control.requests(),
        "link 通道不得触发页内自动出站",
      ).toHaveLength(0);

      // 外部 AI 视角（share fetch fixture）：无会话直连公开端点
      const shareRes = await request.get(ticketUrl);
      expect(shareRes.status()).toBe(200);
      const shareBody = await shareRes.text();
      expect(shareBody, "快照含本题题面").toContain("是正数");
      // open_study 模式：答案解析随授权例外进入快照（§2.3 已授权）
      expect(shareBody, "快照含参考答案").toContain("正确");
      expect(shareBody, "快照不含他题题干").not.toContain("计算结果是");
    } finally {
      await seed.context.close();
    }
  });

  test("隔离与策略实时：他人不可见任务，教师改模式立即生效", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const suffix = uniqueSuffix();
    const control = fakeAiControl(request);
    await control.reset();
    const world = await makeWorld(request, suffix);
    const student = await getStudentViaApi(request, world.loginName);

    // 另一名学生（同教师）用于隔离断言
    await teacherApiLogin(request);
    const otherLogin = `e2e-sai33b-${suffix}`;
    await createStudentViaApi(request, `e2e隔离生${suffix}`, otherLogin);
    const other = await getStudentViaApi(request, otherLogin);

    const seed = await loginStudent(browser, student.linkToken);
    const page = seed.page;
    const studentApi = seed.context.request;
    try {
      const connRes = await studentApi.post("/api/student/ai/connections", {
        data: {
          channel: "inapp",
          baseUrl: FAKE_AI_BASE_URL,
          model: FAKE_AI_MODEL,
          apiKey: fakeAiApiKey(),
          isDefault: true,
        },
      });
      expect(connRes.status()).toBe(201);

      const assignmentTitle = `SAI全链作业${suffix}`;
      const assignmentId = await openAssignmentAttempt(page, assignmentTitle);
      const attemptId = await ensureAttemptId(studentApi, assignmentId);
      const questionId = (
        (await (
          await studentApi.get(`/api/student/attempts/${attemptId}`)
        ).json()) as { data: { units: { questions: { id: string }[] }[] } }
      ).data.units.flatMap((unit) => unit.questions)[0]?.id;
      expect(typeof questionId).toBe("string");

      const created = await studentApi.post("/api/student/ai/tasks", {
        data: {
          attemptId,
          questionId,
          question: "隔离场景求助",
          channel: "inapp",
          materials: { annotation: false, draft: false, formalInk: false },
          mutationId: crypto.randomUUID(),
        },
      });
      expect(created.status()).toBe(201);
      const taskId = ((await created.json()) as { data: { id: string } }).data
        .id;
      await control.waitForRequest((r) => r.body.includes("隔离场景求助"));

      // —— ① 换账号：他人列表为空、直取任务 id 404（同文案防枚举）——
      const otherSeed = await loginStudent(browser, other.linkToken);
      try {
        const otherApi = otherSeed.context.request;
        const list = (await (
          await otherApi.get("/api/student/ai/tasks?limit=50")
        ).json()) as { data: { tasks: { id: string }[] } };
        expect(list.data.tasks).toHaveLength(0);
        const direct = await otherApi.get(`/api/student/ai/tasks/${taskId}`);
        expect(direct.status()).toBe(404);
        const sameMsg = (await (
          await studentApi.get(`/api/student/ai/tasks/not-a-task`)
        ).json()) as { error: { message: string } };
        const otherMsg = (await direct.json()) as {
          error: { message: string };
        };
        expect(otherMsg.error.message).toBe(sameMsg.error.message);
      } finally {
        await otherSeed.context.close();
      }

      // —— ② 教师把该生覆盖为 post_submit_only：作答中 status 立即不可用 ——
      const overrideRes = await request.put(
        `/api/teacher/students/${world.studentId}/ai-policy`,
        { data: { mode: "post_submit_only" } },
      );
      expect(overrideRes.ok()).toBe(true);
      const statusRes = (await (
        await studentApi.get(
          `/api/student/ai/status?attemptId=${attemptId}&questionId=${questionId}`,
        )
      ).json()) as {
        data: { resolution: { usable: boolean; reason: string } };
      };
      expect(statusRes.data.resolution.usable).toBe(false);
      // reason 取最具体来源（学生 > 作业 > 继承）：学生明确关闭 = student_closed
      expect(statusRes.data.resolution.reason).toBe("student_closed");
      // 页面侧刷新后呈现不可用文案（教师刚改设置立即生效）
      await page.reload();
      await page
        .getByRole("article", { name: "第 1 题", exact: true })
        .getByRole("button", { name: "AI 助教", exact: true })
        .click();
      await expect(
        page.getByText(/完成后可用|本题暂不能/u).first(),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await seed.context.close();
    }
  });
});
