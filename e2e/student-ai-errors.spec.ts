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
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * SAI-33 错误链两浏览器（B18 任务 3）：断网（主 spec）/换账号（主 spec）
 * 之外的全部错误形态——提交失败、禁用、缺图（材料上传失败）、复制失败、
 * 超时（uncertain）、批量部分成功、作废卷。故障注入两级：控制服务编程
 * （剧本化 429/500/慢响应，见 fake-ai-provider.ts）+ route abort/fulfill
 * （页面侧拦截学生端接口）。假供应商与出站分流架构同主 spec。
 *
 * 验收对照（B18 SAI-33）：
 * - 提交失败：任务创建 500 → 失败告警如实呈现、输入保留；
 * - 禁用：教师改 post_submit_only 后点击发送 → 给出原因、零出站零建任务；
 * - 缺图：材料 PNG 上传失败 → 「任务已创建，但材料上传失败（不会重复
 *   计费）」，重试同幂等键补传成功；
 * - 复制失败：剪贴板拒绝 → 降级手动复制（分享框仍在、链接可达）；
 * - 超时：出站 60s 超时 → uncertain「发送结果待确认」（绝不自动重发）；
 * - 批量部分成功：同学生多任务并发派发，失败任务不拖住成功任务；
 * - 作废卷：讲练重新开始后旧任务详情收敛为仅可取消、打开回信 409
 *   ATTEMPT_ABANDONED（正文不交付），新卷 AI 可用。
 */

/** 学生任务状态轮询（500ms 间隔；收敛或超时由调用方断言） */
async function pollTaskStatus(
  studentApi: import("@playwright/test").APIRequestContext,
  taskId: string,
  want: string,
  timeoutMs: number,
): Promise<string> {
  let status = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && status !== want) {
    status = (
      (await (
        await studentApi.get(`/api/student/ai/tasks/${taskId}`)
      ).json()) as { data: { task: { status: string } } }
    ).data.task.status;
    if (status !== want) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return status;
}

/** 轮询到任一终态（replied/failed/uncertain；超时返回当下状态） */
async function pollTaskTerminal(
  studentApi: import("@playwright/test").APIRequestContext,
  taskId: string,
  timeoutMs: number,
): Promise<string> {
  const terminal = new Set(["replied", "failed", "uncertain"]);
  let status = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !terminal.has(status)) {
    status = (
      (await (
        await studentApi.get(`/api/student/ai/tasks/${taskId}`)
      ).json()) as { data: { task: { status: string } } }
    ).data.task.status;
    if (!terminal.has(status)) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return status;
}

test.describe("SAI-33 错误链（页内与出站）", { tag: ["@ai"] }, () => {
  // 组内顺序运行；供应商状态按用例凭据隔离，跨文件可并行。
  test.describe.configure({ mode: "serial" });

  test("页内错误：提交失败保输入、禁用给原因、缺图补传、复制降级", async ({
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
      `e2e-sai错链课${suffix}`,
    );
    const unitName = `sai错链单元${suffix}`;
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: choiceJudgePracticeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    expect(importRes.ok()).toBe(true);
    const loginName = `e2e-saierr-${suffix}`;
    await createStudentViaApi(request, "e2e错链生", loginName);
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);
    const assignmentRes = await request.post("/api/teacher/assignments", {
      data: {
        unitIds: [
          ((await importRes.json()) as { data: { units: { id: string }[] } })
            .data.units[0]?.id ?? "",
        ],
        studentIds: [student.id],
        title: `SAI错链作业${suffix}`,
        courseId,
      },
    });
    expect(assignmentRes.ok()).toBe(true);

    const seed = await (async () => {
      const context = await browser.newContext(devices["iPad (gen 7)"]);
      const page = await context.newPage();
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
      return { context, page };
    })();
    const page = seed.page;
    const studentApi = seed.context.request;
    const leak = attachLeakMonitor(page);
    try {
      // 默认 inapp 连接 + 备用 link 连接（复制失败场景切通道用）
      const connInapp = await studentApi.post("/api/student/ai/connections", {
        data: {
          channel: "inapp",
          baseUrl: FAKE_AI_BASE_URL,
          model: FAKE_AI_MODEL,
          apiKey: fakeAiApiKey(),
          isDefault: true,
        },
      });
      expect(connInapp.status()).toBe(201);
      const connLink = await studentApi.post("/api/student/ai/connections", {
        data: { channel: "link" },
      });
      expect(connLink.status()).toBe(201);

      await page.setViewportSize({ width: 1280, height: 900 });
      const card = page.locator("li", { hasText: `SAI错链作业${suffix}` });
      await expect(card).toHaveCount(1);
      await card.getByRole("link", { name: "开始练习" }).click();
      await page.waitForURL("**/s/assignments/**");
      const q1 = page.locator('article[aria-label="第 1 题"]');
      await q1.waitFor({ state: "visible" });

      // —— ① 提交失败：POST /ai/tasks 500 → 失败告警 + 输入保留 ——
      await page.route("**/api/student/ai/tasks", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: "E2E_INJECTED",
              message: "服务器开小差了",
            }),
          });
          return;
        }
        await route.continue();
      });
      await page
        .getByRole("article", { name: "第 1 题", exact: true })
        .getByRole("button", { name: "AI 助教", exact: true })
        .click();
      const composer = page.getByPlaceholder("补充卡住的地方（可不填）");
      await composer.waitFor({ state: "visible" });
      await composer.fill("提交失败场景求助");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      // callApi 把服务端壳的 message 透传进告警（errorMessageOf 单源）——
      // 断言注入文案而非猜测的固定前缀，同时证明 500 如实呈现
      await expect(page.getByRole("alert").first()).toContainText(
        "服务器开小差了",
        { timeout: 15_000 },
      );
      await expect(composer).toHaveValue("提交失败场景求助");
      await page.unroute("**/api/student/ai/tasks");

      // —— ② 禁用：教师覆盖 post_submit_only → 点击发送给原因、零建任务 ——
      const disableRes = await request.put(
        `/api/teacher/students/${student.id}/ai-policy`,
        { data: { mode: "post_submit_only" } },
      );
      expect(disableRes.ok()).toBe(true);
      const tasksBefore = (
        (await (
          await studentApi.get("/api/student/ai/tasks?limit=50")
        ).json()) as { data: { tasks: unknown[] } }
      ).data.tasks.length;
      await composer.fill("禁用场景求助");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      // 面板缓存的是改设置前的 usable 状态（本用例未刷新）→ 点击后由
      // 服务端实时裁决拒绝：403 AI_POLICY_DISABLED「当前教学模式下本题
      // 暂不能使用 AI 求助」经 errorMessageOf 透传进告警；若缓存已刷新则
      // 前置拦截文案为「…完成后可用…」——两种真实形态正则都收
      await expect(
        page.getByText(/完成后可用|本题暂不能/u).first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(composer).toHaveValue("禁用场景求助");
      await page.waitForTimeout(2_500);
      const tasksAfter = (
        (await (
          await studentApi.get("/api/student/ai/tasks?limit=50")
        ).json()) as { data: { tasks: unknown[] } }
      ).data.tasks.length;
      expect(tasksAfter, "禁用期间不得创建任务").toBe(tasksBefore);
      expect(await control.requests(), "禁用期间零出站").toHaveLength(0);
      // 恢复开放（后续场景需要）
      const restoreRes = await request.put(
        `/api/teacher/students/${student.id}/ai-policy`,
        { data: { mode: "inherit" } },
      );
      expect(restoreRes.ok()).toBe(true);

      // —— ③ 缺图：材料 PNG 上传 500 → 任务已建但材料失败（不会重复计费），
      //    重试同幂等键补传成功 ——用 link 通道：link 任务停在 created 不自动
      //    派发（主 spec 已证），补传窗口确定存在；inapp 会被 2s worker 抢
      //    先派发、服务端按设计拒绝「处理流程中改材料」，竞态不可复现 ——
      const annotationTrigger = q1.getByRole("button", { name: /圈画题干/ });
      await annotationTrigger.click();
      const annotationCanvas = q1.locator(
        'canvas[data-slot="annotation-canvas"]',
      );
      await expect(annotationCanvas).toHaveAttribute(
        "data-input-enabled",
        "true",
      );
      // 画一笔（真实指针事件；不 mock 材料内容）
      const { drawStrokeWithPointerEvents } = await import("./helpers");
      await drawStrokeWithPointerEvents(annotationCanvas);
      await annotationTrigger.click(); // 收起（笔迹保留）
      await expect(annotationTrigger).toHaveAccessibleName(/已有 1 笔/);

      // 伴学栏从 ① 起一直开着（②③④ 同栏连续操作），不再重复点开——
      // 面板开着时还存在「关闭 AI 助教」，子串匹配会撞严格模式
      const annotationToggle = page.getByRole("checkbox", { name: "圈画" });
      await annotationToggle.check();
      // 通道选择收在「AI 设置」抽屉：先展开再切通道
      await page.getByRole("button", { name: "AI 设置" }).click();
      await page.getByRole("button", { name: "上下文链接" }).click();
      await expect(
        page.getByRole("button", { name: "复制 AI 链接" }),
      ).toBeVisible();
      await page.route(/\/ai\/tasks\/[^/]+\/materials$/, async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: "E2E_INJECTED",
            message: "材料存储故障",
          }),
        });
      });
      await composer.fill("缺图场景求助");
      await page.getByRole("button", { name: "复制 AI 链接" }).click();
      await expect(
        page.getByRole("alert").first(),
        "缺图应如实报告任务已建、材料未传",
      ).toContainText(/材料上传失败/u, { timeout: 15_000 });
      await expect(page.getByText(/不会重复计费/u).first()).toBeVisible();
      await page.unroute(/\/ai\/tasks\/[^/]+\/materials$/);
      // 重试：同幂等键回到同任务补传材料 → 成功（材料失败告警消失；
      // 补传+票据就绪的成功信号是分享框出现——复制成败不影响链接生成）
      await page.getByRole("button", { name: "复制 AI 链接" }).click();
      await expect(
        page.getByRole("alert").filter({ hasText: /材料上传失败/u }),
        "补传成功后不应保留材料失败告警",
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByRole("region", { name: "AI 链接" })).toBeVisible();

      // —— ④ 复制失败：link 通道剪贴板拒绝 → 降级手动复制 ——
      await page.getByRole("button", { name: "上下文链接" }).first().click();
      // 剪贴板写入编程为拒绝（权限拒绝同形态；不依赖真实权限弹窗）
      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: () => Promise.reject(new Error("e2e-denied")),
        });
      });
      await expect(
        page.getByRole("button", { name: "复制 AI 链接" }),
      ).toBeVisible();
      await composer.fill("复制失败场景求助");
      await page.getByRole("button", { name: "复制 AI 链接" }).click();
      await expect(
        page.getByText(/手动复制/u).first(),
        "剪贴板拒绝应降级手动复制",
      ).toBeVisible({ timeout: 15_000 });
      const shareBox = page.getByRole("region", { name: "AI 链接" });
      await expect(shareBox).toBeVisible();
      const ticketUrl = await shareBox.locator("input[readonly]").inputValue();
      expect(ticketUrl).toMatch(/\/api\/public\/ai\/share\/.+/);

      expect(leak.violations(), "全程学生端响应无禁键").toEqual([]);
    } finally {
      await seed.context.close();
    }
  });

  test("出站链错误：60s 超时收敛 uncertain，批量任务部分成功互不阻塞", async ({
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
      `e2e-sai超时课${suffix}`,
    );
    const unitName = `sai超时单元${suffix}`;
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: choiceJudgePracticeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    expect(importRes.ok()).toBe(true);
    const loginName = `e2e-saito-${suffix}`;
    await createStudentViaApi(request, "e2e超时生", loginName);
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);
    const assignmentRes = await request.post("/api/teacher/assignments", {
      data: {
        unitIds: [
          ((await importRes.json()) as { data: { units: { id: string }[] } })
            .data.units[0]?.id ?? "",
        ],
        studentIds: [student.id],
        title: `SAI超时作业${suffix}`,
        courseId,
      },
    });
    expect(assignmentRes.ok()).toBe(true);

    const seed = await (async () => {
      const context = await browser.newContext(devices["iPad (gen 7)"]);
      const page = await context.newPage();
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
      return { context, page };
    })();
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

      // 开卷取 attemptId/questionId（API 快轨；浏览器只承载登录态）
      const assignmentId = (
        (await assignmentRes.json()) as {
          data: { assignments: { id: string }[] };
        }
      ).data.assignments[0]?.id;
      if (assignmentId === undefined) throw new Error("缺少作业 id");
      const attemptId = (
        (await (
          await studentApi.post(
            `/api/student/assignments/${assignmentId}/attempt`,
          )
        ).json()) as { data: { id: string } }
      ).data.id;
      const questionId = (
        (await (
          await studentApi.get(`/api/student/attempts/${attemptId}`)
        ).json()) as { data: { units: { questions: { id: string }[] }[] } }
      ).data.units.flatMap((unit) => unit.questions)[0]?.id;
      expect(typeof questionId).toBe("string");

      const createTask = async (question: string) => {
        const res = await studentApi.post("/api/student/ai/tasks", {
          data: {
            attemptId,
            questionId,
            question,
            channel: "inapp",
            materials: { annotation: false, draft: false, formalInk: false },
            mutationId: crypto.randomUUID(),
          },
        });
        expect(res.status()).toBe(201);
        return ((await res.json()) as { data: { id: string } }).data.id;
      };

      // —— ① 超时：61s 慢响应越过 60s 出站时限 → uncertain（不自动重发）——
      await control.script({ delayMs: 61_000 });
      const taskTimeout = await createTask("超时场景求助");
      await control.waitForRequest((r) => r.body.includes("超时场景求助"));
      const timeoutStatus = await pollTaskStatus(
        studentApi,
        taskTimeout,
        "uncertain",
        100_000,
      );
      expect(
        timeoutStatus,
        "超时应收敛 uncertain（可能已收费，不自动重发）",
      ).toBe("uncertain");

      // —— ② 批量部分成功：A/B 同轮并发派发（同学生并发上限 3，Promise.all
      // 出站到达序不定）。剧本 [成功×1, 500×3]：首个到达的出站拿成功回信
      // 即收敛 replied；另一任务 500 退避重试至 AI_DISPATCH_MAX_ATTEMPTS=3
      // 次上限后明确 failed。谁成功由到达序决定，断言按无序终态集合
      // {failed, replied} 收——保留同轮真实并发，不降级为串行造数 ——
      const replyA = "批量回信 A：这题成功。";
      await control.script({ body: chatCompletionJson(replyA) });
      for (let i = 0; i < 3; i += 1) {
        await control.script({ status: 500, body: '{"error":"boom"}' });
      }
      const taskA = await createTask("批量成功求助");
      const taskB = await createTask("批量失败求助");
      const statusA = await pollTaskTerminal(studentApi, taskA, 60_000);
      const statusB = await pollTaskTerminal(studentApi, taskB, 60_000);
      expect(
        [statusA, statusB].sort(),
        "批量任务应一成一败互不阻塞（并发到达序不锁定谁成功）",
      ).toEqual(["failed", "replied"]);
    } finally {
      await seed.context.close();
    }
  });

  test("作废卷：讲练重开后旧任务动作收敛、回信 409，新卷 AI 可用", async ({
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
      `e2e-sai作废课${suffix}`,
    );
    const unitName = `sai作废单元${suffix}`;
    const lectureTitle = `SAI作废讲练${suffix}`;
    const lessonMd = [
      "---",
      "kind: lesson",
      `unit: ${unitName}`,
      "topic: 相反数",
      "---",
      "",
      `# ${lectureTitle}`,
      "",
      "段落一：相反数的引入。",
      "",
      '::::question{type=judge difficulty=1 knowledge="作废讲练考点"}',
      "$1$ 是正数。[[正确]]",
      "",
      ":::solution",
      "作废讲练详解：$1$ 大于 $0$，是正数。",
      ":::",
      "::::",
      "",
      "段落二：小结。",
      "",
    ].join("\n");
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: lessonMd,
        filename: `${unitName}.md`,
        courseId,
      },
    });
    expect(importRes.ok()).toBe(true);
    const loginName = `e2e-saivo-${suffix}`;
    await createStudentViaApi(request, "e2e作废生", loginName);
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const seed = await (async () => {
      const context = await browser.newContext(devices["iPad (gen 7)"]);
      const page = await context.newPage();
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
      return { context, page };
    })();
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

      // 讲练开卷 → 作答中求助（捕获任务 id）
      await page.getByRole("link", { name: "按讲义浏览" }).click();
      await page.waitForURL("**/s/lectures");
      await page
        .getByRole("link", { name: `打开讲练 ${lectureTitle}` })
        .click();
      await page.waitForURL(/\/s\/lectures\/[^/]+\/lesson(\?|$)/);
      const lectureId =
        page.url().match(/\/s\/lectures\/([^/]+)\/lesson/)?.[1] ?? "";
      expect(lectureId).not.toBe("");
      await page
        .getByRole("button", { name: `开始练习 ${lectureTitle}` })
        .click();
      await page.waitForURL(/\/s\/lectures\/[^/]+\/lesson\/run/);
      const q1 = page.locator('article[aria-label="第 1 题"]');
      await q1.waitFor({ state: "visible" });

      await control.script({ body: chatCompletionJson("作废前回信。") });
      const taskCreated = page.waitForResponse(
        (res) =>
          res.request().method() === "POST" &&
          /\/api\/student\/ai\/tasks$/.test(res.url()),
      );
      await page
        .getByRole("article", { name: "第 1 题", exact: true })
        .getByRole("button", { name: "AI 助教", exact: true })
        .click();
      await page
        .getByPlaceholder("补充卡住的地方（可不填）")
        .fill("作废前场景求助");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const createdRes = await taskCreated;
      const oldTaskId = ((await createdRes.json()) as { data: { id: string } })
        .data.id;
      await control.waitForRequest((r) => r.body.includes("作废前场景求助"));
      await page.keyboard.press("Escape");

      // 重新开始：确认弹层明示作废 → 新卷（第 2 次）
      await page.goto(`/s/lectures/${lectureId}/lesson?courseId=${courseId}`);
      await page.getByRole("button", { name: "重新开始" }).click();
      await expect(
        page.getByRole("dialog", { name: "重新开始确认" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "开始新一次" }).click();
      await page.waitForURL(/\/s\/lectures\/[^/]+\/lesson\/run/);
      await expect(page.getByText(/讲练 · 第 2 次/)).toBeVisible();

      // 旧任务（服务端设计口径，见 student-ai-matrix-d2）：详情仍可读但
      // 动作收敛到无害集合（created→cancel、replied→archive、派发中→
      // 空），不抛 5xx；打开回信按作废传播 409 ATTEMPT_ABANDONED（正文
      // 不交付）
      const oldTaskRes = await studentApi.get(
        `/api/student/ai/tasks/${oldTaskId}`,
      );
      expect(oldTaskRes.status()).toBe(200);
      const oldTask = (await oldTaskRes.json()) as {
        data: { task: { allowedActions: string[] } };
      };
      expect(
        oldTask.data.task.allowedActions.filter(
          (action) => action !== "cancel" && action !== "archive",
        ),
        "作废卷旧任务不得保留发送/分享/追问/重试动作",
      ).toEqual([]);
      const openedRes = await studentApi.post(
        `/api/student/ai/tasks/${oldTaskId}/opened`,
      );
      expect(openedRes.status()).toBe(409);
      expect(((await openedRes.json()) as { error: string }).error).toBe(
        "ATTEMPT_ABANDONED",
      );

      // 新卷：AI 面板可用（新 attempt 任务列表从空开始）
      await page
        .getByRole("article", { name: "第 1 题", exact: true })
        .getByRole("button", { name: "AI 助教", exact: true })
        .click();
      await page.getByRole("button", { name: "AI 设置" }).click();
      await expect(page.getByText("当前：开放伴学")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByText("卡住了也没关系。先拿一点提示，再自己试一步。"),
        "新卷不得携带旧卷任务",
      ).toBeVisible();
    } finally {
      await seed.context.close();
    }
  });
});
