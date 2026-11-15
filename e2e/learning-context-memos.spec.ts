import {
  type APIRequestContext,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import {
  assignmentCreateOkSchema,
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  importCommitOkSchema,
  learningContextOkSchema,
  lessonStartOkSchema,
  memoListOkSchema,
} from "../packages/contract/src/index";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  importUnitToCourse,
  openChoicePractice,
  prepareCourseStudent,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";
import { qmApi, startQmPair, stopQmPair } from "./qm-server";

/** 来源坐标必须经过真实鉴权/冻结投影/设备登记/随笔创建链；不从页面拼版本。 */
async function practice(
  page: Page,
  request: APIRequestContext,
  material = false,
) {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix(),
    name = `上下文练习${suffix}`,
    courseName = `上下文课程${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  const ids = [`${suffix}-one`, `${suffix}-two`];
  const markdown = material
    ? `---\nkind: practice\nunit: ${name}\n---\n\n::::material{id=${suffix}-m title="共享阅读材料"}\n共享材料正文：两题都根据此段作答。\n::::\n\n::::group{id=${suffix}-g title="共享材料两题"}\n::ref{material=${suffix}-m}\n::ref{question=${ids[0]}}\n::ref{question=${ids[1]}}\n::::\n\n::::question{id=${ids[0]} type=judge difficulty=1}\n第一题。[[正确]]\n::::\n\n::::question{id=${ids[1]} type=judge difficulty=1}\n第二题。[[正确]]\n::::\n`
    : choiceJudgePracticeMarkdown(name);
  await importUnitToCourse(request, courseId, name, markdown);
  const student = await prepareCourseStudent(
    request,
    courseId,
    `source-${suffix}`,
    "上下文同学",
  );
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  const attemptId = await openChoicePractice(page, courseId, courseName, name);
  const draft = attemptDraftOkSchema.parse(
    await (await page.request.get(`/api/student/attempts/${attemptId}`)).json(),
  ).data;
  const questions = draft.units.flatMap((u) => u.questions);
  await expect(card(page, 2)).toBeVisible();
  await expect(page.getByTestId("draft-status")).toHaveText("全部已保存");
  return { attemptId, draft, questions, student, courseId };
}
const card = (page: Page, no: number) =>
  page.locator(`article[aria-label="第 ${no} 题"]`);
async function openCardMemo(page: Page, no: number, released = false) {
  const target = card(page, no);
  if (released)
    await target.getByRole("button", { name: "记随笔", exact: true }).click();
  else {
    await target
      .getByRole("button", { name: `第 ${no} 题更多`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: "记随笔", exact: true }).click();
  }
  const dialog = page.getByRole("dialog", { name: "随手记" });
  await expect(dialog.getByLabel("随笔内容")).toBeFocused();
  return dialog;
}
async function save(page: Page, dialog: Locator, text: string) {
  await dialog.getByLabel("随笔内容").fill(text);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => {
      const list = memoListOkSchema.parse(
        await (await page.request.get("/api/student/memos")).json(),
      ).data.memos;
      return list.some((m) => m.text === text);
    })
    .toBe(true);
  return memoListOkSchema
    .parse(await (await page.request.get("/api/student/memos")).json())
    .data.memos.find((m) => m.text === text);
}

test.describe("公共学习来源与显式题卡随笔", { tag: ["@student"] }, () => {
  test("列表第二题：键盘打开/Escape还焦，打开后滚动仍保存原题和真实deviceId", async ({
    page,
    request,
  }) => {
    const leak = attachLeakMonitor(page);
    const e = await practice(page, request);
    const second = e.questions[1];
    if (!second) throw new Error("缺少真实第二题DTO");
    await expect(card(page, 2)).toHaveAttribute(
      "data-learning-revision",
      second.questionRevisionId,
    );
    const trigger = card(page, 2).getByRole("button", {
      name: "第 2 题更多",
      exact: true,
    });
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await trigger.press("Enter");
    await page
      .getByRole("menuitem", { name: "记随笔", exact: true })
      .press("Enter");
    const dialog = page.getByRole("dialog", { name: "随手记" });
    await expect(dialog.getByLabel("随笔内容")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await openCardMemo(page, 2);
    await card(page, 1).evaluate((el) =>
      el.scrollIntoView({ block: "start", behavior: "instant" }),
    );
    const memo = await save(page, dialog, "第二题固定来源");
    expect(memo?.anchor).toMatchObject({
      kind: "question",
      attemptId: e.attemptId,
      questionId: e.questions[1]?.id,
    });
    expect(memo?.context?.session).toMatchObject({
      attemptId: e.attemptId,
      questionRevisionId: e.questions[1]?.questionRevisionId,
      questionNo: 2,
      questionCount: 2,
      settlementSeq: null,
    });
    const deviceId = await page.evaluate(() =>
      localStorage.getItem("tutor:device-id:v1"),
    );
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(memo?.deviceId).toBe(deviceId);
    expect(memo?.context?.deviceId).toBe(deviceId);
    expect(memo?.context?.view).toMatchObject({
      surface: "attempt",
      layout: "list",
    });
    await leak.drain();
    expect(leak.violations()).toEqual([]);
  });
  test("单题专注：明确切到第二题后卡片入口按第二题捕获", async ({
    page,
    request,
  }) => {
    const e = await practice(page, request);
    await page.getByRole("button", { name: "练习更多" }).click();
    await page.getByRole("menuitem", { name: "做题方式", exact: true }).click();
    await page
      .getByRole("radio", { name: "单题专注", exact: true })
      .locator("xpath=ancestor::label[1]")
      .click();
    await page.getByRole("button", { name: "下一题", exact: true }).click();
    await expect(card(page, 2)).toBeVisible();
    await expect(card(page, 1)).toBeHidden();
    const memo = await save(page, await openCardMemo(page, 2), "单题第二题");
    expect(memo?.context?.session).toMatchObject({
      questionRevisionId: e.questions[1]?.questionRevisionId,
      questionNo: 2,
      questionCount: 2,
    });
    expect(memo?.context?.view).toMatchObject({
      surface: "attempt",
      layout: "single",
    });
  });
  test("共享材料分栏：题卡更多仍明确捕获目标题，不把材料当题", async ({
    browser,
    browserName,
  }) => {
    // 复用已有新内容专用环境；共享被测服务继续默认关闭新DSL。
    const pair = await startQmPair(
      browserName === "webkit"
        ? { serverPort: 18892, webPort: 15192 }
        : { serverPort: 18891, webPort: 15191 },
    );
    const api = await qmApi(pair);
    const context = await browser.newContext({
      ...devices["iPad (gen 7)"],
      baseURL: pair.webUrl,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    try {
      const e = await practice(page, api, true);
      await expect(
        page.getByText("共享阅读材料", { exact: true }).first(),
      ).toBeVisible();
      const memo = await save(
        page,
        await openCardMemo(page, 2),
        "材料组第二题",
      );
      expect(memo?.context?.content.questionId).toBe(e.questions[1]?.id);
      expect(memo?.context?.session).toMatchObject({
        questionRevisionId: e.questions[1]?.questionRevisionId,
        questionNo: 2,
        questionCount: 2,
      });
    } finally {
      await context.close();
      await api.dispose();
      stopQmPair();
    }
  });
  test("离线图片先本机保存完整旧引用，联网canonical补齐原版本", async ({
    page,
    request,
    context,
  }) => {
    const e = await practice(page, request);
    await context.setOffline(true);
    const dialog = await openCardMemo(page, 2);
    await dialog.getByLabel("随笔内容").fill("离线第二题图片");
    await dialog.getByLabel("选择或拍摄图片").setInputFiles({
      name: "source.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expect(dialog).toBeHidden();
    const stored = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((done, reject) => {
        const r = indexedDB.open("tutor-memos");
        r.onsuccess = () => done(r.result);
        r.onerror = () => reject(r.error);
      });
      const rows = await new Promise<unknown[]>((done, reject) => {
        const r = db.transaction("outbox").objectStore("outbox").getAll();
        r.onsuccess = () => done(r.result);
        r.onerror = () => reject(r.error);
      });
      db.close();
      return rows;
    });
    expect(stored).toEqual([
      expect.objectContaining({
        anchor: expect.objectContaining({ questionId: e.questions[1]?.id }),
        reference: expect.objectContaining({
          expectedQuestionRevisionId: e.questions[1]?.questionRevisionId,
        }),
        text: "离线第二题图片",
      }),
    ]);
    await context.setOffline(false);
    await expect
      .poll(
        async () =>
          memoListOkSchema
            .parse(await (await page.request.get("/api/student/memos")).json())
            .data.memos.find((m) => m.text === "离线第二题图片")?.context
            ?.session?.questionRevisionId,
      )
      .toBe(e.questions[1]?.questionRevisionId);
    const memo = memoListOkSchema.parse(
      await (await page.request.get("/api/student/memos")).json(),
    ).data.memos[0];
    expect(memo?.kind).toBe("image");
    expect(memo?.context?.session?.questionNo).toBe(2);
  });
  test("整卷菜单保留无题随笔，不借当前题伪造session", async ({
    page,
    request,
  }) => {
    await practice(page, request);
    await page.getByRole("button", { name: "练习更多" }).click();
    await page.getByRole("menuitem", { name: "随手记", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "随手记" });
    await expect(dialog.getByText(/^锚到：/)).toHaveCount(0);
    const memo = await save(page, dialog, "整卷无题随笔");
    expect(memo?.anchor).toEqual({ kind: "none" });
    expect(memo?.context).toBeNull();
  });
  test("未公布结果且DTO缺可选revision：canonical补真实版本，不能因记随笔泄露答案", async ({
    page,
    request,
  }) => {
    const e = await practice(page, request);
    const assigned = await request.post("/api/teacher/assignments", {
      data: {
        unitIds: [e.draft.units[0]?.id],
        studentIds: [e.student.id],
        title: `待公布${uniqueSuffix()}`,
        courseId: e.courseId,
        answerRelease: "after_due",
        dueAt: new Date(Date.now() + 86400000).toISOString(),
      },
    });
    expect(assigned.ok(), await assigned.text()).toBe(true);
    const assignmentId = assignmentCreateOkSchema.parse(await assigned.json())
      .data.assignments[0]?.id;
    const started = await page.request.post(
      `/api/student/assignments/${assignmentId}/attempt`,
    );
    const attemptId = attemptStartOkSchema.parse(await started.json()).data.id;
    const d = attemptDraftOkSchema.parse(
      await (
        await page.request.get(`/api/student/attempts/${attemptId}`)
      ).json(),
    ).data;
    const questions = d.units.flatMap((u) => u.questions);
    const submitted = await page.request.post(
      `/api/student/attempts/${attemptId}/submit`,
      {
        data: {
          revisions: questions.map((q) => ({
            questionId: q.id,
            questionRevisionId: q.questionRevisionId,
            expectedAnswerRevision: d.draftRevisions?.[q.id] ?? 0,
          })),
        },
      },
    );
    expect(submitted.ok(), await submitted.text()).toBe(true);
    expect(
      attemptResultOkSchema.parse(await submitted.json()).data.answersReleased,
    ).toBe(false);
    await page.route(`**/api/student/attempts/${attemptId}`, async (route) => {
      const r = await route.fetch();
      const body = attemptResultOkSchema.parse(await r.json());
      for (const unit of body.data.units)
        for (const q of unit.questions) delete q.questionRevisionId;
      await route.fulfill({ response: r, json: body });
    });
    await page.goto(`/s/attempts/${attemptId}`);
    await card(page, 2)
      .getByRole("button", { name: "更多", exact: true })
      .click();
    const memo = await save(
      page,
      await openCardMemo(page, 2, true),
      "待公布结果第二题",
    );
    expect(memo?.context?.session).toMatchObject({
      questionRevisionId: questions[1]?.questionRevisionId,
      questionNo: 2,
      questionCount: 2,
      settlementSeq: 1,
    });
    expect(memo?.context?.view?.surface).toBe("result");
    // 先明确记录了第二题，再从整卷两种布局入口保存；都不得继承题坐标。
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("button", { name: "随手记", exact: true }).click();
    const wide = await save(
      page,
      page.getByRole("dialog", { name: "随手记" }),
      "结果宽屏整卷无题",
    );
    expect(wide?.anchor).toEqual({ kind: "none" });
    expect(wide?.context).toBeNull();
    await page.setViewportSize({ width: 600, height: 1000 });
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "随手记", exact: true }).click();
    const narrow = await save(
      page,
      page.getByRole("dialog", { name: "随手记" }),
      "结果窄屏整卷无题",
    );
    expect(narrow?.anchor).toEqual({ kind: "none" });
    expect(narrow?.context).toBeNull();
    const restricted = attemptResultOkSchema.parse(
      await (
        await page.request.get(`/api/student/attempts/${attemptId}`)
      ).json(),
    ).data;
    expect(restricted.answersReleased).toBe(false);
    expect(
      restricted.units
        .flatMap((u) => u.questions)
        .map((q) => ({
          answers: q.answers,
          solutionMd: q.solutionMd,
          autoCorrect: q.autoCorrect,
        })),
    ).toEqual(
      questions.map(() => ({
        answers: null,
        solutionMd: null,
        autoCorrect: null,
      })),
    );
    expect(JSON.stringify(restricted)).not.toContain("[[正确]]");
    expect(JSON.stringify(restricted)).not.toContain("$(-3)+7=4$，故选 B。");
    const canonicalResponse = await page.request.post(
      "/api/student/learning-context/resolve",
      {
        data: {
          kind: "question",
          attemptId,
          questionId: questions[1]?.id,
          surface: "result",
        },
      },
    );
    expect(canonicalResponse.status()).toBe(200);
    const raw = await canonicalResponse.json();
    expect(raw).toEqual(learningContextOkSchema.parse(raw));
    expect(JSON.stringify(raw)).not.toMatch(
      /"(?:answers?|solutionMd|hints)"\s*:/,
    );
  });
  test("讲练草稿/当题released/整卷完成：来源固定且seq来自当前行", async ({
    page,
    request,
  }) => {
    await teacherApiLogin(request);
    const suffix = uniqueSuffix(),
      title = `来源讲练${suffix}`,
      unit = `讲练单元${suffix}`,
      courseId = await createCourseViaApi(request, `讲练课${suffix}`);
    const markdown = `---\nkind: lesson\nunit: ${unit}\n---\n\n# ${title}\n\n## 第一节\n\n::::question{id=${suffix}-q2 type=judge difficulty=1}\n第一张题卡。[[正确]]\n::::\n\n## 第二节\n\n::::question{id=${suffix}-q1 type=judge difficulty=1}\n第二张题卡。[[正确]]\n::::\n`;
    const imported = await request.post("/api/teacher/import/commit", {
      data: { markdown, filename: `${unit}.md`, courseId },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    const lectureId = importCommitOkSchema.parse(await imported.json()).data
      .lectures[0]?.id;
    const student = await prepareCourseStudent(
      request,
      courseId,
      `lesson-source-${suffix}`,
      "讲练来源同学",
    );
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await page.goto(`/s/lectures/${lectureId}/lesson?courseId=${courseId}`);
    const startedResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/lectures/${lectureId}/lesson/start`) &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: `开始练习 ${title}`, exact: true })
      .click();
    await page.waitForURL(/\/lesson\/run/);
    const startedLesson = lessonStartOkSchema.parse(
      await (await startedResponse).json(),
    ).data;
    const second = startedLesson.questions.find((q) => q.id === `${suffix}-q1`);
    if (!second) throw new Error("缺少真实讲练第二题DTO");
    await expect(card(page, 2)).toHaveAttribute(
      "data-learning-revision",
      second.questionRevisionId,
    );
    const draft = await save(
      page,
      await openCardMemo(page, 2),
      "讲练草稿第二题",
    );
    expect(draft?.context?.session).toMatchObject({
      questionNo: 2,
      questionCount: 2,
      settlementSeq: null,
    });
    expect(draft?.context?.content.questionId).toBe(`${suffix}-q1`);
    await card(page, 1)
      .getByRole("radio", { name: "对", exact: true })
      .locator("xpath=ancestor::label[1]")
      .click();
    await card(page, 1)
      .getByRole("button", { name: "显示答案", exact: true })
      .click();
    const released = await save(
      page,
      await openCardMemo(page, 1, true),
      "讲练当题已释放",
    );
    expect(released?.context?.session).toMatchObject({
      questionNo: 1,
      questionCount: 2,
      settlementSeq: null,
    });
    await card(page, 2)
      .getByRole("radio", { name: "对", exact: true })
      .locator("xpath=ancestor::label[1]")
      .click();
    await card(page, 2)
      .getByRole("button", { name: "显示答案", exact: true })
      .click();
    await expect(
      card(page, 2).getByRole("button", { name: "记随笔", exact: true }),
    ).toBeVisible();
    const complete = await save(
      page,
      await openCardMemo(page, 2, true),
      "讲练完成第二题",
    );
    expect(complete?.context?.session).toMatchObject({
      questionNo: 2,
      questionCount: 2,
      settlementSeq: 1,
    });
    expect(complete?.context?.session?.questionRevisionId).toBe(
      draft?.context?.session?.questionRevisionId,
    );
  });
  test("讲义明确选择B课程保存真实B来源，不把标题下标当稳定节id", async ({
    page,
    request,
  }) => {
    await teacherApiLogin(request);
    const suffix = uniqueSuffix(),
      title = `共用讲义${suffix}`,
      a = await createCourseViaApi(request, `A课${suffix}`),
      b = await createCourseViaApi(request, `B课${suffix}`);
    const imported = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: `---\nkind: lecture\n---\n\n# ${title}\n\n## 第一节\n\n真正的讲义正文。\n`,
        filename: `${title}.md`,
        courseId: a,
      },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    const lectureId = importCommitOkSchema.parse(await imported.json()).data
      .lectures[0]?.id;
    const added = await request.post(`/api/teacher/courses/${b}/items`, {
      data: { items: [{ kind: "lecture", refId: lectureId }], visible: true },
    });
    expect(added.ok(), await added.text()).toBe(true);
    const student = await prepareCourseStudent(
      request,
      a,
      `lecture-source-${suffix}`,
      "讲义来源同学",
    );
    await addCourseMemberViaApi(request, b, student.id);
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    await page.goto(`/s/lectures/${lectureId}?courseId=${b}`);
    await expect(
      page.locator("article").getByText(`课程：B课${suffix}`, { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "随手记", exact: true }).click();
    const memo = await save(
      page,
      page.getByRole("dialog", { name: "随手记" }),
      "B课讲义来源",
    );
    expect(memo?.context?.content).toMatchObject({
      courseId: b,
      lectureId,
      sectionId: null,
      questionId: null,
    });
    expect(memo?.context?.session).toBeNull();
    expect(memo?.context?.view?.surface).toBe("lecture");
    const canonical = await page.request.post(
      "/api/student/learning-context/resolve",
      { data: { kind: "lecture", lectureId, courseId: b } },
    );
    expect(canonical.ok()).toBe(true);
    expect(
      learningContextOkSchema.parse(await canonical.json()).data.content
        .courseId,
    ).toBe(b);
  });
});
