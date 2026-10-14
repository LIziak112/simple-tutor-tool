import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
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

test("原位标画：不复制题面、退出一击作答、切题唯一输入、重排不拉伸", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `原位课程${suffix}`;
  const unitName = `原位练习${suffix}`;
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
  const loginName = `inline-${suffix}`;
  await request.post("/api/teacher/students", {
    data: { displayName: "原位测试生", loginName },
  });
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  const leak = attachLeakMonitor(page);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await openChoicePractice(page, courseId, courseName, unitName);
  await page.setViewportSize({ width: 1300, height: 1000 });
  const first = page.locator('article[aria-label="第 1 题"]');
  const second = page.locator('article[aria-label="第 2 题"]');
  const before = await first
    .locator('[data-slot="question-surface"]')
    .boundingBox();
  await first.getByRole("button", { name: /圈画题干/ }).click();
  await expect(
    page.getByRole("toolbar", { name: "第 1 题标画工具栏" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(first.locator('[data-slot="question-surface"]')).toHaveAttribute(
    "inert",
    "",
  );
  await expect(first.locator('[data-slot="annotation-workspace"]')).toHaveCount(
    0,
  );
  await expect(first.locator('[data-slot="question-surface"]')).toHaveCount(1);
  const after = await first
    .locator('[data-slot="question-surface"]')
    .boundingBox();
  expect(after?.width).toBeCloseTo(before?.width ?? 0, 0);
  expect(after?.height).toBeCloseTo(before?.height ?? 0, 0);
  expect(after?.x).toBeCloseTo(before?.x ?? 0, 0);
  expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
  const canvas = first.locator('canvas[data-slot="annotation-canvas"]');
  await drawStrokeWithPointerEvents(canvas);
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const data =
          canvas
            .getContext("2d")
            ?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
        let painted = 0;
        for (let index = 3; index < data.length; index += 4)
          if ((data[index] ?? 0) > 0) painted++;
        return painted;
      }),
    )
    .toBeGreaterThan(10);
  await page.screenshot({ path: testInfo.outputPath("inline-drawing.png") });
  await page.getByRole("button", { name: "作答", exact: true }).click();
  await expect(
    first.locator('[data-slot="question-surface"]'),
  ).not.toHaveAttribute("inert", "");
  await first.getByText("错", { exact: true }).click();
  await expect(
    first.getByRole("radio", { name: "错", exact: true }),
  ).toBeChecked();
  await expect(canvas).toBeVisible();
  await first.getByRole("button", { name: "第 1 题更多" }).click();
  await page.getByRole("menuitem", { name: "导出本题" }).click();
  const preview = page.getByRole("img", { name: "本题导出预览" });
  await expect(preview).toBeVisible();
  const exported = await preview.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法读取导出像素");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    let black = 0;
    let minX = canvas.width;
    let maxX = 0;
    let minY = canvas.height;
    let maxY = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (
        (pixels[i] ?? 0) > 150 &&
        (pixels[i + 1] ?? 0) < 100 &&
        (pixels[i + 2] ?? 0) < 100
      ) {
        red++;
        const pixel = i / 4;
        minX = Math.min(minX, pixel % canvas.width);
        maxX = Math.max(maxX, pixel % canvas.width);
        minY = Math.min(minY, Math.floor(pixel / canvas.width));
        maxY = Math.max(maxY, Math.floor(pixel / canvas.width));
      }
      if (
        (pixels[i] ?? 0) < 100 &&
        (pixels[i + 1] ?? 0) < 100 &&
        (pixels[i + 2] ?? 0) < 100
      )
        black++;
    }
    const bytes = Array.from(
      new Uint8Array(await (await fetch(image.src)).arrayBuffer()),
    );
    return {
      width: canvas.width,
      height: canvas.height,
      red,
      black,
      bytes,
      bounds: [minX, maxX, minY, maxY],
    };
  });
  const dimensions = await canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });
  expect(exported.width).toBe(1048);
  expect(exported.height).toBeLessThanOrEqual(4096);
  expect(exported.red).toBeGreaterThan(10);
  expect(exported.black).toBeGreaterThan(10);
  const overlayBounds = await canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels =
      canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height)
        .data ?? [];
    let minX = canvas.width,
      maxX = 0,
      minY = canvas.height,
      maxY = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (
        (pixels[i] ?? 0) > 150 &&
        (pixels[i + 1] ?? 0) < 100 &&
        (pixels[i + 2] ?? 0) < 100 &&
        (pixels[i + 3] ?? 0) > 128
      ) {
        const pixel = i / 4;
        minX = Math.min(minX, pixel % canvas.width);
        maxX = Math.max(maxX, pixel % canvas.width);
        minY = Math.min(minY, Math.floor(pixel / canvas.width));
        maxY = Math.max(maxY, Math.floor(pixel / canvas.width));
      }
    }
    return [minX, maxX, minY, maxY];
  });
  for (let i = 0; i < overlayBounds.length; i++)
    expect(
      Math.abs(
        (overlayBounds[i] ?? 0) *
          Math.min(1, 1000 / dimensions.width, 2400 / dimensions.height) +
          (i < 2
            ? 24 +
              (1000 -
                Math.ceil(
                  dimensions.width *
                    Math.min(
                      1,
                      1000 / dimensions.width,
                      2400 / dimensions.height,
                    ),
                )) /
                2
            : 84) -
          (exported.bounds[i] ?? 0),
      ),
    ).toBeLessThanOrEqual(2);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载图片" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("第1题-作答材料.png");
  const path = testInfo.outputPath("ongoing-annotation.png");
  await download.saveAs(path);
  expect(await readFile(path)).toEqual(Buffer.from(exported.bytes));
  await page.screenshot({
    path: testInfo.outputPath("ongoing-annotation-preview.png"),
  });
  await page.getByRole("button", { name: "关闭弹层" }).click();
  await page.reload();
  await expect(
    first.locator('canvas[data-slot="annotation-canvas"]'),
  ).toBeVisible();
  await expect(page.getByRole("toolbar", { name: /标画工具栏/ })).toHaveCount(
    0,
  );
  await expect(
    first.locator('[data-slot="question-surface"]'),
  ).not.toHaveAttribute("inert", "");
  await first.getByRole("button", { name: "第 1 题更多" }).click();
  await page.getByRole("menuitem", { name: "隐藏标画" }).click();
  await expect(canvas).toBeHidden();
  await first.getByRole("button", { name: /圈画题干/ }).click();
  await expect(canvas).toBeVisible();
  await second.getByRole("button", { name: /圈画题干/ }).click();
  await expect(
    page.getByRole("toolbar", { name: "第 2 题标画工具栏" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('canvas[data-input-enabled="true"]')).toHaveCount(
    1,
  );
  await expect(
    first.locator('[data-slot="question-surface"]'),
  ).not.toHaveAttribute("inert", "");
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.getByRole("toolbar", { name: /标画工具栏/ })).toHaveCount(
    0,
  );
  await expect(page.locator('canvas[data-input-enabled="true"]')).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 810, height: 1080 });
  await second.getByRole("button", { name: /圈画题干/ }).click();
  await expect(
    page.getByRole("toolbar", { name: "第 2 题标画工具栏" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("toolbar", { name: /标画工具栏/ })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(first.getByRole("button", { name: "查看原标画" })).toBeVisible();
  await expect(canvas).toBeHidden();
  await second
    .getByRole("radio", { name: "选项 B" })
    .locator("xpath=ancestor::label[1]")
    .click();
  await expect(second.getByRole("radio", { name: "选项 B" })).toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath("inline-layout-fallback.png"),
  });
  await first.getByRole("button", { name: "查看原标画" }).click();
  await first.getByRole("button", { name: "编辑原标画" }).click();
  const toolbar = page.getByRole("toolbar", { name: "第 1 题标画工具栏" });
  await expect(toolbar).toBeVisible();
  for (const button of await toolbar.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
  }
  await page.screenshot({
    path: testInfo.outputPath("inline-original-320.png"),
  });
  await page.getByRole("button", { name: "作答", exact: true }).click();
  // 已缓存底图可离线导出；未上传的新笔迹必须显式确认，交卷不删除本机稿。
  let blockedUploads = 0;
  await page.route(
    /\/api\/student\/attempts\/[^/]+\/questions\/[^/]+\/annotation$/,
    async (route) => {
      if (route.request().method() === "PUT") {
        blockedUploads += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: "TEST_OFFLINE",
            message: "测试网络故障",
          }),
        });
      } else await route.continue();
    },
  );
  await first.getByRole("button", { name: "编辑原标画" }).click();
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  await drawStrokeWithPointerEvents(canvas);
  await page.getByRole("button", { name: "作答", exact: true }).click();
  await expect(
    first.getByRole("button", { name: /圈画题干.*已有 2 笔/ }),
  ).toBeVisible();
  await expect.poll(() => blockedUploads).toBeGreaterThan(0);
  await first.getByRole("button", { name: "第 1 题更多" }).click();
  await page.getByRole("menuitem", { name: "导出本题" }).click();
  await expect(page.getByRole("img", { name: "本题导出预览" })).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async () => {
          throw new DOMException("测试权限拒绝", "NotAllowedError");
        },
      },
    }),
  );
  await page.getByRole("button", { name: "复制图片" }).click();
  await expect(page.getByText("复制失败，请下载图片")).toBeVisible();
  await expect(page.getByRole("button", { name: "下载图片" })).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("ongoing-annotation-320.png"),
  });
  await page.getByRole("button", { name: "关闭弹层" }).click();
  await page.getByRole("button", { name: "交卷", exact: true }).click();
  await page.getByRole("button", { name: "确认交卷", exact: true }).click();
  await expect(page.getByText(/标画尚未上传完整/)).toBeVisible();
  const beforeSubmitUrl = page.url();
  await page
    .getByRole("button", { name: "仅交答案，未保存材料留在本机" })
    .click();
  await expect(page.getByText(/批改结果/).first()).toBeVisible();
  const attemptId = beforeSubmitUrl.split("/").pop();
  expect(
    await page.evaluate(
      async ({ attemptId, studentId }) =>
        new Promise<boolean>((resolve, reject) => {
          const open = indexedDB.open("tutor-annotations");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const transaction = db.transaction("annotations", "readonly");
            const store = transaction.objectStore("annotations");
            const records = store.getAll();
            const keys = store.getAllKeys();
            transaction.oncomplete = () => {
              const kept = keys.result.some((key, index) => {
                const parts: unknown = JSON.parse(String(key));
                const record = records.result[index] as
                  | { pending?: unknown; doc?: { strokes?: unknown[] } }
                  | undefined;
                return (
                  Array.isArray(parts) &&
                  parts[2] === studentId &&
                  parts[3] === attemptId &&
                  record?.pending != null &&
                  (record.doc?.strokes?.length ?? 0) >= 2
                );
              });
              db.close();
              resolve(kept);
            };
            transaction.onerror = () => {
              db.close();
              reject(transaction.error);
            };
          };
        }),
      { attemptId, studentId: student.id },
    ),
  ).toBe(true);
  expect(leak.violations()).toEqual([]);
});
