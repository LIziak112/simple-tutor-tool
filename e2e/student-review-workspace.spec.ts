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

test("130题多单元回看：保活、定位、响应式、记录往返与按需材料", async ({
  request,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { attemptId, title } = await prepareResult(request, page, true);
  const materialRequests: string[] = [];
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
  expect(materialRequests).toEqual([]);
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
    await page.screenshot({ path: testInfo.outputPath(`review-${width}.png`) });
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
  expect(materialRequests).toEqual([]);
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
  await last
    .getByRole("button", { name: "第 130 题查看草稿原稿", exact: true })
    .click();
  await expect(
    last.getByText("本次交卷没有采集到草稿", { exact: false }),
  ).toBeVisible();
  await last
    .getByRole("button", { name: "查看第 130 题题干标注", exact: true })
    .click();
  await expect(
    last.getByText("本题未使用题干标注", { exact: true }),
  ).toBeVisible();
  expect(materialRequests.length).toBeGreaterThan(0);
  const lastQuestionId = await last.getAttribute("data-review-question");
  if (!lastQuestionId) throw new Error("末题缺少题目ID");
  for (const url of materialRequests)
    expect(decodeURIComponent(url)).toContain(lastQuestionId);
});

test("未公布回看：网络无秘密，已选中性且没有判定范围", async ({
  request,
  page,
}, testInfo) => {
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
  await expect(
    page.getByText("已交卷，答案将在截止后公布", { exact: false }),
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
  await page.screenshot({ path: testInfo.outputPath("review-unreleased.png") });
});

test("富题型回看：部分填空与全待批、长公式、零分和教师改判", async ({
  request,
  page,
}, testInfo) => {
  const { attemptId, result } = await prepareResult(request, page, false, true);
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
  const teacher = teacherAttemptDetailOkSchema.parse(await fetched.json()).data;
  for (const question of teacher.questions) {
    const marked = await request.post(
      `/api/teacher/responses/${question.responseId}/mark`,
      { data: { mark: "wrong", comment: "先补全每一空，再核对计算过程。" } },
    );
    expect(marked.ok(), await marked.text()).toBe(true);
  }
  await page.reload();
  await expect(page.locator("span.text-4xl")).toHaveText("0");
  await expect(first.getByText("先补全每一空，再核对计算过程。")).toBeVisible();
  await expect(first.getByLabel("答错")).toBeVisible();
  const responseId = teacher.questions[0]?.responseId;
  if (!responseId) throw new Error("测试缺少作答响应ID");
  const revised = await request.post(
    `/api/teacher/responses/${responseId}/mark`,
    { data: { mark: "correct", comment: "核对原稿后改判为对。" } },
  );
  expect(revised.ok(), await revised.text()).toBe(true);
  await page.reload();
  await expect(page.locator("span.text-4xl")).toHaveText("50");
  await expect(first.getByLabel("答对")).toBeVisible();
  await expect(first.getByText("核对原稿后改判为对。")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("review-teacher-revised-320.png"),
  });
});
