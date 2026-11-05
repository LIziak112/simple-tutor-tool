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
    let after = (await (await page.request.get(viewPath)).json()).data;
    expect(after.base).toEqual(before.base);
    await expect(page.getByText("全部已保存", { exact: true })).toBeVisible();

    // 后台详情失败时仍有一笔正在输入；提示不能改变题面坐标或丢掉这一笔。
    await card.getByRole("button", { name: /圈画题干/ }).click();
    await expect(canvas).toHaveAttribute("data-input-enabled", "true");
    const beforeErrorBox = await canvas.boundingBox();
    if (!beforeErrorBox) throw new Error("后台失败前画布不可见");
    const held = await canvas.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const x = rect.left + rect.width / 3;
      const fire = (type: string, clientX: number, buttons: number) =>
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 23,
            pointerType: "pen",
            isPrimary: true,
            clientX,
            clientY: y,
            button: 0,
            buttons,
            pressure: 0.5,
          }),
        );
      fire("pointerdown", x, 1);
      fire("pointermove", x + 18, 1);
      return { x, y };
    });
    const detailPath = `/api/student/attempts/${attemptId}`;
    await page.route("**/api/student/attempts/**", async (route) => {
      const request = route.request();
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname === detailPath
      )
        await route.abort("failed");
      else await route.continue();
    });
    await expect(page.getByText("练习信息刷新失败")).toBeVisible({
      timeout: 25_000,
    });
    const afterErrorBox = await canvas.boundingBox();
    if (!afterErrorBox) throw new Error("后台失败后画布被卸载");
    for (const key of ["x", "y", "width", "height"] as const)
      expect(afterErrorBox[key]).toBeCloseTo(beforeErrorBox[key], 2);
    await page.screenshot({
      path: testInfo.outputPath("reload-warning-fixed.png"),
    });
    await canvas.evaluate((element, point) => {
      for (const [type, clientX, buttons] of [
        ["pointermove", point.x + 36, 1],
        ["pointerup", point.x + 36, 0],
      ] as const)
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 23,
            pointerType: "pen",
            isPrimary: true,
            clientX,
            clientY: point.y,
            button: 0,
            buttons,
            pressure: 0.5,
          }),
        );
    }, held);
    await page.unroute("**/api/student/attempts/**");
    await page.getByRole("button", { name: "重试读取" }).click();
    await expect(page.getByText("练习信息刷新失败")).toHaveCount(0);
    await page.getByRole("button", { name: "作答", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(viewPath)).json()).data.doc?.strokes
            ?.length ?? 0,
      )
      .toBe(after.doc.strokes.length + 1);
    const afterFailure = (await (await page.request.get(viewPath)).json()).data;
    expect(afterFailure.base).toEqual(after.base);
    expect(afterFailure.doc.strokes.slice(0, after.doc.strokes.length)).toEqual(
      after.doc.strokes,
    );
    const heldStroke = afterFailure.doc.strokes.at(-1);
    if (!heldStroke) throw new Error("后台失败期间的在途笔迹未保留");
    expect(heldStroke.points.length).toBeGreaterThanOrEqual(3);
    const xs = heldStroke.points.map((point: { x: number }) => point.x);
    const ys = heldStroke.points.map((point: { y: number }) => point.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(20);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2);
    after = afterFailure;

    await page.reload();
    await expect(
      card.getByRole("img", { name: "第 1 题冻结原稿" }),
    ).toBeVisible();
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
