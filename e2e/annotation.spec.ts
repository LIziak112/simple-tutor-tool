import { devices, expect, test } from "@playwright/test";
import { pngSize } from "../apps/server/src/lib/png";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * T6R.20 题干标注 E2E（真实浏览器全链——底图栅格化/坐标锚定/交卷封存/
 * 教师回看；jsdom 单测只覆盖注入依赖的失败语义）：
 * - 学生链：开标注 → **真实栅格化底图**（html-to-image 在真浏览器的端到端，
 *   pngSize 校验：可解码 + 宽恒 1440）→ 落笔 → 保存上传（PUT annotation）→
 *   **旋转/resize 后画布元素尺寸跟随底图 img 等比**（两视口断言）且 GET
 *   回读 doc 内容不变（旧圈不漂移）→ 交卷（flush→seal）→ sealed 后 UI 只读
 *   （scratch 无工具条，订正另开）→ 教师回看视图可见；
 * - 订正链：结果页开订正标注（phase=correction 新记录），旧 scratch 标注
 *   GET 回读不变；「保存订正标注」检查点 → sealed 固定态（审查修复 3①）；
 *   教师详情卡切「订正标注」阶段可见订正圈画（审查修复 3②）；
 * - 无底图链：超高题入口禁用文案（「该题禁用标注，草稿照用」类）；mock
 *   装配载荷 500 EXPORT_ASSEMBLY_BROKEN → 同禁用文案；
 * - 学生红线：泄露监控全程零告警（底图载荷只有学生 stem 投影）。
 */

/** 单题选择练习（题面带公式，圈画可辨识） */
function annotationPracticeMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 有理数混合运算",
    "---",
    "",
    '::::question{type=choice difficulty=1 knowledge="有理数混合运算"}',
    "计算 $(-2)^3+4\\times 3-6\\div 2$ 的结果，并选择正确选项。",
    "",
    "- [ ] $-8$",
    "- [x] $1$",
    "- [ ] $3$",
    "",
    ":::solution",
    "$(-2)^3=-8$，$4\\times 3=12$，$6\\div 2=3$，原式 $=-8+12-3=1$，故选 B。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

/** 超高题练习（题干约 30 段 → 内容高 > 1976 CSS 上限 → 显式禁用标注） */
function tooTallPracticeMarkdown(unitName: string): string {
  const lines: string[] = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 有理数混合运算",
    "---",
    "",
    '::::question{type=choice difficulty=2 knowledge="有理数混合运算"}',
    "阅读下面各段说明后作答。",
    "",
  ];
  for (let i = 1; i <= 30; i += 1) {
    lines.push(
      `说明第 ${i} 段：有理数混合运算的顺序是先乘除后加减，有括号先算括号内的部分；同级运算从左到右依次进行。本段说明用于把题干撑到超过标注底图的高度上限（共三十段，这是第 ${i} 段）。`,
      "",
    );
  }
  lines.push(
    "计算结果是（　）",
    "",
    "- [ ] $-8$",
    "- [x] $1$",
    "- [ ] $3$",
    "",
    ":::solution",
    "原式 $=1$，故选 B。",
    ":::",
    "::::",
    "",
  );
  return lines.join("\n");
}

/** 页面会话内 GET 标注视图（JSON；同源 Cookie 随行） */
async function fetchViewJson(
  page: import("@playwright/test").Page,
  attemptId: string,
  questionId: string,
  phase = "scratch",
): Promise<{ base: unknown; doc: unknown }> {
  return page.evaluate(
    async ({ attemptId, questionId, phase }) => {
      const res = await fetch(
        `/api/student/attempts/${attemptId}/questions/${questionId}/annotation?phase=${phase}`,
        { cache: "no-store" },
      );
      const body = (await res.json()) as { ok: boolean; data: unknown };
      if (!body.ok) throw new Error(`视图拉取失败 HTTP ${res.status}`);
      return body.data as { base: unknown; doc: unknown };
    },
    { attemptId, questionId, phase },
  );
}

/** 断言画布 CSS 盒与底图 img 同尺寸（等比锚定的 UI 侧投影） */
async function expectCanvasFollowsImage(
  page: import("@playwright/test").Page,
): Promise<{ width: number; height: number }> {
  const box = await page.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>(
      '[data-slot="annotation-base-wrap"]',
    );
    const img = wrap?.querySelector("img") ?? null;
    const canvas = wrap?.querySelector("canvas") ?? null;
    if (img === null || canvas === null) return null;
    const imgRect = img.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      imgW: imgRect.width,
      imgH: imgRect.height,
      canvasW: canvasRect.width,
      canvasH: canvasRect.height,
    };
  });
  expect(box).not.toBeNull();
  if (box === null) throw new Error("标注工作区未挂载");
  // 画布与底图 img 同 CSS 盒（同一 scale=displayWidth/baseWidth 变换）
  expect(box.canvasW).toBeCloseTo(box.imgW, 0);
  expect(box.canvasH).toBeCloseTo(box.imgH, 0);
  return { width: box.canvasW, height: box.canvasH };
}

test.describe("题干标注（T6R.20）", () => {
  test("学生全链：真实底图栅格化→落笔→resize 等比且内容不变→交卷封存→只读→教师回看", async ({
    request,
    browser,
  }) => {
    test.setTimeout(300_000);

    // —— 造数：专属课程 + 单题练习 + 学生 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e标注课程${suffix}`;
    const unitName = `标注练习${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: annotationPracticeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-anno-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e标注生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    // —— 学生作答（iPad 竖屏）——
    const studentContext = await browser.newContext(devices["iPad (gen 7)"]);
    const studentPage = await studentContext.newPage();
    let attemptId = "";
    try {
      const leak = attachLeakMonitor(studentPage);
      await studentPage.goto(`/s/${student.linkToken}`);
      await studentPage.waitForURL("**/s/home");

      attemptId = await openChoicePractice(
        studentPage,
        courseId,
        courseName,
        unitName,
        1,
      );
      const questionId = `${unitName}-1`;
      const card = studentPage.locator('article[aria-label="第 1 题"]');

      // —— 开标注：两阶段底图流（真实栅格化）——
      await card.getByRole("button", { name: /圈画题干/ }).click();
      const wrap = card.locator('[data-slot="annotation-base-wrap"]');
      const baseImg = wrap.locator("img");
      await expect(baseImg).toBeVisible({ timeout: 120_000 });
      const canvas = wrap.locator("canvas");
      await expect(canvas).toBeVisible();
      expect(attemptId).not.toBe("");

      // 底图 PNG 校验（pngSize 同 review-image-export 口径）：
      // 抓取真实加载的底图响应字节 → 魔数可解码 + 宽恒 1440
      const baseSrc = await baseImg.getAttribute("src");
      expect(baseSrc).toContain("/annotation-base/");
      const baseBytes = await studentPage.evaluate(async (url) => {
        const res = await fetch(url, { cache: "no-store" });
        return Array.from(new Uint8Array(await res.arrayBuffer()));
      }, baseSrc ?? "");
      const size = pngSize(Buffer.from(baseBytes));
      expect(size, "底图 IHDR 可解析").not.toBeNull();
      expect(size?.width, "底图宽=720CSS×2").toBe(1440);
      expect(size?.height).toBeGreaterThan(0);

      // —— 落笔（PointerEvent pen）并等待保存上传 ——
      await drawStrokeWithPointerEvents(canvas);
      await studentPage.waitForRequest(
        (req) =>
          req.method() === "PUT" &&
          /\/annotation$/.test(req.url()) &&
          req.url().includes(`/attempts/${attemptId}/`),
        { timeout: 15_000 },
      );
      // 上传后回读（等待视图带 doc）
      await expect
        .poll(
          async () =>
            (await fetchViewJson(studentPage, attemptId, questionId)).doc !==
            null,
          { timeout: 15_000 },
        )
        .toBe(true);
      const scratchView = await fetchViewJson(
        studentPage,
        attemptId,
        questionId,
      );
      const scratchDocJson = JSON.stringify(scratchView.doc);

      // —— resize：画布 CSS 盒跟随底图 img 等比（两视口断言）——
      const portrait = await expectCanvasFollowsImage(studentPage);
      expect(portrait.width).toBeGreaterThan(100);
      await studentPage.setViewportSize({ width: 1180, height: 820 }); // 横屏
      const landscape = await expectCanvasFollowsImage(studentPage);
      expect(Math.abs(landscape.width - portrait.width)).toBeGreaterThan(20); // 视口变化真实生效
      await studentPage.setViewportSize({ width: 820, height: 1180 }); // 回竖屏
      await expectCanvasFollowsImage(studentPage);

      // 旋转/resize 后 GET 回读 doc 内容不变（坐标锚定底图像素域，不重排）
      const afterResize = await fetchViewJson(
        studentPage,
        attemptId,
        questionId,
      );
      expect(JSON.stringify(afterResize.doc)).toBe(scratchDocJson);

      // —— 交卷（flush 标注同步 → seal → submit）——
      await card
        .getByRole("radio", { name: "选项 B" })
        .locator("xpath=ancestor::label[1]")
        .click();
      await studentPage.getByRole("button", { name: "交卷" }).click();
      await studentPage.getByRole("button", { name: "确认交卷" }).click();
      await expect(studentPage.getByText(/批改结果/).first()).toBeVisible({
        timeout: 30_000,
      });

      // —— sealed 后 UI 只读：scratch 回看视图无工具条（无笔/橡皮按钮），
      //    显示「已随交卷固定」；交卷后 seal 使 PUT 409（服务端侧已测）——
      const resultCard = studentPage.locator('article[aria-label="第 1 题"]');
      await resultCard.getByRole("button", { name: /题干标注/ }).click();
      await expect(studentPage.getByText(/已随交卷固定/)).toBeVisible({
        timeout: 15_000,
      });
      // 只读视图：静态笔迹层在场、无「清空标注」工具条按钮
      await expect(
        resultCard.locator('[data-slot="annotation-static-canvas"]'),
      ).toBeVisible();
      await expect(
        resultCard.getByRole("button", { name: /清空标注/ }),
      ).toHaveCount(0);

      // —— 订正另开：phase=correction 新记录，旧 scratch bytes 不变 ——
      await resultCard.getByRole("button", { name: /圈画题干/ }).click();
      const correctionWrap = resultCard.locator(
        '[data-slot="annotation-workspace"]',
      );
      await expect(
        correctionWrap.locator('[data-slot="annotation-base-wrap"] img'),
      ).toBeVisible({ timeout: 120_000 });
      const correctionCanvas = correctionWrap.locator("canvas");
      await drawStrokeWithPointerEvents(correctionCanvas);
      // 订正上传：PUT annotation（multipart 流式体不可回读——phase 断言改走
      // 服务端权威：scratch 已 seal，非 correction 的 PUT 必 409；correction
      // 视图出现 doc 即证明订正记录独立落地）
      await studentPage.waitForRequest(
        (req) =>
          req.method() === "PUT" &&
          /\/annotation$/.test(req.url()) &&
          req.url().includes(`/attempts/${attemptId}/`),
        { timeout: 15_000 },
      );
      await expect
        .poll(
          async () =>
            (
              await fetchViewJson(
                studentPage,
                attemptId,
                questionId,
                "correction",
              )
            ).doc !== null,
          { timeout: 15_000 },
        )
        .toBe(true);
      const scratchAfterCorrection = await fetchViewJson(
        studentPage,
        attemptId,
        questionId,
      );
      expect(JSON.stringify(scratchAfterCorrection.doc)).toBe(scratchDocJson);

      // —— 审查修复 3①：保存订正标注检查点 → sealed 固定态（编辑器收起）——
      await resultCard.getByRole("button", { name: "保存订正标注" }).click();
      await resultCard.getByRole("button", { name: "确认保存" }).click();
      await expect(
        studentPage.getByText(/已随订正保存固定/),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        resultCard.locator('[data-slot="annotation-workspace"]'),
      ).toHaveCount(0);
      // 服务端权威：correction 行已封存（sealedAt 回填）
      await expect
        .poll(
          async () => {
            const res = await studentPage.request.get(
              `/api/student/attempts/${attemptId}/questions/${questionId}/annotation?phase=correction`,
            );
            const body = (await res.json()) as {
              data?: { annotation?: { sealedAt?: string | null } | null };
            };
            return body.data?.annotation?.sealedAt ?? null;
          },
          { timeout: 15_000 },
        )
        .not.toBeNull();

      // 学生端全程无泄露告警
      expect(leak.violations()).toEqual([]);
    } finally {
      await studentContext.close();
    }

    // —— 教师回看：作答详情页标注视图可见（底图 + 静态笔迹层）——
    const teacherContext = await browser.newContext(devices["iPad (gen 7)"]);
    const teacherPage = await teacherContext.newPage();
    try {
      await teacherPage.goto("/t/login");
      await teacherPage.fill("#login-name", "teacher");
      await teacherPage.fill("#login-password", "e2e-teacher-pass");
      await teacherPage.getByRole("button", { name: "登录" }).click();
      await teacherPage.waitForURL("**/t/library");
      await teacherPage.goto(`/t/data/attempts/${attemptId}`);
      // 详情页题目卡就绪后再找标注入口
      await expect(teacherPage.getByText("第 1 题").first()).toBeVisible({
        timeout: 15_000,
      });
      await teacherPage.getByRole("button", { name: /题干标注/ }).click();
      await expect(
        teacherPage.locator('[data-slot="annotation-view"] img'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        teacherPage.locator('[data-slot="annotation-static-canvas"]'),
      ).toBeVisible();
      // 教师视图无编辑工具条（只读）
      await expect(
        teacherPage.getByRole("button", { name: /清空标注/ }),
      ).toHaveCount(0);
      // —— 审查修复 3②：切「订正标注」阶段 → 订正圈画教师可见（静态笔迹层）——
      await teacherPage.getByRole("tab", { name: "订正标注" }).click();
      await expect(
        teacherPage.locator('[data-slot="annotation-view"] img'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        teacherPage.locator('[data-slot="annotation-static-canvas"]'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        teacherPage.getByText(/订正/).first(),
      ).toBeVisible();
    } finally {
      await teacherContext.close();
    }
  });

  test("无底图：超高题显式禁用文案；mock 装配 500 同禁用（草稿照用）", async ({
    request,
    browser,
  }) => {
    test.setTimeout(240_000);

    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e超高题课程${suffix}`;
    const unitName = `超高题练习${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: tooTallPracticeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入超高题练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-tall-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e超高题生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const context = await browser.newContext(devices["iPad (gen 7)"]);
    const page = await context.newPage();
    try {
      const leak = attachLeakMonitor(page);
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
      await openChoicePractice(page, courseId, courseName, unitName, 1);

      const card = page.locator('article[aria-label="第 1 题"]');
      await card.getByRole("button", { name: /圈画题干/ }).click();
      // 超高题：显式禁用 + 说明原因 + 草稿照用口径
      await expect(card.getByText(/已禁用题干标注/)).toBeVisible({
        timeout: 120_000,
      });
      await expect(card.getByText(/草稿纸不受影响/)).toBeVisible();
      // 不挂画布（没有可靠底图不能落墨）
      await expect(
        card.locator('[data-slot="annotation-base-wrap"]'),
      ).toHaveCount(0);
      // 泄露监控零告警
      expect(leak.violations()).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("mock 装配载荷投影失败（500 EXPORT_ASSEMBLY_BROKEN）→ 入口禁用文案", async ({
    request,
    browser,
  }) => {
    test.setTimeout(180_000);

    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e哨兵课程${suffix}`;
    const unitName = `哨兵练习${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: annotationPracticeMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);

    const loginName = `e2e-sent-${suffix}`;
    await request.post("/api/teacher/students", {
      data: { displayName: `e2e哨兵生${suffix}`, loginName },
    });
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const context = await browser.newContext(devices["iPad (gen 7)"]);
    const page = await context.newPage();
    try {
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
      await openChoicePractice(page, courseId, courseName, unitName, 1);

      // mock：视图与装配载荷都替换为 500 EXPORT_ASSEMBLY_BROKEN 壳
      await page.route(
        /\/api\/student\/attempts\/[^/]+\/questions\/[^/]+\/annotation(\?phase=|$)/,
        async (route) => {
          if (route.request().method() === "GET") {
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({
                ok: false,
                error: "EXPORT_ASSEMBLY_BROKEN",
                message: "题面装配失败：题干含答案标记",
              }),
            });
            return;
          }
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: "EXPORT_ASSEMBLY_BROKEN",
              message: "题面装配失败：题干含答案标记",
            }),
          });
        },
      );

      const card = page.locator('article[aria-label="第 1 题"]');
      await card.getByRole("button", { name: /圈画题干/ }).click();
      await expect(card.getByText(/已禁用题干标注/)).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        card.locator('[data-slot="annotation-base-wrap"]'),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
