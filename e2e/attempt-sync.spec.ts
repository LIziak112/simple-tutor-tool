import { expect, test } from "@playwright/test";
import type { AttemptDraftData } from "../packages/contract/src/index.ts";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  createStudentViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

for (const changed of [false, true]) {
  test(`清除旧卷后真实本机草稿${changed ? "版本变化保留原稿" : "版本一致自动恢复"}`, {
    tag: ["@student"],
  }, async ({ request, browser }) => {
    await teacherApiLogin(request);
    const name = `清除保稿${uniqueSuffix()}`;
    const courseId = await createCourseViaApi(request, name);
    const imported = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: choiceJudgePracticeMarkdown(name),
        filename: `${name}.md`,
        courseId,
      },
    });
    expect(imported.ok()).toBe(true);
    await setCourseItemVisible(request, courseId, name, true);
    await createStudentViaApi(request, name, name);
    const student = await getStudentViaApi(request, name);
    await addCourseMemberViaApi(request, courseId, student.id);
    const context = await browser.newContext();
    const page = await context.newPage();
    const nextId = "7ed12c70-f084-4d87-a93e-aa400cdef014";
    let cleared = false;
    let original: AttemptDraftData | undefined;
    try {
      // 只模拟清除前后API边界，本机仓、恢复编排、页面渲染和重载均走真实代码。
      await page.route(/\/api\/student\/attempts\/opened\?/, (route) =>
        route.fulfill({ json: { ok: true, data: { attempt: null } } }),
      );
      await page.route("**/api/student/attempts/*/activate", (route) =>
        cleared
          ? route.fulfill({
              json: {
                ok: true,
                data: {
                  attemptId: nextId,
                  activatedAt: "2026-11-14T00:00:00.000Z",
                  phase: "active",
                  frozenAt: "2026-11-14T00:00:00.000Z",
                },
              },
            })
          : route.abort(),
      );
      await page.route(/\/api\/student\/attempts\/[^/?]+$/, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        if (cleared) {
          if (!route.request().url().endsWith(nextId))
            return route.fulfill({
              status: 404,
              json: {
                ok: false,
                error: "ATTEMPT_NOT_FOUND",
                message: "练习已清除",
              },
            });
          if (!original) throw new Error("初始卷未读取");
          return route.fulfill({
            json: {
              ok: true,
              data: {
                ...original,
                attempt: { ...original.attempt, id: nextId },
                units: original.units.map((unit) => ({
                  ...unit,
                  questions: unit.questions.map((question) => ({
                    ...question,
                    questionRevisionId: `new-${question.id}`,
                    questionVersion: changed ? 2 : 1,
                  })),
                })),
              },
            },
          });
        }
        const response = await route.fetch();
        const body = (await response.json()) as { data: AttemptDraftData };
        original = {
          ...body.data,
          attempt: {
            ...body.data.attempt,
            phase: "opened",
            activatedAt: null,
            frozenAt: "2026-11-14T00:00:00.000Z",
          },
          units: body.data.units.map((unit) => ({
            ...unit,
            questions: unit.questions.map((question) => ({
              ...question,
              questionVersion: 1,
            })),
          })),
        };
        return route.fulfill({ response, json: { ok: true, data: original } });
      });
      await page.route(
        /\/api\/student\/courses\/[^/]+\/units\/[^/]+\/attempts$/,
        (route) =>
          cleared && original
            ? route.fulfill({
                json: { ok: true, data: { ...original.attempt, id: nextId } },
              })
            : route.continue(),
      );
      await page.route(`**/api/student/attempts/${nextId}/context`, (route) =>
        route.fulfill({
          json: {
            ok: true,
            data: { attemptId: nextId, materials: [], groups: [] },
          },
        }),
      );
      await page.route(`**/api/student/attempts/${nextId}/materials`, (route) =>
        route.fulfill({
          json: { ok: true, data: { notes: {}, annotations: {} } },
        }),
      );
      await page.route("**/answers/**", (route) =>
        cleared
          ? route.fulfill({
              json: {
                ok: true,
                data: { savedAt: "2026-11-14T00:00:00.000Z", revision: 1 },
              },
            })
          : route.abort(),
      );
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
      const oldId = await openChoicePractice(page, courseId, name, name);
      const answer = page
        .locator('article[aria-label="第 1 题"]')
        .getByRole("radio", { name: "对", exact: true });
      await answer.click();
      await expect(answer).toBeChecked();
      await page.evaluate(async (id) => {
        const moduleUrl = "/src/features/persistence/draft-store.ts";
        const { draftStore } = (await import(moduleUrl)) as {
          draftStore: { flush(id: string): Promise<void> };
        };
        await draftStore.flush(id);
      }, oldId);
      cleared = true;
      await page.reload();
      await page.waitForURL(`**/s/attempts/${nextId}`);
      if (changed) {
        await expect(page.getByText(/旧本机原稿已保留/)).toBeVisible();
        await expect(
          page.getByRole("button", { name: "下载本机原稿" }),
        ).toBeVisible();
        await expect(answer).not.toBeChecked();
      } else {
        await expect(page.getByText(/恢复版本一致的本机草稿/)).toBeVisible();
        await expect(answer).toBeChecked();
      }
      const preserved = await page.evaluate(async (id) => {
        const moduleUrl = "/src/features/persistence/draft-store.ts";
        const { draftStore } = (await import(moduleUrl)) as {
          draftStore: {
            loadDraft(
              id: string,
            ): Promise<{ answers: Record<string, { value?: boolean }> } | null>;
          };
        };
        return Object.values(
          (await draftStore.loadDraft(id))?.answers ?? {},
        ).some((entry) => entry.value === true);
      }, oldId);
      expect(preserved).toBe(true);
    } finally {
      await context.close();
    }
  });
}

test("同一浏览器两个标签页的离线答案都从 IndexedDB 恢复", {
  tag: ["@student"],
}, async ({ request, browser }) => {
  await teacherApiLogin(request);
  const name = `多标签保稿${uniqueSuffix()}`;
  const courseId = await createCourseViaApi(request, name);
  const imported = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: choiceJudgePracticeMarkdown(name),
      filename: `${name}.md`,
      courseId,
    },
  });
  expect(imported.ok()).toBe(true);
  await setCourseItemVisible(request, courseId, name, true);
  await createStudentViaApi(request, name, name);
  const student = await getStudentViaApi(request, name);
  await addCourseMemberViaApi(request, courseId, student.id);
  const context = await browser.newContext();
  try {
    const a = await context.newPage();
    await a.goto(`/s/${student.linkToken}`);
    await a.waitForURL("**/s/home");
    const attemptId = await openChoicePractice(a, courseId, name, name);
    const b = await context.newPage();
    await b.goto(`/s/attempts/${attemptId}`);
    await expect(a.getByTestId("draft-status")).toHaveText("全部已保存");
    await expect(b.getByTestId("draft-status")).toHaveText("全部已保存");
    // 保持详情读取可用，阻断答案上行，让两个标签页只能写本机。
    await context.route("**/answers/**", (route) => route.abort());
    const didAbortA = a.waitForEvent("requestfailed", (req) =>
      req.url().includes("/answers/"),
    );
    await a
      .locator('article[aria-label="第 1 题"]')
      .getByText("对", { exact: true })
      .click();
    await didAbortA;
    const didAbortB = b.waitForEvent("requestfailed", (req) =>
      req.url().includes("/answers/"),
    );
    await b
      .locator('article[aria-label="第 2 题"]')
      .getByRole("radio", { name: "选项 B" })
      .locator("xpath=ancestor::label[1]")
      .click();
    await didAbortB;
    await a.close();
    await b.close();
    const reopened = await context.newPage();
    await reopened.goto(`/s/attempts/${attemptId}`);
    await expect(
      reopened
        .locator('article[aria-label="第 1 题"]')
        .getByRole("radio", { name: "对", exact: true }),
    ).toBeChecked();
    await expect(
      reopened
        .locator('article[aria-label="第 2 题"]')
        .getByRole("radio", { name: "选项 B" }),
    ).toBeChecked();
  } finally {
    await context.close();
  }
});

test(
  "两设备按题合并、同题裁决、离开设置后从云端恢复草稿与标画",
  { tag: ["@student"] },
  async ({ request, browser }, testInfo) => {
    test.setTimeout(180_000);
    await teacherApiLogin(request);
    const name = `同步回归${uniqueSuffix()}`;
    const courseId = await createCourseViaApi(request, name);
    const imported = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: choiceJudgePracticeMarkdown(name),
        filename: `${name}.md`,
        courseId,
      },
    });
    expect(imported.ok()).toBe(true);
    await setCourseItemVisible(request, courseId, name, true);
    await createStudentViaApi(request, name, name);
    const student = await getStudentViaApi(request, name);
    await addCourseMemberViaApi(request, courseId, student.id);
    const desktop = await browser.newContext();
    const tablet = await browser.newContext();
    const a = await desktop.newPage();
    const b = await tablet.newPage();
    const leakA = attachLeakMonitor(a);
    const leakB = attachLeakMonitor(b);
    try {
      await a.goto(`/s/${student.linkToken}`);
      await a.waitForURL("**/s/home");
      const attemptId = await openChoicePractice(a, courseId, name, name);
      await b.goto(`/s/${student.linkToken}`);
      await b.waitForURL("**/s/home");
      await b.goto(`/s/attempts/${attemptId}`);
      await expect(a.getByTestId("draft-status")).toHaveText("全部已保存");
      await expect(b.getByTestId("draft-status")).toHaveText("全部已保存");
      const a1 = a.locator('article[aria-label="第 1 题"]');
      const b1 = b.locator('article[aria-label="第 1 题"]');
      const a2 = a.locator('article[aria-label="第 2 题"]');
      const b2 = b.locator('article[aria-label="第 2 题"]');
      // 第一设备临时断开答案上行，第二设备编辑另一题；恢复后保留并集。
      await a.route("**/answers/**", (route) => route.abort());
      await a1.getByText("对", { exact: true }).click();
      await b2
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(b.getByTestId("draft-status")).toHaveText("全部已保存");
      await a.unroute("**/answers/**");
      await a.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(a2.getByRole("radio", { name: "选项 B" })).toBeChecked({
        timeout: 30_000,
      });
      await expect(
        b1.getByRole("radio", { name: "对", exact: true }),
      ).toBeChecked({ timeout: 30_000 });
      // 同题不同内容必须出现选择；采用云端不改另一题。
      await b.route("**/answers/**", (route) => route.abort());
      await b2
        .getByRole("radio", { name: "选项 A" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await a2
        .getByRole("radio", { name: "选项 C" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(b.getByRole("region", { name: "同步冲突" })).toBeVisible({
        timeout: 30_000,
      });
      await b.unroute("**/answers/**");
      await b
        .getByRole("button", { name: "采用云端版本", exact: true })
        .click();
      await expect(b2.getByRole("radio", { name: "选项 C" })).toBeChecked();
      await expect(
        b1.getByRole("radio", { name: "对", exact: true }),
      ).toBeChecked();
      await expect(b.getByRole("region", { name: "同步冲突" })).toHaveCount(0);
      // 再次冲突选择当前设备，也只替换这一题；没有修改时不重复上传答案。
      await b.route("**/answers/**", (route) => route.abort());
      await b2
        .getByRole("radio", { name: "选项 A" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await a2
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(b.getByRole("region", { name: "同步冲突" })).toBeVisible({
        timeout: 30_000,
      });
      await b.unroute("**/answers/**");
      await b
        .getByRole("button", { name: "保留当前设备版本", exact: true })
        .click();
      await expect(a2.getByRole("radio", { name: "选项 A" })).toBeChecked({
        timeout: 30_000,
      });
      let repeatedWrites = 0;
      b.on("request", (req) => {
        if (req.method() === "PUT" && req.url().includes("/answers/"))
          repeatedWrites++;
      });
      await b.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(b.getByTestId("draft-status")).toHaveText("全部已保存");
      // 草稿与标画落到云端后，用没有旧稿的设备从记录地址重新进入。
      await a1
        .getByRole("button", { name: /草稿纸/ })
        .first()
        .click();
      const note = a1.locator(
        '[data-slot="note-paper"] canvas[data-slot="ink-canvas"]',
      );
      await expect(note).toBeVisible();
      await expect(a1.getByRole("link", { name: "手感设置" })).toHaveCount(0);
      await drawStrokeWithPointerEvents(note);
      await a1.getByRole("button", { name: /圈画题干/ }).click();
      const annotation = a1.locator('canvas[data-slot="annotation-canvas"]');
      await expect(annotation).toBeVisible();
      await expect(annotation).toHaveAttribute("data-input-enabled", "true");
      await drawStrokeWithPointerEvents(annotation);
      await expect(
        a1.getByRole("button", { name: /圈画题干.*已有 1 笔/ }),
      ).toBeVisible();
      await a.getByRole("button", { name: "完成标画", exact: true }).click();
      await expect(a.getByTestId("draft-status")).toHaveText("全部已保存", {
        timeout: 30_000,
      });
      await b.goto("/s/settings/ink-feel");
      await b.goto(`/s/attempts/${attemptId}?returnTo=%2Fs%2Frecords`);
      await expect(b.getByTestId("draft-status")).toHaveText("全部已保存", {
        timeout: 30_000,
      });
      await b1.getByRole("button", { name: /草稿纸（已有笔迹）/ }).click();
      await expect(b1.getByText(/1 笔/)).toBeVisible();
      await expect(
        b1.getByRole("button", { name: /圈画题干.*已有 1 笔/ }),
      ).toBeVisible();
      await expect(b2.getByRole("radio", { name: "选项 A" })).toBeChecked();
      expect(repeatedWrites).toBe(0);
      await b.screenshot({
        path: testInfo.outputPath("restored-from-cloud.png"),
      });
      expect(leakA.violations()).toEqual([]);
      expect(leakB.violations()).toEqual([]);
    } finally {
      await desktop.close();
      await tablet.close();
    }
  },
);
