import { expect, test } from "@playwright/test";
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

test("两设备按题合并、同题裁决、离开设置后从云端恢复草稿与标画", async ({
  request,
  browser,
}, testInfo) => {
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
    await b.getByRole("button", { name: "采用云端版本", exact: true }).click();
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
    await a.getByRole("button", { name: "作答", exact: true }).click();
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
});
