import { writeFile } from "node:fs/promises";
import { chromium, expect, test, webkit } from "@playwright/test";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  createStudentViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test(
  "v3 公开填空原稿承载唯一真实输入，缩放后槽位仍与保存框一致",
  {
    tag: ["@annotation"],
  },
  async ({ page, request, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    if (!baseURL) throw new Error("缺少测试站点地址");
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `原生题面${suffix}`;
    const unitName = `内联填空${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    expect(
      (
        await request.post("/api/teacher/import/commit", {
          data: {
            markdown: `---\nkind: practice\nunit: ${unitName}\n---\n\n::::question{type=fill difficulty=1}\n计算 $f'(x)$，结果是 [[2x]]。\n::::\n`,
            filename: `${unitName}.md`,
            courseId,
          },
        })
      ).ok(),
    ).toBe(true);
    await setCourseItemVisible(request, courseId, unitName, true);
    const loginName = `native-${suffix}`;
    await createStudentViaApi(request, "原生填空测试", loginName);
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);
    await page.goto(`/s/${student.linkToken}`);
    await page.waitForURL("**/s/home");
    // 在首次题面挂载前引入非整数高度，检查 PNG 向上取整像素后仍与墨层同框。
    await page.addStyleTag({
      content:
        '[data-slot="question-surface"] { padding-bottom: 0.21875px !important; }',
    });
    const attemptId = await openChoicePractice(
      page,
      courseId,
      courseName,
      unitName,
      1,
    );
    const card = page.locator('article[aria-label="第 1 题"]');
    const questionId = await card.getAttribute("data-question-id");
    const viewPath = `/api/student/attempts/${attemptId}/questions/${encodeURIComponent(questionId ?? "")}/annotation`;
    const input = card.getByRole("textbox", { name: "第1空" });
    await expect(input).toHaveCount(1);
    await input.fill("自己的答案");
    await card.getByRole("button", { name: /圈画题干/ }).click();
    const image = card.getByRole("img", { name: "第 1 题冻结原稿" });
    await expect(image).toBeVisible();
    const canvas = card.locator('canvas[data-slot="annotation-canvas"]');
    await expect(canvas).toHaveAttribute("data-input-enabled", "true");
    await expect(input).toHaveCount(1);
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue("自己的答案");
    // 空原稿预备只在本机保存；首笔才建立云端 ready 底图。
    await drawStrokeWithPointerEvents(canvas);
    await expect
      .poll(
        async () =>
          (await (await page.request.get(viewPath)).json()).data.base?.state ??
          null,
      )
      .toBe("ready");
    const before = (await (await page.request.get(viewPath)).json()).data;
    expect(before.base.layout.renderVersion).toBe(3);
    expect(before.base.layout.controls).toHaveLength(1);
    expect(before.base.layout.cssHeight % 1).toBeGreaterThan(0);
    expect(before.base.pixelHeight).toBe(
      Math.ceil(before.base.layout.cssHeight * before.base.layout.pixelRatio),
    );
    const surfaceGeometry = await card.evaluate((article) => {
      const image = article.querySelector(
        '[data-slot="annotation-frozen-surface"] img',
      );
      const ink = article.querySelector(
        'canvas[data-slot="annotation-canvas"]',
      );
      if (
        !(image instanceof HTMLImageElement) ||
        !(ink instanceof HTMLCanvasElement)
      )
        throw new Error("缺少原稿或墨层");
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      return { image: box(image), ink: box(ink) };
    });
    for (const key of ["x", "y", "width", "height"] as const)
      expect(surfaceGeometry.image[key]).toBeCloseTo(
        surfaceGeometry.ink[key],
        2,
      );
    const slot = before.base.layout.controls[0];

    // 容器缩到保存逻辑宽的约 0.9，验真实 DOM 命中框和原稿坐标映射。
    await page.addStyleTag({
      content: `article[aria-label="第 1 题"] [data-slot="annotated-question"] { max-width: ${before.base.layout.cssWidth * 0.9}px !important; }`,
    });
    const frame = card.locator('[data-slot="annotation-logical-frame"]');
    await expect
      .poll(async () =>
        Number(await frame.getAttribute("data-annotation-scale")),
      )
      .toBeLessThan(1);
    const scale = Number(await frame.getAttribute("data-annotation-scale"));
    expect(scale).toBeGreaterThan(0.85);
    const frameBox = await frame.boundingBox();
    const inputBox = await input.boundingBox();
    if (!frameBox || !inputBox) throw new Error("冻结槽位未出现在屏幕上");
    expect(inputBox.x).toBeCloseTo(frameBox.x + slot.x * scale, 0);
    expect(inputBox.y).toBeCloseTo(frameBox.y + slot.y * scale, 0);
    expect(inputBox.width).toBeCloseTo(slot.width * scale, 0);
    expect(inputBox.height).toBeCloseTo(slot.height * scale, 0);
    expect(inputBox.height).toBeLessThan(44);
    await writeFile(
      testInfo.outputPath("fill-geometry.json"),
      JSON.stringify({ scale, slot, frameBox, inputBox }, null, 2),
    );
    await expect(card.getByRole("button", { name: "放大题面" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("v3-fill-fit.png") });
    await card.getByRole("button", { name: "放大题面" }).click();
    await expect(frame).toHaveAttribute("data-annotation-scale", "1");
    const expandedBox = await input.boundingBox();
    if (!expandedBox) throw new Error("放大后填空槽位不可见");
    expect(expandedBox.height).toBeGreaterThanOrEqual(44);
    await expect(image).toBeVisible();
    await expect(input).toBeEditable();
    await expect(input).toHaveCount(1);
    await input.fill("修改后的答案");
    await expect(input).toHaveValue("修改后的答案");
    await page.screenshot({
      path: testInfo.outputPath("v3-fill-original.png"),
    });
    await card.getByRole("button", { name: /圈画题干/ }).click();
    await expect(canvas).toHaveAttribute("data-input-enabled", "true");
    await drawStrokeWithPointerEvents(canvas);
    await page.getByRole("button", { name: "作答", exact: true }).click();
    await expect(input).toBeEditable();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(viewPath)).json()).data.doc?.strokes
            ?.length ?? 0,
      )
      .toBe(2);
    const after = (await (await page.request.get(viewPath)).json()).data;
    expect(after.base).toEqual(before.base);
    await expect(page.getByText("全部已保存", { exact: true })).toBeVisible();
    const reloadEvents: string[] = [];
    page.on("pageerror", (error) =>
      reloadEvents.push(`pageerror ${error.message}`),
    );
    page.on("requestfailed", (request) =>
      reloadEvents.push(
        `failed ${request.url()} ${request.failure()?.errorText}`,
      ),
    );
    page.on("response", (response) => {
      if (response.url().includes(`/api/student/attempts/${attemptId}`))
        reloadEvents.push(`response ${response.status()} ${response.url()}`);
    });
    await page.reload();
    try {
      await expect(
        card.getByRole("img", { name: "第 1 题冻结原稿" }),
      ).toBeVisible();
    } catch (error) {
      const probe = await page.request
        .get(`/api/student/attempts/${attemptId}`, { timeout: 10_000 })
        .then((response) => response.status())
        .catch((cause: unknown) => String(cause));
      console.log(
        "native reload diagnostic",
        JSON.stringify({
          probe,
          reloadEvents,
          url: page.url(),
          body: await page.locator("body").innerText(),
        }),
      );
      throw error;
    }
    await expect(card.getByRole("textbox", { name: "第1空" })).toHaveValue(
      "修改后的答案",
    );
    expect((await (await page.request.get(viewPath)).json()).data.doc).toEqual(
      after.doc,
    );

    const otherBrowser =
      testInfo.project.name === "chromium"
        ? await webkit.launch({ channel: "", args: [] })
        : await chromium.launch({ channel: process.env.CI ? "" : "msedge" });
    try {
      const context = await otherBrowser.newContext({ baseURL });
      const other = await context.newPage();
      let annotationWrites = 0;
      other.on("request", (req) => {
        if (
          req.url().includes("/annotation") &&
          ["POST", "PUT", "DELETE"].includes(req.method())
        )
          annotationWrites++;
      });
      await other.goto(`/s/${student.linkToken}`);
      await other.waitForURL("**/s/home");
      await other.goto(page.url());
      const otherCard = other.locator('article[aria-label="第 1 题"]');
      const otherInput = otherCard.getByRole("textbox", { name: "第1空" });
      await expect(
        otherCard.getByRole("img", { name: "第 1 题冻结原稿" }),
      ).toBeVisible();
      await expect(otherInput).toHaveCount(1);
      await expect(otherInput).toHaveValue("修改后的答案");
      const otherFrame = otherCard.locator(
        '[data-slot="annotation-logical-frame"]',
      );
      const otherFrameBox = await otherFrame.boundingBox();
      const otherInputBox = await otherInput.boundingBox();
      if (!otherFrameBox || !otherInputBox)
        throw new Error("跨内核填空槽位不可见");
      const otherScale = Number(
        await otherFrame.getAttribute("data-annotation-scale"),
      );
      expect(otherInputBox.x).toBeCloseTo(
        otherFrameBox.x + slot.x * otherScale,
        0,
      );
      expect(otherInputBox.y).toBeCloseTo(
        otherFrameBox.y + slot.y * otherScale,
        0,
      );
      expect(otherInputBox.width).toBeCloseTo(slot.width * otherScale, 0);
      expect(otherInputBox.height).toBeCloseTo(slot.height * otherScale, 0);
      await writeFile(
        testInfo.outputPath("v3-fill-cross-geometry.json"),
        JSON.stringify(
          {
            scale: otherScale,
            slot,
            frameBox: otherFrameBox,
            inputBox: otherInputBox,
          },
          null,
          2,
        ),
      );
      expect((await (await other.request.get(viewPath)).json()).data).toEqual(
        after,
      );
      expect(annotationWrites).toBe(0);
      await other.screenshot({
        path: testInfo.outputPath("v3-fill-cross-engine.png"),
      });

      await otherCard.getByRole("button", { name: /圈画题干/ }).click();
      const otherCanvas = otherCard.locator(
        'canvas[data-slot="annotation-canvas"]',
      );
      await expect(otherCanvas).toHaveAttribute("data-input-enabled", "true");
      await expect(otherInput).toBeDisabled();
      await drawStrokeWithPointerEvents(otherCanvas);
      await other.getByRole("button", { name: "作答", exact: true }).click();
      await expect(otherInput).toBeEditable();
      await expect
        .poll(
          async () =>
            (await (await other.request.get(viewPath)).json()).data.doc?.strokes
              ?.length ?? 0,
        )
        .toBe(after.doc.strokes.length + 1);
      const continued = (await (await other.request.get(viewPath)).json()).data;
      expect(continued.base).toEqual(after.base);
      expect(continued.doc.strokes.slice(0, after.doc.strokes.length)).toEqual(
        after.doc.strokes,
      );
      await context.close();
    } finally {
      await otherBrowser.close();
    }
  },
);
