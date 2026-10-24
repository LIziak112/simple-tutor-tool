import { chromium, expect, test, webkit } from "@playwright/test";
import type { AnnotationViewData } from "../packages/contract/src/annotation";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test("跨内核原稿：WebKit 与 Chromium 互读同一云端圈画，排版不同仍可查看且不改写", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  if (!baseURL) throw new Error("缺少测试站点地址");
  const courseName = `跨端课程${suffix}`;
  const unitName = `跨端圈画${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  const imported = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: choiceJudgePracticeMarkdown(unitName),
      filename: `${unitName}.md`,
      courseId,
    },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  await setCourseItemVisible(request, courseId, unitName, true);
  const loginName = `cross-${suffix}`;
  await request.post("/api/teacher/students", {
    data: { displayName: "跨端生", loginName },
  });
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  const attemptId = await openChoicePractice(
    page,
    courseId,
    courseName,
    unitName,
  );
  const first = page.locator('article[aria-label="第 1 题"]');
  const questionId = await first.getAttribute("data-question-id");
  const viewPath = `/api/student/attempts/${attemptId}/questions/${encodeURIComponent(questionId ?? "")}/annotation`;
  await first.getByRole("button", { name: /圈画题干/ }).click();
  const canvas = first.locator('canvas[data-slot="annotation-canvas"]');
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  await drawStrokeWithPointerEvents(canvas);
  await page.getByRole("button", { name: "作答", exact: true }).click();
  await expect
    .poll(
      async () => {
        const response = await page.request.get(viewPath);
        return (await response.json()).data?.doc?.strokes?.length ?? 0;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const before = await (await page.request.get(viewPath)).json();

  // 每个项目的第二台设备使用另一内核，而不是同一 browser.newContext。
  const otherBrowser =
    testInfo.project.name === "chromium"
      ? await webkit.launch({ channel: "" })
      : await chromium.launch(
          process.env.CI ? { channel: "" } : { channel: "msedge" },
        );
  try {
    const context = await otherBrowser.newContext({
      baseURL,
      viewport: { width: 1280, height: 900 },
    });
    const other = await context.newPage();
    const leaks = attachLeakMonitor(other);
    let writes = 0;
    other.on("request", (req) => {
      if (
        req.url().includes("/annotation") &&
        ["POST", "PUT", "DELETE"].includes(req.method())
      )
        writes++;
    });
    await other.goto(`/s/${student.linkToken}`);
    await other.waitForURL("**/s/home");
    await other.goto(page.url());
    // 简单题可能在两个内核恰好排版相同；模拟新版设备样式，明确覆盖不兼容查看分支。
    await other.addStyleTag({
      content:
        '[data-slot="question-surface"] { letter-spacing: 0.25px !important; }',
    });
    const restored = other.locator('article[aria-label="第 1 题"]');
    await restored.getByRole("button", { name: /圈画题干/ }).click();
    const dialog = other.getByRole("dialog", { name: "第 1 题原圈画" });
    await expect(dialog).toBeVisible();
    const image = dialog.getByRole("img");
    const replay = dialog.locator(
      'canvas[data-slot="annotation-static-canvas"]',
    );
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        replay.evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          const data =
            canvas
              .getContext("2d")
              ?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
          let painted = 0;
          for (let i = 3; i < data.length; i += 4)
            if ((data[i] ?? 0) > 0) painted++;
          return painted;
        }),
      )
      .toBeGreaterThan(10);
    const picture = await image.boundingBox();
    const ink = await replay.boundingBox();
    expect(ink?.width).toBeCloseTo(picture?.width ?? 0, 0);
    expect(ink?.height).toBeCloseTo(picture?.height ?? 0, 0);
    await other.screenshot({
      path: testInfo.outputPath("cross-engine-original.png"),
    });
    await other.getByRole("button", { name: "关闭弹层" }).click();
    await expect(
      restored.getByRole("button", { name: /圈画题干/ }),
    ).toBeFocused();
    await expect(
      restored.locator('[data-slot="question-surface"]'),
    ).not.toHaveAttribute("inert", "");
    await expect(
      other.getByRole("toolbar", { name: /标画工具栏/ }),
    ).toHaveCount(0);
    const after = await (await other.request.get(viewPath)).json();
    expect(after).toEqual(before);
    expect(writes).toBe(0);
    expect(leaks.violations()).toEqual([]);
    const storageState = await context.storageState();
    await context.close();

    // 兼容缺少布局字段的历史响应；只改测试响应，不改写云端原稿。
    const legacyContext = await otherBrowser.newContext({
      baseURL,
      storageState,
    });
    const legacy = await legacyContext.newPage();
    await legacy.route(`**${viewPath}*`, async (route) => {
      const response = await route.fetch();
      const payload: { data: AnnotationViewData } = await response.json();
      if (payload.data.base) delete payload.data.base.layout;
      payload.data.maxWidthPx = 1440;
      await route.fulfill({ response, json: payload });
    });
    let failImage = true;
    await legacy.route("**/annotation-base/**/image.png", async (route) => {
      if (failImage) {
        failImage = false;
        await route.abort("failed");
      } else await route.continue();
    });
    await legacy.goto(page.url());
    await legacy
      .locator('article[aria-label="第 1 题"]')
      .getByRole("button", { name: /圈画题干/ })
      .click();
    const legacyDialog = legacy.getByRole("dialog", { name: "第 1 题原圈画" });
    await expect(legacyDialog).toBeVisible();
    await expect(legacyDialog.getByRole("alert")).toContainText("原稿已保留");
    await legacyDialog.getByRole("button", { name: "重新加载原圈画" }).click();
    await expect(legacyDialog.getByRole("img")).toBeVisible();
    await expect(legacyDialog.getByRole("alert")).toHaveCount(0);
    expect(await (await legacy.request.get(viewPath)).json()).toEqual(before);
    await legacyContext.close();
  } finally {
    await otherBrowser.close();
  }
});
