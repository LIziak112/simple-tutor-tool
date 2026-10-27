import { test as baseTest, chromium, expect, webkit } from "@playwright/test";
import type { AnnotationViewData } from "../packages/contract/src/annotation";
import { annotationSurfaceLayoutCore } from "../packages/contract/src/annotation";
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

// 源设备也使用真实原生缩放，覆盖首次建稿后从无布局切到固定布局的过程。
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

for (const legacySource of [false, true]) {
  test(
    `跨内核原位续写：${legacySource ? "旧稿原设备核验升级" : "新稿"}双向增写、擦除、撤销与回读，真实排版变化保稿`,
    { tag: ["@annotation"] },
    async ({ page, request, baseURL }, testInfo) => {
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
      if (legacySource) {
        // 只在源设备模拟历史生成器：不写兼容证据，旧三个签名与 PNG 正常生成并上传。
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
      let before = await (await page.request.get(viewPath)).json();
      if (legacySource) {
        const legacyLayout = before.data.base.layout;
        expect(legacyLayout.compatibility).toBeUndefined();
        await first.getByRole("button", { name: /圈画题干/ }).click();
        await expect(canvas).toHaveAttribute("data-input-enabled", "true");
        await expect
          .poll(async () =>
            Boolean(
              (await (await page.request.get(viewPath)).json()).data.base.layout
                .compatibility,
            ),
          )
          .toBe(true);
        await page.getByRole("button", { name: "作答", exact: true }).click();
        const upgraded = await (await page.request.get(viewPath)).json();
        expect(annotationSurfaceLayoutCore(upgraded.data.base.layout)).toEqual(
          legacyLayout,
        );
        expect(upgraded.data.base.baseId).toBe(before.data.base.baseId);
        expect(upgraded.data.doc).toEqual(before.data.doc);
        expect(upgraded.data.annotation).toEqual(before.data.annotation);
        before = upgraded;
      }

      // 每个项目的第二台设备使用另一内核，而不是同一 browser.newContext。
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
        const resumedCanvas = resumed.locator(
          'canvas[data-slot="annotation-canvas"]',
        );
        // 原稿必须直接在题面恢复，且只有原来的作答控件。
        await expect(resumedCanvas)
          .toBeVisible()
          .catch(async (cause: unknown) => {
            const measured = await resumed
              .locator('[data-slot="question-surface"]')
              .evaluate(async (element) => {
                const moduleUrl =
                  "/src/features/annotation/question-base-image.tsx";
                const { measureQuestionSurface } = await import(moduleUrl);
                return measureQuestionSurface(element);
              });
            await testInfo.attach("inline-layout-diagnostic.json", {
              contentType: "application/json",
              body: Buffer.from(
                JSON.stringify(
                  { saved: before.data.base.layout, current: measured },
                  null,
                  2,
                ),
              ),
            });
            throw cause;
          });
        await expect(
          other.getByText("全部已保存", { exact: true }),
        ).toBeVisible();
        await resumed.getByRole("button", { name: /圈画题干/ }).click();
        await expect(resumedCanvas).toHaveAttribute(
          "data-input-enabled",
          "true",
        );
        await expect(other.getByRole("dialog")).toHaveCount(0);
        await expect(resumed.getByRole("radio")).toHaveCount(2);
        await drawStrokeWithPointerEvents(resumedCanvas);
        await expect(
          resumed.getByRole("button", { name: /圈画题干/ }),
        ).toHaveAttribute("aria-label", /已有 2 笔/);
        await other.getByRole("button", { name: "橡皮", exact: true }).click();
        await drawStrokeWithPointerEvents(resumedCanvas);
        await expect(
          resumed.getByRole("button", { name: /圈画题干/ }),
        ).not.toHaveAttribute("aria-label", /已有/);
        await other.getByRole("button", { name: "撤销", exact: true }).click();
        await expect(
          resumed.getByRole("button", { name: /圈画题干/ }),
        ).toHaveAttribute("aria-label", /已有 2 笔/);
        await other.getByRole("button", { name: "作答", exact: true }).click();
        await expect
          .poll(
            async () =>
              (await (await other.request.get(viewPath)).json()).data.doc
                .strokes.length,
            { timeout: 30_000 },
          )
          .toBe(before.data.doc.strokes.length + 1);
        const updated = await (await other.request.get(viewPath)).json();
        expect(updated.data.base.baseId).toBe(before.data.base.baseId);
        expect(updated.data.base.layout).toEqual(before.data.base.layout);
        expect(updated.data.doc.strokes[0]).toEqual(before.data.doc.strokes[0]);
        await other.reload();
        await expect(resumedCanvas).toBeVisible();
        await page.reload();
        await expect(
          first.locator('canvas[data-slot="annotation-canvas"]'),
        ).toBeVisible();
        expect(
          (await (await page.request.get(viewPath)).json()).data.doc,
        ).toEqual(updated.data.doc);
        before = updated;
        writes = 0;
        // 简单题可能在两个内核恰好排版相同；模拟新版设备样式，明确覆盖不兼容续画分支。
        await other.addStyleTag({
          content:
            '[data-slot="question-surface"] { letter-spacing: 0.25px !important; }',
        });
        const restored = other.locator('article[aria-label="第 1 题"]');
        await restored.getByRole("button", { name: /圈画题干/ }).click();
        if (legacySource) {
          // 旧稿无锚（兼容证据只有哈希，键表为空）：维持既有固定底图续画分支
          // （§5.4 表第 3 行）。
          // 布局不兼容且底图可读：不再自动弹只读弹窗，改为内联固定底图续画区块。
          await expect(other.getByRole("dialog")).toHaveCount(0);
          await expect(
            restored.getByText(/题面已固定为保存时的底图/),
          ).toBeVisible();
          // 原位画布在 45 秒保活窗口内仍留在 DOM（容器 hidden 不卸载），
          // 定位器必须收窄到续画容器，避免 strict mode 命中两张画布。
          const continuation = restored.locator(
            '[data-slot="annotation-continuation"]',
          );
          const continuationImage = continuation.getByRole("img", {
            name: /题干标注底图/,
          });
          const replay = continuation.locator(
            'canvas[data-slot="annotation-canvas"]',
          );
          await expect(continuationImage).toBeVisible();
          await expect(replay).toHaveAttribute("data-input-enabled", "true");
          await expect
            .poll(() =>
              replay.evaluate((element) => {
                const canvas = element as HTMLCanvasElement;
                const data =
                  canvas
                    .getContext("2d")
                    ?.getImageData(0, 0, canvas.width, canvas.height).data ??
                  [];
                let painted = 0;
                for (let i = 3; i < data.length; i += 4)
                  if ((data[i] ?? 0) > 0) painted++;
                return painted;
              }),
            )
            .toBeGreaterThan(10);
          await expect(async () => {
            const picture = await continuationImage.boundingBox();
            const ink = await replay.boundingBox();
            expect(ink?.width).toBeCloseTo(picture?.width ?? 0, 0);
            expect(ink?.height).toBeCloseTo(picture?.height ?? 0, 0);
          }).toPass();
          await other.screenshot({
            path: testInfo.outputPath("cross-engine-continuation.png"),
          });
          // 仅打开/收起续画区块不算写入：保稿断言（零写入、服务端原稿不变）。
          await restored
            .getByRole("button", { name: "收起固定底图圈画" })
            .click();
          await expect(
            restored.getByRole("button", { name: "在固定底图上圈画" }),
          ).toBeVisible();
          await expect(
            restored.locator('[data-slot="question-surface"]'),
          ).not.toHaveAttribute("inert", "");
          await expect(
            other.getByRole("toolbar", { name: /标画工具栏/ }),
          ).toHaveCount(0);
          const after = await (await other.request.get(viewPath)).json();
          expect(after).toEqual(before);
          expect(writes).toBe(0);
          // 续画一笔：笔迹落在保存底图坐标域并上传成功（baseId/布局不变、笔数 +1）。
          await restored
            .getByRole("button", { name: "在固定底图上圈画" })
            .click();
          await drawStrokeWithPointerEvents(replay);
          await expect
            .poll(
              async () =>
                (await (await other.request.get(viewPath)).json()).data.doc
                  .strokes.length,
              { timeout: 30_000 },
            )
            .toBe(before.data.doc.strokes.length + 1);
          const continued = await (await other.request.get(viewPath)).json();
          expect(continued.data.base.baseId).toBe(before.data.base.baseId);
          expect(continued.data.base.layout).toEqual(before.data.base.layout);
          expect(continued.data.doc.strokes[0]).toEqual(
            before.data.doc.strokes[0],
          );
          expect(writes).toBeGreaterThan(0);
          before = continued;
        } else {
          // LR-PR4 第二层（§5.4 近似原位）：新稿锚全在 + 双布局含键 +
          // 同一修订版 → 不再落续画区块，改为按节点重投影的原位编辑：徽标
          // 出现、原位画布可写，新笔反向映射回保存底图坐标域（baseId/布局
          // 不变、既有笔迹零改动），原设备回看原稿不变。
          await expect(restored.getByText(/已按内容对齐/)).toBeVisible();
          await expect(
            restored.getByText(/题面已固定为保存时的底图/),
          ).toHaveCount(0);
          await expect(
            restored.locator('[data-slot="question-annotation-overlay"]'),
          ).toHaveAttribute("data-annotation-approximate", "true");
          const approxCanvas = restored.locator(
            'canvas[data-slot="annotation-canvas"]',
          );
          await expect(approxCanvas).toHaveAttribute(
            "data-input-enabled",
            "true",
          );
          await expect(
            other.getByRole("toolbar", { name: /标画工具栏/ }),
          ).toBeVisible();
          await drawStrokeWithPointerEvents(approxCanvas);
          await expect
            .poll(
              async () =>
                (await (await other.request.get(viewPath)).json()).data.doc
                  .strokes.length,
              { timeout: 30_000 },
            )
            .toBe(before.data.doc.strokes.length + 1);
          const approximated = await (await other.request.get(viewPath)).json();
          expect(approximated.data.base.baseId).toBe(before.data.base.baseId);
          expect(approximated.data.base.layout).toEqual(
            before.data.base.layout,
          );
          expect(approximated.data.doc.strokes[0]).toEqual(
            before.data.doc.strokes[0],
          );
          expect(writes).toBeGreaterThan(0);
          // 原设备回看：原文档域语义（doc 相等）在第一台设备上原样成立
          await page.reload();
          await expect(
            first.locator('canvas[data-slot="annotation-canvas"]'),
          ).toBeVisible();
          expect(
            (await (await page.request.get(viewPath)).json()).data.doc,
          ).toEqual(approximated.data.doc);
          await other.screenshot({
            path: testInfo.outputPath("cross-engine-approximate.png"),
          });
          before = approximated;
        }
        expect(leaks.violations()).toEqual([]);
        const storageState = await context.storageState();

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
        // Windows WebKit 关闭最后一个页面后可能暂停动画帧；保持窗口并显式激活新页面。
        await legacy.bringToFront();
        await context.close();
        await legacy
          .locator('article[aria-label="第 1 题"]')
          .getByRole("button", { name: /圈画题干/ })
          .click();
        const legacyDialog = legacy.getByRole("dialog", {
          name: "第 1 题原圈画",
        });
        await expect(legacyDialog).toBeVisible();
        await expect(legacyDialog.getByRole("alert")).toContainText(
          "原稿已保留",
        );
        await legacyDialog
          .getByRole("button", { name: "重新加载原圈画" })
          .click();
        await expect(legacyDialog.getByRole("img")).toBeVisible();
        await expect(legacyDialog.getByRole("alert")).toHaveCount(0);
        expect(await (await legacy.request.get(viewPath)).json()).toEqual(
          before,
        );
        await legacyContext.close();
      } finally {
        await otherBrowser.close();
      }
    },
  );
}
