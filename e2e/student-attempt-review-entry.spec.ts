import { expect, test } from "@playwright/test";
import {
  createCourseViaApi,
  importUnitToCourse,
  prepareCourseStudent,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 整卷复盘入口 / 报告阅读 / 求助记录分组（手机窄屏 390×844）全链路：
 * 交卷 → 结果页顶栏「整卷复盘」→ 确认（只建 1 条整卷任务、0 条逐题任务）→
 * 下方卡片显示「等待领取」→ 另行批量复盘两道错题 → 外部客户端经 MCP
 * 领取并写回报告 → 下方卡片提示报告未读→ 全屏阅读器打开才记已读
 * → 系统返回 / 后退先关报告、留在结果页原位置 → 读过后顶栏入口仍在首行
 * → 从首页「求助记录」分清整卷复盘与批量复盘错题，并打开同一份报告（跨页
 * 落地：关闭留在结果页，后退回来源页）。
 */

/** 与 playwright.config.ts 保持一致（server 直连；vite 代理不转发 /mcp） */
const STUDENT_MCP_URL = "http://127.0.0.1:8899/mcp/student";

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

/** 三道判断题（标准答案均为「对」）：答 错 / 错 / 对 → 判错 2、判对 1 */
function threeJudgeMarkdown(unitName: string): string {
  const question = (stem: string) => [
    '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
    `${stem}[[正确]]`,
    "",
    ":::solution",
    "按定义判断即可。",
    ":::",
    "::::",
    "",
  ];
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 正数与负数",
    "---",
    "",
    ...question("$1$ 是正数。"),
    ...question("$2$ 是正数。"),
    ...question("$3$ 是正数。"),
  ].join("\n");
}

/** tools/call 并解析 text content 里的 JSON（学生 MCP 工具统一 JSON 文本返回） */
async function callStudentTool(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request.post(STUDENT_MCP_URL, {
    data: {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    },
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
  });
  const body = (await res.json()) as {
    result?: { content: { type: string; text?: string }[]; isError?: boolean };
    error?: unknown;
  };
  const text = (body.result?.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (
    res.status() !== 200 ||
    body.error !== undefined ||
    body.result?.isError
  ) {
    throw new Error(`tools/call ${name} 失败：HTTP ${res.status()} ${text}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

type ReviewTask = { id: string; status: string; openedAt: string | null };

test.describe("整卷复盘入口与求助记录分组（手机窄屏）", {
  tag: ["@ai"],
}, () => {
  test("发起 → 等待 → 报告已出 → 已读后再回来；求助记录分清整卷与批量并打开同一份报告", async ({
    browser,
    request,
  }, testInfo) => {
    test.setTimeout(240_000);
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e整卷复盘课${suffix}`;
    const unitName = `整卷复盘小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    await importUnitToCourse(
      request,
      courseId,
      unitName,
      threeJudgeMarkdown(unitName),
    );
    const student = await prepareCourseStudent(
      request,
      courseId,
      `e2e-review-entry-${suffix}`,
      `e2e整卷复盘生${suffix}`,
    );

    const context = await browser.newContext(PHONE);
    const page = await context.newPage();
    const api = context.request;
    const reviewTasksOf = async (attemptId: string): Promise<ReviewTask[]> =>
      (
        (await (
          await api.get(
            `/api/student/ai/attempt-reviews?attemptId=${attemptId}`,
          )
        ).json()) as { data: { tasks: ReviewTask[] } }
      ).data.tasks;
    const shot = (name: string) =>
      page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
    // 全程记下「记已读」请求：无论后退 / 前进 / 重开多少次，都只应有 1 次
    let openActionCount = 0;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        /\/api\/student\/ai\/attempt-reviews\/[^/]+\/actions$/u.test(
          new URL(req.url()).pathname,
        ) &&
        req.postDataJSON()?.action === "open"
      )
        openActionCount += 1;
    });
    const scrollYNow = () => page.evaluate(() => Math.round(window.scrollY));
    /** 顶栏实际高度，与工作区写入的 --attempt-header-height（题目定位偏移用） */
    const headerHeights = () =>
      page.evaluate(() => {
        const header = document.querySelector<HTMLElement>(
          '[data-slot="attempt-header"]',
        );
        const workspace = document.querySelector<HTMLElement>(
          '[data-slot="attempt-workspace"]',
        );
        return {
          actual: Math.round(header?.getBoundingClientRect().height ?? -1),
          variable: Math.round(
            Number.parseFloat(
              workspace?.style.getPropertyValue("--attempt-header-height") ??
                "",
            ),
          ),
        };
      });
    try {
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
      // MCP 连接（同时满足首次知情门）；明文 token 只在创建响应出现一次
      const connRes = await api.post("/api/student/ai/connections", {
        data: { channel: "mcp" },
      });
      expect(connRes.ok()).toBe(true);
      const token =
        (
          (await connRes.json()) as {
            data: { credential: { token: string } | null };
          }
        ).data.credential?.token ?? "";
      expect(token.length).toBeGreaterThan(0);

      // —— 作答并交卷：错 / 错 / 对 ——
      await page.goto(
        `/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`,
      );
      await page.getByRole("button", { name: "开始练习" }).click();
      await page.waitForURL("**/s/attempts/**");
      const attemptId = new URL(page.url()).pathname.split("/").pop() ?? "";
      const questionIds = (
        (await (
          await api.get(`/api/student/attempts/${attemptId}`)
        ).json()) as {
          data: { units: { questions: { id: string }[] }[] };
        }
      ).data.units.flatMap((unit) => unit.questions.map((q) => q.id));
      expect(questionIds).toHaveLength(3);
      for (const [index, option] of ["错", "错", "对"].entries()) {
        await page
          .locator(`article[aria-label="第 ${index + 1} 题"]`)
          .getByRole("radio", { name: option, exact: true })
          .locator("xpath=ancestor::label[1]")
          .click();
      }
      await expect
        .poll(async () => page.getByTestId("draft-status").textContent())
        .not.toMatch(/正在保存|正在同步|正在恢复|等待同步/u);
      await page.getByRole("button", { name: "交卷", exact: true }).click();
      await page.getByRole("button", { name: "确认交卷" }).first().click();
      await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });

      // —— ① 首次发起：顶栏首行固定显示「整卷复盘」 ——
      const entry = page.locator("[data-attempt-review-entry]");
      await expect(entry).toHaveAttribute(
        "data-attempt-review-entry",
        "launch",
        { timeout: 15_000 },
      );
      await expect(entry).toHaveText("整卷复盘");
      const header = page.locator('[data-slot="attempt-header"]');
      const more = header.getByRole("button", { name: "更多操作" });
      const hint = page.getByTestId("attempt-review-hint");
      const assertFirstRow = async () => {
        const entryBox = await entry.boundingBox();
        const backBox = await header
          .getByRole("button", { name: /^返回/u })
          .boundingBox();
        if (entryBox === null || backBox === null)
          throw new Error("顶栏入口不可见");
        expect(Math.abs(entryBox.y - backBox.y)).toBeLessThan(2);
        expect(entryBox.height).toBeGreaterThanOrEqual(44);
        await expect(entry).toHaveText("整卷复盘");
      };
      await assertFirstRow();
      const firstHeaderHeight = (await headerHeights()).actual;
      await more.press("ArrowDown");
      await expect(
        page.getByRole("menuitem", { name: "批量复盘" }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(more).toBeFocused();
      for (const [name, dialogName] of [
        ["批量复盘", /批量|复盘队列/u],
        ["求助记录", "求助记录"],
        ["随手记", "随手记"],
      ] as const) {
        await more.click();
        await page.getByRole("menuitem", { name }).click();
        const secondaryDialog = page.getByRole("dialog", { name: dialogName });
        await expect(secondaryDialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(secondaryDialog).toBeHidden();
        await expect(more).toBeFocused();
      }
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: PHONE.viewport.height });
        await assertFirstRow();
        expect(
          await header.evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);
      }
      await page.setViewportSize(PHONE.viewport);
      await shot("1-顶栏-首次发起");

      const modules = page.getByRole("region", { name: "按模块看结果" });
      const moduleToggle = modules.locator("summary");
      const cards = modules.getByTestId("module-results-cards");
      await expect(cards).toBeVisible();
      await moduleToggle.press("Space");
      await expect(cards).toBeHidden();
      await expect(moduleToggle).toBeFocused();
      await moduleToggle.press("Enter");
      await expect(cards).toBeVisible();

      await page.setViewportSize({ width: 915, height: PHONE.viewport.height });
      const moduleTable = modules.getByRole("table");
      await expect(moduleTable).toBeVisible();
      await moduleToggle.click();
      await expect(moduleTable).toBeHidden();
      await moduleToggle.click();
      await expect(moduleTable).toBeVisible();
      await page.setViewportSize(PHONE.viewport);

      await entry.click();
      await expect(page).toHaveURL(/aiReview=panel/u);
      const panel = page.getByRole("dialog", { name: "整卷复盘" });
      await panel
        .getByRole("button", { name: "确认发起整卷复盘（3 题）" })
        .click();
      await expect(
        panel.getByRole("list", { name: "整卷复盘任务" }),
      ).toContainText("等待领取");
      await shot("2-面板-已发起");
      // 约束：确认整卷复盘只创建 1 条整卷任务、0 条逐题任务
      const created = await reviewTasksOf(attemptId);
      expect(created).toHaveLength(1);
      const taskId = created[0]?.id ?? "";
      const perQuestion = (await (
        await api.get("/api/student/ai/tasks?group=active")
      ).json()) as { data: { tasks: unknown[] } };
      expect(perQuestion.data.tasks).toHaveLength(0);

      // —— ② 等待领取：关面板后下方卡片写明状态 ——
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(page).not.toHaveURL(/aiReview=/u);
      await expect(hint).toContainText("等待领取（覆盖 3 题）");
      await expect(entry).toHaveText("整卷复盘");
      await shot("3-顶栏-等待领取");

      // —— 另行批量复盘两道错题（学生单独确认的另一件事）——
      const batchRes = await api.post("/api/student/ai/batch-review", {
        data: {
          items: questionIds
            .slice(0, 2)
            .map((questionId) => ({ attemptId, questionId })),
          channel: "mcp",
          question: "请帮我复盘这些错题",
          mutationId: crypto.randomUUID(),
        },
      });
      expect(batchRes.ok()).toBe(true);
      expect(await reviewTasksOf(attemptId)).toHaveLength(1);

      // —— 外部客户端经 MCP 领取并写回报告 ——
      const claim = await callStudentTool(
        request,
        token,
        1,
        "claim_attempt_review",
        { taskId },
      );
      expect(claim.claimed).toBe(true);
      await expect(hint).toContainText("处理中（覆盖 3 题）", {
        timeout: 20_000,
      });
      await hint.getByRole("button", { name: "查看进度" }).click();
      const progress = page.getByRole("dialog", {
        name: "整卷复盘",
        exact: true,
      });
      await expect(progress.getByText("处理中", { exact: true })).toBeVisible();
      const submitted = await callStudentTool(
        request,
        token,
        2,
        "submit_attempt_review_result",
        {
          taskId,
          leaseToken: (claim.lease as { leaseToken: string }).leaseToken,
          generation: claim.generation,
          snapshotVersion: claim.snapshotVersion,
          report: {
            schemaVersion: 1,
            overview: "三题里错了两题，都错在正数的判断上。",
            knowledgeFindings: [
              {
                statement: "正数的定义没有记牢",
                evidenceQuestionNos: [1, 2],
                basis: "platform_fact",
                confidence: "high",
              },
            ],
            errorPatterns: [
              {
                statement: "看到数字就凭感觉判断",
                evidenceQuestionNos: [2],
                basis: "ai_hypothesis",
                confidence: "medium",
              },
            ],
            performanceNotes: [],
            trainingPlan: [
              {
                knowledgePoint: "有理数的概念",
                relatedQuestionNos: [1, 2],
                action: "把正数、负数、零的定义各写一遍再重做这两题",
                priority: "high",
                caveat: "只有三道题，结论供参考",
              },
            ],
            limitations: ["样本只有三道判断题"],
          },
        },
      );
      expect(submitted.submitted).toBe(true);
      await expect(
        progress.getByRole("button", { name: "查看整卷复盘报告" }),
      ).toBeVisible({ timeout: 20_000 });
      expect((await reviewTasksOf(attemptId))[0]?.openedAt).toBeNull();
      await page.goBack();
      await expect(progress).toBeHidden();

      // —— ③ 报告已出：顶栏变「查看整卷复盘报告」并标未读；看状态不记已读 ——
      await expect(entry).toHaveAttribute(
        "data-attempt-review-entry",
        "report",
        { timeout: 20_000 },
      );
      await assertFirstRow();
      await expect(hint).toContainText("整卷复盘报告已生成，还没看过");
      expect((await reviewTasksOf(attemptId))[0]?.openedAt).toBeNull();
      await expect
        .poll(async () => {
          const heights = await headerHeights();
          return heights.variable - heights.actual;
        })
        .toBe(0);
      expect((await headerHeights()).actual).toBe(firstHeaderHeight);
      await shot("4-顶栏-报告已出未读");

      // 往下滚一段再打开（顶栏吸顶，入口一直够得着）：关闭后要回到这个位置
      await page.evaluate(() => window.scrollTo(0, 240));
      const scrollBeforeOpen = await scrollYNow();
      expect(scrollBeforeOpen).toBeGreaterThan(0);

      // 打开：手机上全屏阅读；正文成功打开后才记已读
      await entry.click();
      await expect(page).toHaveURL(new RegExp(`aiReview=${taskId}`, "u"));
      const reader = page.getByRole("dialog", { name: "整卷复盘报告" });
      await expect(reader).toContainText("三题里错了两题");
      await expect(reader).toContainText(unitName);
      await expect(reader).toContainText("第 1 次");
      // 手机上占满整屏（等打开动画结束再量）
      await expect
        .poll(async () => {
          const box = await reader.boundingBox();
          return box === null
            ? null
            : [box.x, box.y, box.width, box.height].map(Math.round);
        })
        .toEqual([0, 0, 390, 844]);
      await expect
        .poll(async () => (await reviewTasksOf(attemptId))[0]?.openedAt ?? null)
        .not.toBeNull();
      await shot("5-阅读器-手机全屏");

      // 手机系统返回手势 / 浏览器后退：先关报告，留在结果页原滚动位置
      await page.goBack();
      await expect(reader).toBeHidden();
      await expect(page).not.toHaveURL(/aiReview=/u);
      expect(new URL(page.url()).pathname).toBe(`/s/attempts/${attemptId}`);
      await expect.poll(scrollYNow).toBe(scrollBeforeOpen);
      // 前进：重新打开的还是这份报告，不再记一次已读
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`aiReview=${taskId}`, "u"));
      await expect(reader).toContainText("三题里错了两题");

      // 点报告里的题号：关闭报告并回到结果页的那道题
      await reader.getByRole("button", { name: "第 2 题" }).first().click();
      await expect(reader).toBeHidden();
      await expect(page).not.toHaveURL(/aiReview=/u);
      expect(new URL(page.url()).pathname).toBe(`/s/attempts/${attemptId}`);
      await expect
        .poll(() => new URL(page.url()).searchParams.get("reviewQuestion"))
        .toBe(questionIds[1]);
      await expect(
        page.locator(`[data-review-question="${questionIds[1]}"]`),
      ).toBeInViewport();

      // —— ④ 已读与刷新后：入口位置和顶栏高度稳定，仍可打开报告 ——
      await expect(hint).toContainText("整卷复盘报告已看过");
      await assertFirstRow();
      expect((await headerHeights()).actual).toBe(firstHeaderHeight);
      await shot("6-顶栏-报告已读");
      await page.reload();
      await assertFirstRow();
      await entry.click();
      await expect(reader).toContainText("三题里错了两题");
      await page.keyboard.press("Escape");
      await expect(reader).toBeHidden();
      await expect(page).not.toHaveURL(/aiReview=/u);
      // 开过、关过这么多次，历史里没有留下多余的记录：后退一步就离开这次
      // 作答的结果页（不会又弹出报告，也不用多按一次），前进再回来仍是关着的
      await page.goBack();
      await expect(page).not.toHaveURL(
        new RegExp(`/s/attempts/${attemptId}`, "u"),
      );
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`/s/attempts/${attemptId}`, "u"));
      await expect(page).not.toHaveURL(/aiReview=/u);
      await assertFirstRow();
      await expect(reader).toBeHidden();

      // —— 求助记录（从首页进）：分清整卷复盘 / 批量复盘错题，同批两题一张卡 ——
      await page.goto("/s/home");
      await page.getByRole("button", { name: /^助教队列/u }).click();
      const drawer = page.getByRole("dialog", { name: "求助记录" });
      const reviewList = drawer.getByRole("list", { name: "整卷复盘任务列表" });
      await expect(reviewList.getByRole("listitem")).toHaveCount(1);
      await expect(reviewList).toContainText("整卷复盘");
      await expect(reviewList).toContainText("报告已出");
      await expect(reviewList).toContainText(unitName);
      await expect(reviewList).toContainText("第 1 次");
      await expect(reviewList).toContainText("覆盖 3 题");
      const batchCard = drawer.getByTestId("ai-queue-batch");
      await expect(batchCard).toHaveCount(1);
      await expect(batchCard).toContainText("批量复盘错题");
      await expect(batchCard).toContainText("2 题");
      await expect(batchCard).toContainText("待领取 2");
      await expect(batchCard).toContainText(unitName);
      await expect(
        batchCard.getByRole("button", { name: /^第 [12] 题：待领取/u }),
      ).toHaveCount(2);
      await shot("7-求助记录-分组");

      // 从求助记录打开：到那次作答的结果页，打开的是同一份报告
      await reviewList
        .getByRole("button", { name: "查看整卷复盘报告" })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/s/attempts/${attemptId}\\?aiReview=${taskId}`, "u"),
      );
      await expect(reader).toContainText("三题里错了两题");
      // 带参数跨页落地：关闭只去掉参数、留在结果页；后退按浏览器原样回来源页
      await reader.getByRole("button", { name: "关闭，回到作答结果" }).click();
      await expect(reader).toBeHidden();
      expect(new URL(page.url()).pathname).toBe(`/s/attempts/${attemptId}`);
      await expect(page).not.toHaveURL(/aiReview=/u);
      await expect(page.getByText("批改结果")).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/s\/home$/u);
      // 全程只记过 1 次已读
      expect(openActionCount).toBe(1);
    } finally {
      await context.close();
    }
  });
});
