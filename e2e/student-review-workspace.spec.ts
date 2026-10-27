import { writeFile } from "node:fs/promises";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  assignmentCreateOkSchema,
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  importCommitOkSchema,
  type StudentAnswer,
  teacherAttemptDetailOkSchema,
} from "../packages/contract/src/index";
import {
  createCourseViaApi,
  getStudentViaApi,
  isolateRegisterRateLimit,
  registerTeacherViaUi,
  teacherApiLogin,
  teacherLoginViaApi,
  uniqueSuffix,
} from "./helpers";
import { expectNavigationRingSpace } from "./navigation-ring";

async function prepareResult(
  request: APIRequestContext,
  page: Page,
  long: boolean,
  rich = false,
) {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  // 长标题等极端数据归专属教师，不能污染其他用例的默认教师列表。
  const teacherName = `review-teacher-${suffix}`;
  const teacherPassword = "review-teacher-pass";
  const slot =
    (long ? 1 : rich ? 3 : 2) +
    (page.context().browser()?.browserType().name() === "webkit" ? 10 : 0);
  await isolateRegisterRateLimit(page, `10.239.12.${slot}`);
  await registerTeacherViaUi(page, request, teacherName, teacherPassword);
  await teacherLoginViaApi(request, teacherName, teacherPassword);
  const courseId = await createCourseViaApi(request, `回看课程${suffix}`);
  const unitIds: string[] = [];
  const title = `回看长卷${suffix}${long ? "LongTitle".repeat(12) : ""}`.slice(
    0,
    100,
  );
  const secret = `仅公布后可见的解析${suffix}`;
  for (let unit = 0; unit < (long ? 2 : 1); unit++) {
    const name = `回看单元${suffix}-${unit}`;
    const markdown = [
      "---",
      "kind: practice",
      `unit: ${name}`,
      "---",
      "",
      ...Array.from({ length: long ? 65 : 2 }, (_, index) =>
        [
          rich
            ? '::::question{type=fill difficulty=1 knowledge="回看测试"}'
            : '::::question{type=choice difficulty=1 knowledge="回看测试"}',
          rich
            ? `第${index + 1}题：计算 $1+1=$ [[2]]；$2+2=$ [[4]]。\n\n$$${"\\frac{1}{2}+".repeat(16)}\\frac{1}{2}$$`
            : `第${unit * 65 + index + 1}题：计算 $1+1$。`,
          "",
          ...(rich
            ? []
            : [
                long && index === 64
                  ? `- [ ] ${"LongOption".repeat(12)}`
                  : "- [ ] 1",
                "- [x] 2",
                "- [ ] 3",
              ]),
          "",
          ":::solution",
          secret,
          ":::",
          "::::",
          "",
        ].join("\n"),
      ),
    ].join("\n");
    const imported = await request.post("/api/teacher/import/commit", {
      data: { markdown, filename: `${name}.md`, courseId },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    const id = importCommitOkSchema.parse(await imported.json()).data.units[0]
      ?.id;
    if (!id) throw new Error("导入响应缺少单元");
    unitIds.push(id);
  }
  const loginName = `review-${suffix}`;
  const created = await request.post("/api/teacher/students", {
    data: { displayName: "回看测试生", loginName },
  });
  expect(created.ok()).toBe(true);
  const student = await getStudentViaApi(request, loginName);
  const assigned = await request.post("/api/teacher/assignments", {
    data: {
      unitIds,
      studentIds: [student.id],
      title,
      courseId,
      ...(long || rich
        ? {}
        : {
            answerRelease: "after_due",
            dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          }),
    },
  });
  expect(assigned.ok(), await assigned.text()).toBe(true);
  const assignmentId = assignmentCreateOkSchema.parse(await assigned.json())
    .data.assignments[0]?.id;
  if (!assignmentId) throw new Error("作业响应缺少ID");
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  const api = page.context().request;
  const started = await api.post(
    `/api/student/assignments/${assignmentId}/attempt`,
  );
  const attemptId = attemptStartOkSchema.parse(await started.json()).data.id;
  const fetched = await api.get(`/api/student/attempts/${attemptId}`);
  const draft = attemptDraftOkSchema.parse(await fetched.json()).data;
  const questions = draft.units.flatMap((unit) => unit.questions);
  const answers: StudentAnswer[] = rich
    ? [{ kind: "fill", values: ["2", ""] }]
    : [
        { kind: "choice", index: 1 },
        { kind: "choice", index: 0 },
      ];
  for (const [index, answer] of answers.entries()) {
    const question = questions[index];
    if (!question) throw new Error("测试题目缺失");
    const saved = await api.put(
      `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(question.id)}`,
      { data: { answer } },
    );
    expect(saved.ok(), await saved.text()).toBe(true);
  }
  const submitted = await api.post(
    `/api/student/attempts/${attemptId}/submit`,
    {
      data: {
        revisions: questions.map((question) => ({
          questionId: question.id,
          questionRevisionId: question.questionRevisionId,
        })),
      },
    },
  );
  expect(submitted.ok(), await submitted.text()).toBe(true);
  const result = attemptResultOkSchema.parse(await submitted.json()).data;
  return { attemptId, title, secret, result };
}

test(
  "单行操作栏与本题历史返回：窄屏、缩放、镜像与刷新",
  { tag: ["@student"] },
  async ({ request, page }, testInfo) => {
    const { attemptId, result } = await prepareResult(
      request,
      page,
      false,
      true,
    );
    const questionId = result.units[0]?.questions[1]?.questionId;
    if (!questionId) throw new Error("缺少第二题");
    const params = new URLSearchParams({
      returnTo: "/s/records?status=graded",
      reviewScope: "pending",
      reviewQuestion: questionId,
    });
    const source = `/s/attempts/${attemptId}?${params}`;
    await page.goto(source);
    const card = page.getByRole("article", { name: "第 2 题", exact: true });
    const tools = card.getByRole("region", { name: "第 2 题材料与订正" });
    const row = tools.getByRole("group", { name: "第 2 题操作（可横向滚动）" });
    for (const width of [320, 390, 820, 1110, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await tools.scrollIntoViewIfNeeded();
      const measurements = await row.evaluate((element) =>
        [...element.children].map((child) => child.getBoundingClientRect().top),
      );
      expect(
        Math.max(...measurements) - Math.min(...measurements),
      ).toBeLessThan(3);
      expect(
        await tools.evaluate(
          (element) => element.getBoundingClientRect().height,
        ),
      ).toBeLessThan(80);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`single-row-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 820, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
      document.documentElement.dir = "rtl";
    });
    await tools.scrollIntoViewIfNeeded();
    await expect(tools.getByLabel("横向滚动查看更多操作")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("single-row-zoom-rtl.png"),
    });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
      document.documentElement.dir = "ltr";
    });
    await row.getByRole("button", { name: "草稿", exact: true }).click();
    await expect(card.getByText("草稿原稿")).toBeVisible();
    // 订正是直达动作：打开全屏重做工作台（题面 + 圈画 + 草稿纸）
    await row.getByRole("button", { name: "第 2 题订正", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByText("订正 · 第 2 题"),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭弹层" }).first().click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // 工作台关闭后草稿面板保持（控制器持续挂载）
    await expect(card.getByText("草稿原稿")).toBeVisible();
    await row.getByRole("button", { name: "更多", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "第 2 题 AI 复习包" }),
    ).toBeVisible();
    await row.getByRole("button", { name: "更多", exact: true }).click();
    await card.getByRole("link", { name: "第 2 题本题历史" }).click();
    await expect(
      page.getByRole("link", { name: "返回作答结果" }),
    ).toHaveAttribute("href", source);
    await page.reload();
    await page.getByRole("link", { name: "返回作答结果" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/attempts/${attemptId}\\?`));
    const returned = new URL(page.url());
    expect(returned.searchParams.get("reviewQuestion")).toBe(questionId);
    expect(returned.searchParams.get("reviewScope")).toBe("pending");
    expect(returned.searchParams.get("returnTo")).toBe(
      "/s/records?status=graded",
    );
    await expect(card).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "返回我的记录", exact: true }),
    ).toBeVisible();
    const assignmentId = result.attempt.assignmentId;
    if (!assignmentId) throw new Error("缺少作业ID");
    const assignmentSource = `/s/assignments/${assignmentId}?${params}`;
    await page.goto(assignmentSource);
    await card.getByRole("link", { name: "第 2 题本题历史" }).click();
    await expect(
      page.getByRole("link", { name: "返回作答结果" }),
    ).toHaveAttribute("href", assignmentSource);
    await page.getByRole("link", { name: "返回作答结果" }).click();
    await expect(card).toBeInViewport();
    expect(new URL(page.url()).pathname).toBe(`/s/assignments/${assignmentId}`);
  },
);

test(
  "130题多单元回看：保活、定位、响应式、记录往返与按需材料",
  { tag: ["@student"] },
  async ({ request, page }, testInfo) => {
    test.setTimeout(180_000);
    const { attemptId, title } = await prepareResult(request, page, true);
    const materialRequests: string[] = [];
    // 2026-10-15 起题卡进入可见区自动读取原标画（AGENTS.md「结果回看 UI 约定」）：
    // 题干标注视图按可见性懒加载属于设计内行为，不计入「折叠材料不得预取」的
    // 断言范围；evidence/ink/notes/review-pack 等材料请求仍必须为零。数量
    // 上限见用例尾部的 stemAnnotationReads 上限断言（防退化成挂载即全量预取）。
    const stemAnnotationRead = /\/questions\/[^/]+\/annotation\?phase=scratch$/;
    const eagerMaterialRequests = () =>
      materialRequests.filter((url) => !stemAnnotationRead.test(url));
    const stemAnnotationReads = () =>
      materialRequests.filter((url) => stemAnnotationRead.test(url));
    page.on("request", (request) => {
      if (
        /\/api\/.*\/(evidence|annotations?|annotation-bases|notes?|note-heads|ink|review-pack)(\/|\?|$)/.test(
          request.url(),
        )
      )
        materialRequests.push(request.url());
    });
    const startedAt = Date.now();
    await page.goto(
      `/s/attempts/${attemptId}?returnTo=${encodeURIComponent("/s/records?status=graded")}`,
    );
    await expect(
      page.getByRole("heading", { name: title, level: 1 }),
    ).toBeVisible();
    await expect(page.locator("[data-review-question]")).toHaveCount(130);
    await expect(page.locator("canvas")).toHaveCount(0);
    expect(eagerMaterialRequests()).toEqual([]);
    const firstRenderMs = Date.now() - startedAt;
    const nodeCount = await page.locator("*").count();
    const measurements: {
      width: number;
      height: number;
      headerBottom: number;
      top: number;
    }[] = [];
    const last = page.getByRole("article", { name: "第 130 题", exact: true });
    for (const [width, height] of [
      [320, 800],
      [390, 844],
      [768, 1024],
      [810, 668],
      [1024, 768],
      [1110, 668],
      [1200, 900],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      if (width < 1024)
        await page.getByRole("button", { name: "打开回看题号" }).click();
      const navigation =
        width < 1024
          ? page.getByRole("dialog")
          : page.getByRole("complementary", { name: "结果定位" });
      await expectNavigationRingSpace(
        navigation.getByRole("navigation", { name: "回看题号" }),
      );
      await navigation
        .getByRole("button", { name: "第 130 题，未作答，判错", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        last.getByRole("heading", { name: "第 130 题", exact: true }),
      ).toBeFocused();
      await expect(
        page.getByRole("button", { name: "下一题", exact: true }),
      ).toBeDisabled();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
      const geometry = await page.evaluate(() => {
        const header = document
          .querySelector('[data-slot="attempt-header"]')
          ?.getBoundingClientRect();
        const heading = document.activeElement?.getBoundingClientRect();
        return {
          headerBottom: header?.bottom ?? 0,
          top: heading?.top ?? 0,
        };
      });
      expect(geometry.top).toBeGreaterThanOrEqual(geometry.headerBottom);
      measurements.push({ width, height, ...geometry });
      if (width >= 1024) {
        const tools = last.getByRole("region", { name: "第 130 题材料与订正" });
        const toolsBox = await tools.boundingBox();
        expect(toolsBox?.height).toBeLessThanOrEqual(180);
        const before = await last.boundingBox();
        if (!before) throw new Error("无法测量题卡");
        const toggle = page.getByRole("button", { name: "收起题号栏" });
        await toggle.press("Enter");
        await expect(
          page.getByRole("button", { name: "展开题号栏" }),
        ).toBeFocused();
        await expect(
          navigation.getByRole("combobox", { name: "回看定位范围" }),
        ).toBeHidden();
        await expect
          .poll(async () => (await last.boundingBox())?.width ?? 0)
          .toBeGreaterThan(before.width + 190);
        await expect(last).toBeInViewport();
        await page.screenshot({
          path: testInfo.outputPath(`review-collapsed-${width}.png`),
        });
        await page.getByRole("button", { name: "展开题号栏" }).press("Space");
        await expect(
          navigation.getByRole("combobox", { name: "回看定位范围" }),
        ).toHaveValue("all");
        await expect(page.locator("[data-review-question]")).toHaveCount(130);
        await page
          .locator("[aria-labelledby='result-summary']")
          .scrollIntoViewIfNeeded();
        await expect(page.getByLabel("题目数量统计")).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`review-summary-${width}.png`),
        });
        await navigation
          .getByRole("button", { name: "第 130 题，未作答，判错", exact: true })
          .click();
        await tools.scrollIntoViewIfNeeded();
        // 补足固定底栏的遮挡区，让完整工具组出现在截图中。
        await page.evaluate(() => window.scrollBy(0, 100));
        await page.screenshot({
          path: testInfo.outputPath(`review-tools-${width}.png`),
        });
      }
      await page.screenshot({
        path: testInfo.outputPath(`review-${width}.png`),
      });
    }
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await page
      .getByRole("complementary", { name: "结果定位" })
      .getByRole("button", { name: "第 130 题，未作答，判错", exact: true })
      .click();
    await expect(last).toBeInViewport();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("review-zoom-200.png") });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "打开回看题号" }).click();
    await page
      .getByRole("dialog")
      .getByRole("combobox", { name: "回看定位范围" })
      .selectOption("wrong");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "打开回看题号" }),
    ).toBeFocused();
    await expect(page.locator("[data-review-question]")).toHaveCount(130);
    await page.reload();
    await expect(last).toBeInViewport();
    expect(eagerMaterialRequests()).toEqual([]);
    await page.getByRole("button", { name: "返回我的记录" }).click();
    await expect(page).toHaveURL(/\/s\/records\?status=graded$/);
    await expect(
      page.getByRole("combobox", { name: "状态", exact: true }),
    ).toHaveValue("graded");
    await page.screenshot({ path: testInfo.outputPath("records-390.png") });
    await page
      .getByRole("link", { name: `查看结果：${title}（已批改）` })
      .click();
    await expect(last).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("review-return.png") });
    await writeFile(
      testInfo.outputPath("review-measurements.json"),
      JSON.stringify(
        {
          firstRenderMs,
          nodeCount,
          questions: 130,
          initialCanvases: 0,
          closedMaterialRequests: materialRequests.length,
          measurements,
        },
        null,
        2,
      ),
    );
    await last.getByRole("button", { name: "草稿", exact: true }).click();
    await expect(
      last.getByText("本次交卷没有采集到草稿", { exact: false }),
    ).toBeVisible();
    expect(materialRequests.length).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1110, height: 668 });
    await expect(
      last.locator('[data-slot="note-original-view"]'),
    ).toBeVisible();
    const originalBox = await last
      .locator('[data-slot="note-original-view"]')
      .boundingBox();
    const cardBox = await last.boundingBox();
    if (!originalBox || !cardBox) throw new Error("无法测量展开材料");
    expect(originalBox.width).toBeGreaterThan(cardBox.width - 60);
    const lastQuestionId = await last.getAttribute("data-review-question");
    if (!lastQuestionId) throw new Error("末题缺少题目ID");
    // 可见性题干读必须有界：只有进入过视口（含 200px 预载边距）的题卡才读；
    // 若退化为挂载即全量预取（130 题），上限立即击穿。
    expect(stemAnnotationReads().length).toBeLessThanOrEqual(20);
    // 排除可见性驱动的题干标注读（见 eagerMaterialRequests 说明）后，
    // 展开材料触发的请求必须都属于当前展开的末题。
    for (const url of eagerMaterialRequests())
      expect(decodeURIComponent(url)).toContain(lastQuestionId);
  },
);

test(
  "未公布回看：网络无秘密，已选中性且没有判定范围",
  { tag: ["@student"] },
  async ({ request, page }, testInfo) => {
    const { attemptId, secret, result } = await prepareResult(
      request,
      page,
      false,
    );
    expect(result.answersReleased).toBe(false);
    for (const question of result.units.flatMap((unit) => unit.questions)) {
      expect(question.answers).toBeNull();
      expect(question.solutionMd).toBeNull();
      expect(question.finalCorrect).toBeNull();
      expect(question.teacherMark).toBeNull();
      expect(question.teacherComment).toBeNull();
    }
    expect(JSON.stringify(result)).not.toContain(secret);
    const loaded = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/student/attempts/${attemptId}`) &&
        response.request().method() === "GET",
    );
    await page.goto(`/s/attempts/${attemptId}`);
    const browserResult = attemptResultOkSchema.parse(
      await (await loaded).json(),
    ).data;
    expect(browserResult.answersReleased).toBe(false);
    expect(JSON.stringify(browserResult)).not.toContain(secret);
    for (const question of browserResult.units.flatMap(
      (unit) => unit.questions,
    )) {
      expect(question.answers).toBeNull();
      expect(question.solutionMd).toBeNull();
      expect(question.finalCorrect).toBeNull();
      expect(question.teacherComment).toBeNull();
    }
    // 横幅 2026-10-21 改版为「交卷成功与待公布提示」卡（含倒计时），
    // 以区域名锚定未公布态横幅，题级中性由后续断言覆盖
    await expect(
      page.getByRole("region", { name: "交卷成功与待公布提示" }),
    ).toBeVisible();
    const card = page.getByRole("article", { name: "第 2 题", exact: true });
    const picked = card.getByRole("listitem").filter({ hasText: "你的选择" });
    await expect(picked).not.toHaveClass(/red|emerald/);
    await expect(card.getByText("正确项", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "打开回看题号" }).click();
    const range = page
      .getByRole("dialog")
      .getByRole("combobox", { name: "回看定位范围" });
    await expect(range.getByRole("option")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("review-unreleased.png"),
    });
  },
);

test(
  "富题型回看：部分填空与全待批、长公式、零分和教师改判",
  { tag: ["@student"] },
  async ({ request, page }, testInfo) => {
    const { attemptId, result } = await prepareResult(
      request,
      page,
      false,
      true,
    );
    expect(result.attempt.status).toBe("submitted");
    expect(result.summary.pendingCount).toBe(2);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`/s/attempts/${attemptId}`);
    await expect(
      page.getByText("已交卷 · 待批改", { exact: true }),
    ).toBeVisible();
    const first = page.getByRole("article", { name: "第 1 题", exact: true });
    await expect(
      page.getByText("未答数单独统计，可能与判错或待批重叠，不能相加。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(first).toContainText("第2空未填");
    await expect(page.locator(".katex-error, .math-fallback")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "打开回看题号" }).click();
    await page
      .getByRole("dialog")
      .getByRole("combobox", { name: "回看定位范围" })
      .selectOption("pending");
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "第 1 题，已作答，待批", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "第 2 题，未作答，待批", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("review-pending-fill-320.png"),
    });
    const fetched = await request.get(`/api/teacher/attempts/${attemptId}`);
    const teacher = teacherAttemptDetailOkSchema.parse(
      await fetched.json(),
    ).data;
    for (const question of teacher.questions) {
      const marked = await request.post(
        `/api/teacher/responses/${question.responseId}/mark`,
        { data: { mark: "wrong", comment: "先补全每一空，再核对计算过程。" } },
      );
      expect(marked.ok(), await marked.text()).toBe(true);
    }
    await page.reload();
    await expect(page.locator("span.text-4xl")).toHaveText("0");
    await expect(
      first.getByText("先补全每一空，再核对计算过程。"),
    ).toBeVisible();
    await expect(
      first.getByRole("region", { name: "本题评判" }).getByRole("status"),
    ).toHaveText("教师判定：错误");
    const responseId = teacher.questions[0]?.responseId;
    if (!responseId) throw new Error("测试缺少作答响应ID");
    const revised = await request.post(
      `/api/teacher/responses/${responseId}/mark`,
      { data: { mark: "correct", comment: "核对原稿后改判为对。" } },
    );
    expect(revised.ok(), await revised.text()).toBe(true);
    await page.reload();
    await expect(page.locator("span.text-4xl")).toHaveText("50");
    await expect(
      first.getByRole("region", { name: "本题评判" }).getByRole("status"),
    ).toHaveText("教师判定：正确");
    await expect(first.getByText("核对原稿后改判为对。")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("review-teacher-revised-320.png"),
    });
  },
);
