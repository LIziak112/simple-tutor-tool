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
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  createStudentViaApi,
  getStudentViaApi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * SAI-33 性能采样 spec（B18 第 6 条客户端维度）：同一合成场景「无 AI」与
 * 「有 AI（任务在途）」两相各采样——
 * - 布局开合：AI 助教面板打开/收起耗时（iPad 竖屏 Sheet 布局）；
 * - 轮询重复渲染：面板开启 12s 窗口内 /ai/status 轮询次数 + 第 1 题卡
 *   DOM 变更记录数（MutationObserver）+ 题卡节点身份（expando，重挂即失败）；
 * - 作答保存延迟：页面侧 fetch PUT answers ×10（含网络与服务端全程）。
 *
 * 只断言稳定语义（题卡不重挂、无 AI 零自动出站、保存 10/10 成功、有 AI
 * 相回信到达）；耗时/次数/变更数全部 console.log 采样记录，不做时间阈值
 * 断言（计时波动如实进验收记录，机器与数据规模见输出）。服务端三维
 * （保存事务延迟/长稿编码/积压排空）由 apps/server/scripts/student-ai-bench.ts
 * 覆盖。真实 Pencil 手写不在本 spec 范围（B19 真机）。
 */

/** 两相各 12s 观察窗 + 派发/回信余量 */
const PERF_TIMEOUT = 180_000;
const WINDOW_MS = 12_000;
const SAVE_ROUNDS = 10;

/** 服务端三维基准同款 p50/p95/max 摘要 */
function statsOf(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return `p50=${at(0.5).toFixed(0)}ms p95=${at(0.95).toFixed(0)}ms max=${(sorted[sorted.length - 1] ?? 0).toFixed(0)}ms n=${samples.length}`;
}

/** 教师域造「两题作业 + 一名学生」世界（口径同 student-ai.spec.ts） */
async function makeWorld(
  request: import("@playwright/test").APIRequestContext,
  suffix: string,
): Promise<{ assignmentTitle: string; loginName: string }> {
  await teacherApiLogin(request);
  const courseId = await createCourseViaApi(request, `e2e-sai性能课${suffix}`);
  const unitName = `sai性能单元${suffix}`;
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

  const loginName = `e2e-saiperf-${suffix}`;
  await createStudentViaApi(request, `e2e性能生${suffix}`, loginName);
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  const assignmentTitle = `SAI性能作业${suffix}`;
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
  return { assignmentTitle, loginName };
}

test.describe("SAI-33 性能采样（布局开合 / 轮询重复渲染 / 保存延迟）", () => {
  // 两浏览器独立世界与供应商会话；同题内容谓词继续验证出站对应关系。
  test.describe.configure({ mode: "serial" });

  test("同一合成场景：无 AI 相与任务在途相的布局/轮询/保存采样", async ({
    browser,
    request,
  }) => {
    test.setTimeout(PERF_TIMEOUT);
    const suffix = uniqueSuffix();
    const control = fakeAiControl(request);
    await control.reset();
    const world = await makeWorld(request, suffix);
    const student = await getStudentViaApi(request, world.loginName);

    // 学生专属链接登录 → 进入作答页（首页待办 → 开始练习）
    const context = await browser.newContext(devices["iPad (gen 7)"]);
    const page = await context.newPage();
    const studentApi = context.request;
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    try {
      // —— 进入作答页（首页待办 → 开始练习）——
      const card = page.locator("li", { hasText: world.assignmentTitle });
      await expect(card).toHaveCount(1);
      await card.getByRole("link", { name: "开始练习" }).click();
      await page.waitForURL("**/s/assignments/**");
      const assignmentId = page.url().split("/").pop() ?? "";
      const q1 = page.locator('article[aria-label="第 1 题"]');
      await q1.waitFor({ state: "visible" });

      const attemptRes = await studentApi.post(
        `/api/student/assignments/${assignmentId}/attempt`,
      );
      const attemptId = ((await attemptRes.json()) as { data: { id: string } })
        .data.id;
      const questionId =
        (
          (await (
            await studentApi.get(`/api/student/attempts/${attemptId}`)
          ).json()) as { data: { units: { questions: { id: string }[] }[] } }
        ).data.units.flatMap((unit) => unit.questions)[0]?.id ?? "";
      expect(questionId, "应取到第 1 题 id").not.toBe("");

      // 题卡身份标记 + DOM 变更计数（轮询渲染观测）
      await page.evaluate(() => {
        const el = document.querySelector('article[aria-label="第 1 题"]');
        if (el === null) throw new Error("第 1 题卡不存在");
        (el as HTMLElement & { __perfMarker?: boolean }).__perfMarker = true;
        let mutations = 0;
        const observer = new MutationObserver((records) => {
          mutations += records.length;
        });
        observer.observe(el, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        (
          window as unknown as { __perfMutations: () => number }
        ).__perfMutations = () => {
          observer.disconnect();
          return mutations;
        };
      });

      const countStatusPolls = (): Promise<number> =>
        page.evaluate(() => {
          const counter = (window as unknown as { __perfPolls?: number })
            .__perfPolls;
          return counter ?? 0;
        });
      await page.evaluate(() => {
        const w = window as unknown as {
          __perfPolls: number;
          fetch: typeof fetch;
        };
        w.__perfPolls = 0;
        const origFetch = window.fetch.bind(window);
        w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes("/api/student/ai/status")) {
            w.__perfPolls += 1;
          }
          return origFetch(input, init);
        }) as typeof fetch;
      });

      // ============ 相 A：无 AI（未配置连接） ============
      let t0 = Date.now();
      await page.getByRole("button", { name: "AI 助教" }).click();
      await expect(page.getByText("去设置连接")).toBeVisible();
      const openMsA = Date.now() - t0;
      t0 = Date.now();
      await page.keyboard.press("Escape");
      await expect(page.getByText("去设置连接")).toBeHidden();
      const closeMsA = Date.now() - t0;
      // 重开面板保持 12s 观察窗（轮询/渲染/保存都在面板开启态采样）
      await page.getByRole("button", { name: "AI 助教" }).click();
      await expect(page.getByText("去设置连接")).toBeVisible();
      const savesA = await page.evaluate(
        async ({ attemptId, questionId, rounds }) => {
          const samples: number[] = [];
          for (let i = 0; i < rounds; i++) {
            const start = performance.now();
            const res = await fetch(
              `/api/student/attempts/${attemptId}/answers/${questionId}`,
              {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  answer: { kind: "judge", value: i % 2 === 0 },
                }),
              },
            );
            const ms = performance.now() - start;
            if (!res.ok) throw new Error(`保存失败 HTTP ${res.status}`);
            samples.push(ms);
          }
          return samples;
        },
        { attemptId, questionId, rounds: SAVE_ROUNDS },
      );
      await page.waitForTimeout(WINDOW_MS);
      const pollsA = await countStatusPolls();
      const markerA = await page.evaluate(() => {
        const el = document.querySelector('article[aria-label="第 1 题"]');
        const kept =
          el !== null &&
          (el as HTMLElement & { __perfMarker?: boolean }).__perfMarker ===
            true;
        const mutations = (
          window as unknown as { __perfMutations: () => number }
        ).__perfMutations();
        return { kept, mutations };
      });
      expect(markerA.kept, "无 AI 相轮询不得重挂题面").toBe(true);
      const myRequests = (await control.requests()).filter((entry) =>
        entry.body.includes(suffix),
      );
      expect(myRequests, "无 AI 开栏不得自动出站").toHaveLength(0);
      console.log(
        `[perf|${test.info().project.name}] 相A 无AI：开栏=${openMsA}ms 收起=${closeMsA}ms status轮询=${pollsA}次 题卡DOM变更=${markerA.mutations}次 保存=${statsOf(savesA)}`,
      );

      // ============ 相 B：有 AI（inapp 连接 + 延迟回信任务在途） ============
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
      // 面板还停留在相 A 的「无连接」态（连接在页面背后经 API 建立）——
      // 收起重开让面板重取 status，发送主动作解禁
      await page.keyboard.press("Escape");
      await expect(page.getByText("去设置连接")).toBeHidden();
      await page.getByRole("button", { name: "AI 助教" }).click();
      const sendButton = page.getByRole("button", {
        name: "发送",
        exact: true,
      });
      await expect(sendButton).toBeEnabled({ timeout: 15_000 });
      // 9s 延迟回信：任务在途窗口覆盖 12s 观察窗（worker 2s 一轮 + 9s 出站）
      await control.script({
        body: chatCompletionJson(`性能采样回信${suffix}`),
        delayMs: 9000,
      });
      const question = `性能采样求助-${suffix}`;
      await page.getByPlaceholder("写下你想问的问题").fill(question);
      await page.getByRole("button", { name: "发送", exact: true }).click();
      // 面板开合以「已发问题文本」可见性为准（在途任务不保证占位符形态）
      const sentText = page.getByText(question).first();
      await expect(sentText).toBeVisible({ timeout: 15_000 });
      // 出站被 9s 门闩挂起期间采样开合
      await page.waitForTimeout(2_500);
      t0 = Date.now();
      await page.keyboard.press("Escape");
      await expect(sentText).toBeHidden();
      const closeMsB0 = Date.now() - t0;
      t0 = Date.now();
      await page.getByRole("button", { name: "AI 助教" }).click();
      await expect(sentText).toBeVisible();
      const openMsB = Date.now() - t0;
      t0 = Date.now();
      await page.keyboard.press("Escape");
      await expect(sentText).toBeHidden();
      const closeMsB = Date.now() - t0;
      await page.getByRole("button", { name: "AI 助教" }).click();
      await expect(sentText).toBeVisible();

      const savesB = await page.evaluate(
        async ({ attemptId, questionId, rounds }) => {
          const samples: number[] = [];
          for (let i = 0; i < rounds; i++) {
            const start = performance.now();
            const res = await fetch(
              `/api/student/attempts/${attemptId}/answers/${questionId}`,
              {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  answer: { kind: "judge", value: i % 2 === 0 },
                }),
              },
            );
            const ms = performance.now() - start;
            if (!res.ok) throw new Error(`保存失败 HTTP ${res.status}`);
            samples.push(ms);
          }
          return samples;
        },
        { attemptId, questionId, rounds: SAVE_ROUNDS },
      );
      const pollsAtStart = await countStatusPolls();
      await page.waitForTimeout(WINDOW_MS);
      const pollsB = (await countStatusPolls()) - pollsAtStart;
      const markerB = await page.evaluate(() => {
        const el = document.querySelector('article[aria-label="第 1 题"]');
        const kept =
          el !== null &&
          (el as HTMLElement & { __perfMarker?: boolean }).__perfMarker ===
            true;
        const mutations = (
          window as unknown as { __perfMutations: () => number }
        ).__perfMutations();
        return { kept, mutations };
      });
      expect(markerB.kept, "有 AI 相轮询不得重挂题面").toBe(true);
      console.log(
        `[perf|${test.info().project.name}] 相B 有AI在途：开栏=${openMsB}ms 收起=${closeMsB}ms（发送后首收=${closeMsB0}ms）status轮询=${pollsB}次 题卡DOM变更=${markerB.mutations}次 保存=${statsOf(savesB)}`,
      );

      // —— 功能收口：延迟回信到达会话（数字有效的前提是链路真跑通）——
      // 未读回信折叠为「查看回信/查看对话」按钮（主 spec 同款），宽容点开；
      // 两浏览器 worker 共享假供应商 FIFO 剧本，回信文本可能被对方 run 消费，
      // 断言只认「性能采样回信」前缀
      const replyText = page.getByText(/性能采样回信/).first();
      const viewButtons = page.getByRole("button", {
        name: /查看(回信|对话)/,
      });
      for (let i = 0; i < 3 && !(await replyText.isVisible()); i++) {
        if ((await viewButtons.count()) === 0) {
          await page.waitForTimeout(2_000);
          continue;
        }
        await viewButtons.first().click();
      }
      await expect(replyText).toBeVisible({ timeout: 30_000 });
    } finally {
      await context.close();
    }
  });
});
