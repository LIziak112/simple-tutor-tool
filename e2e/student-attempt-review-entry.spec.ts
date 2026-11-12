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
 * 顶栏「整卷复盘 · 等待领取」→ 另行批量复盘两道错题 → 外部客户端经 MCP
 * 领取并写回报告 → 顶栏「查看整卷复盘报告」（未读）→ 全屏阅读器打开才记已读
 * → 关闭回到结果页 → 从首页「求助记录」分清整卷复盘与批量复盘错题，并打开
 * 同一份报告。
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

      // —— ① 首次发起：顶栏主按钮带文字「整卷复盘」，窄屏独占一行 ——
      const entry = page.locator("[data-attempt-review-entry]");
      await expect(entry).toHaveAttribute(
        "data-attempt-review-entry",
        "launch",
        { timeout: 15_000 },
      );
      await expect(entry).toHaveText("整卷复盘");
      const entryBox = await entry.boundingBox();
      expect(entryBox?.width ?? 0).toBeGreaterThan(300);
      expect(entryBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      await shot("1-顶栏-首次发起");

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

      // —— ② 等待领取：关面板后顶栏写明状态 ——
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(page).not.toHaveURL(/aiReview=/u);
      await expect(entry).toHaveText("整卷复盘 · 等待领取");
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
      await expect(entry).toHaveText("整卷复盘 · 处理中", { timeout: 20_000 });
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

      // —— ③ 报告已出：顶栏变「查看整卷复盘报告」并标未读；看状态不记已读 ——
      await expect(entry).toHaveAttribute(
        "data-attempt-review-entry",
        "report",
        { timeout: 20_000 },
      );
      await expect(entry).toContainText("查看整卷复盘报告");
      await expect(entry).toContainText("新");
      expect((await reviewTasksOf(attemptId))[0]?.openedAt).toBeNull();
      await shot("4-顶栏-报告已出未读");

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

      // 点报告里的题号：关闭报告并回到结果页的那道题
      await reader.getByRole("button", { name: "第 2 题" }).first().click();
      await expect(reader).toBeHidden();
      await expect(page).not.toHaveURL(/aiReview=/u);
      expect(new URL(page.url()).pathname).toBe(`/s/attempts/${attemptId}`);

      // —— ④ 已读后再回来：入口常驻，不再标未读 ——
      await page.reload();
      await expect(entry).toHaveAttribute(
        "data-attempt-review-entry",
        "report",
        { timeout: 15_000 },
      );
      await expect(entry).toHaveText("查看整卷复盘报告");
      await shot("6-顶栏-已读后再回来");

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
      await reader.getByRole("button", { name: "关闭，回到作答结果" }).click();
      await expect(reader).toBeHidden();
      expect(new URL(page.url()).pathname).toBe(`/s/attempts/${attemptId}`);
      await expect(page).not.toHaveURL(/aiReview=/u);
      await expect(page.getByText("批改结果")).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
