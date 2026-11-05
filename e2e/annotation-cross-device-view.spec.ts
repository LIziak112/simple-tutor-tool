import { createHash } from "node:crypto";
import { test as baseTest, chromium, expect, webkit } from "@playwright/test";
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

const test = baseTest.extend({
  launchOptions: [
    async ({ browserName, launchOptions }, use) => {
      await use(
        browserName === "chromium"
          ? {
              ...launchOptions,
              args: [
                ...(launchOptions.args ?? []),
                "--force-device-scale-factor=1.25",
              ],
            }
          : launchOptions,
      );
    },
    { scope: "worker" },
  ],
});

for (const withoutCompatibility of [false, true]) {
  test(
    `跨内核 v2 冻结原稿：${withoutCompatibility ? "旧稿无兼容证据" : "普通稿"}双向增写、擦除、撤销与零写入恢复`,
    { tag: ["@annotation"] },
    async ({ page, request, baseURL }, testInfo) => {
      test.setTimeout(180_000);
      if (!baseURL) throw new Error("缺少测试站点地址");
      await teacherApiLogin(request);
      const suffix = uniqueSuffix();
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
      if (withoutCompatibility) {
        // 历史 v2 生成器缺兼容证据；服务端仍保留原 PNG、布局与正文。
        await page.route(
          "**/src/features/annotation/question-base-image.tsx*",
          async (route) => {
            const response = await route.fetch();
            const body = (await response.text()).replace(
              "const fontCss =",
              "delete layout.compatibility;\nconst fontCss =",
            );
            await route.fulfill({ response, body });
          },
        );
      }
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
      const readView = async () =>
        (await (await page.request.get(viewPath)).json()).data;
      const pngHash = async (url: string) =>
        createHash("sha256")
          .update(await (await page.request.get(url)).body())
          .digest("hex");

      await first.getByRole("button", { name: /圈画题干/ }).click();
      const canvas = first.locator('canvas[data-slot="annotation-canvas"]');
      await expect(canvas).toHaveAttribute("data-input-enabled", "true");
      await drawStrokeWithPointerEvents(canvas);
      await page.getByRole("button", { name: "作答", exact: true }).click();
      await expect
        .poll(async () => (await readView()).doc?.strokes?.length ?? 0)
        .toBe(1);
      const before = await readView();
      expect(before.base.layout.renderVersion).toBe(2);
      if (withoutCompatibility)
        expect(before.base.layout.compatibility).toBeUndefined();
      const originalPngHash = await pngHash(before.base.downloadUrl);

      // 每个项目的第二台设备为另一浏览器内核。
      const otherBrowser =
        testInfo.project.name === "chromium"
          ? await webkit.launch({ channel: "", args: [] })
          : await chromium.launch({
              channel: process.env.CI ? "" : "msedge",
              args: ["--force-device-scale-factor=1.25"],
            });
      try {
        const context = await otherBrowser.newContext({
          baseURL,
          viewport: { width: 1280, height: 900 },
          deviceScaleFactor: 1.25,
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
        const resumed = other.locator('article[aria-label="第 1 题"]');
        const image = resumed.getByRole("img", { name: "第 1 题冻结原稿" });
        const resumedCanvas = resumed.locator(
          'canvas[data-slot="annotation-canvas"]',
        );
        await expect(image).toBeVisible();
        await expect(resumedCanvas).toBeVisible();
        await expect(resumed.getByRole("radio")).toHaveCount(0);
        await expect(other.getByRole("dialog")).toHaveCount(0);
        expect((await (await other.request.get(viewPath)).json()).data).toEqual(
          before,
        );
        expect(await pngHash(before.base.downloadUrl)).toBe(originalPngHash);
        expect(writes).toBe(0);

        await other.addStyleTag({
          content:
            '[data-slot="question-surface"] * { font-family: monospace !important; letter-spacing: 3px !important; }',
        });
        await resumed.getByRole("button", { name: "进入作答" }).click();
        await expect(resumed.getByRole("radio")).toHaveCount(2);
        expect(
          await resumed
            .locator('[data-slot="question-surface"] p')
            .first()
            .evaluate((node) => getComputedStyle(node).letterSpacing),
        ).toBe("3px");
        await resumed.getByRole("button", { name: "返回原稿" }).click();
        await expect(image).toBeVisible();
        expect((await (await other.request.get(viewPath)).json()).data).toEqual(
          before,
        );
        expect(writes).toBe(0);
        await other.screenshot({
          path: testInfo.outputPath("v2-frozen-original.png"),
        });

        await resumed.getByRole("button", { name: /圈画题干/ }).click();
        await expect(resumedCanvas).toHaveAttribute(
          "data-input-enabled",
          "true",
        );
        await drawStrokeWithPointerEvents(resumedCanvas);
        await other.getByRole("button", { name: "橡皮", exact: true }).click();
        await drawStrokeWithPointerEvents(resumedCanvas);
        await other.getByRole("button", { name: "撤销", exact: true }).click();
        await other.getByRole("button", { name: "作答", exact: true }).click();
        await expect
          .poll(
            async () =>
              (await (await other.request.get(viewPath)).json()).data.doc
                ?.strokes?.length ?? 0,
          )
          .toBe(before.doc.strokes.length + 1);
        const updated = (await (await other.request.get(viewPath)).json()).data;
        expect(updated.base).toEqual(before.base);
        expect(updated.doc.strokes[0]).toEqual(before.doc.strokes[0]);
        expect(await pngHash(updated.base.downloadUrl)).toBe(originalPngHash);

        writes = 0;
        await other.reload();
        await expect(image).toBeVisible();
        await page.reload();
        await expect(
          first.getByRole("img", { name: "第 1 题冻结原稿" }),
        ).toBeVisible();
        expect(await readView()).toEqual(updated);
        expect(writes).toBe(0);
        expect(leaks.violations()).toEqual([]);
        await context.close();
      } finally {
        await otherBrowser.close();
      }
    },
  );
}
