import { expect, type Locator, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  toolbarButtonNames,
  uniqueSuffix,
} from "./helpers";

test.beforeEach(async ({ request, page }, testInfo) => {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `交互回归课程${suffix}`;
  const unitName = `交互回归练习${suffix}`;
  const longQuestion = testInfo.title.startsWith("草稿按需分栏");
  const courseId = await createCourseViaApi(request, courseName);
  const markdown = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "---",
    "",
    '::::question{type=choice difficulty=1 knowledge="计算"}',
    "计算 $1+1$ 的结果，选择正确选项。",
    ...(longQuestion
      ? ["请认真阅读完整题干，并比较每一个选项的条件和结论。".repeat(8)]
      : []),
    "",
    "- [ ] 选项甲：$1$",
    "- [x] 选项乙：$2$",
    "- [ ] 选项丙：$3$",
    "- [ ] 选项丁：$4$",
    ...(longQuestion
      ? [
          "",
          "这段补充材料也属于题面，应与上方题干和选项一起保持原来的换行与标画位置。".repeat(
            4,
          ),
        ]
      : []),
    "",
    ":::solution",
    "不应提前出现的秘密详解",
    ":::",
    "::::",
    "",
  ].join("\n");
  const imported = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: `${unitName}.md`, courseId },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  await setCourseItemVisible(request, courseId, unitName, true);
  const loginName = `interaction-${suffix}`;
  await request.post("/api/teacher/students", {
    data: { displayName: "交互回归学生", loginName },
  });
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  await page.setViewportSize({ width: 1100, height: 668 });
  await openChoicePractice(page, courseId, courseName, unitName, 1);
});

test("草稿开合前后正文阅读均收起顶栏，反向展开且保留草稿", {
  tag: ["@annotation"],
}, async ({ page }) => {
  const card = page.getByRole("article", { name: "第 1 题", exact: true });
  const trigger = card.getByRole("button", { name: /^第 1 题草稿纸(?:（|$)/ });
  const paper = card.locator('[data-slot="note-layer"]');
  const header = page.locator('[data-slot="attempt-header"]');
  await trigger.click();
  await drawStrokeWithPointerEvents(paper.locator("canvas"));
  await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
  await trigger.click();
  for (const width of [390, 1180]) {
    await page.setViewportSize({ width, height: 300 });
    for (const open of [false, true, false]) {
      if (open !== ((await trigger.getAttribute("aria-expanded")) === "true"))
        await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", String(open));
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
        window.scrollTo({ top: 0, behavior: "instant" });
        return new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      const beforeWidth = (await card.boundingBox())?.width;
      await page.mouse.move(5, 150);
      await page.mouse.wheel(0, 180);
      await expect(header).toHaveAttribute("data-reading-hidden", "true");
      await expect
        .poll(() =>
          header.evaluate((node) => node.getBoundingClientRect().bottom),
        )
        .toBeLessThanOrEqual(1);
      expect((await card.boundingBox())?.width).toBe(beforeWidth);
      await page.mouse.wheel(0, -80);
      await expect(header).toHaveAttribute("data-reading-hidden", "false");
      if (open)
        await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
    }
  }
});

for (const preference of ["auto", "side", "below"] as const) {
  test(
    `草稿按需分栏：${preference}收起不占位，展开等比适配且保留像素与笔数`,
    { tag: ["@annotation"] },
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1500, height: 1100 });
      const labels = {
        auto: "自动（按宽度）",
        side: "左右分栏",
        below: "上下排列",
      };
      const card = page.getByRole("article", { name: "第 1 题", exact: true });
      const paperTrigger = card.getByRole("button", {
        name: /^第 1 题草稿纸(?:（|$)/,
      });
      const paper = card.locator('[data-slot="note-layer"]');
      if (preference !== "auto") {
        await paperTrigger.click();
        await paper
          .getByRole("button", { name: "更多操作（第 1 题草稿纸）" })
          .click();
        await page
          .getByRole("menuitem", {
            name: `布局：${labels[preference]}`,
            exact: true,
          })
          .click();
        await paperTrigger.click();
        await expect(paper).toBeHidden();
      }
      // 外框保持足够宽，草稿未打开时内部不能提前预留右列。
      const trigger = card.getByRole("button", { name: /圈画题干/ });
      await trigger.click();
      const canvas = card.locator('canvas[data-slot="annotation-canvas"]');
      await expect(canvas).toHaveAttribute("data-input-enabled", "true");
      await drawStrokeWithPointerEvents(canvas);
      await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
      const snapshot = async () =>
        card.evaluate((article) => {
          const source = article.querySelector(
            '[data-slot="question-surface"]',
          );
          const canvas = article.querySelector(
            'canvas[data-slot="annotation-canvas"]',
          );
          if (!source || !(canvas instanceof HTMLCanvasElement))
            throw new Error("题面或标画画布未就绪");
          const context = canvas.getContext("2d");
          if (!context) throw new Error("无法检查标画像素");
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          let hash = 2166136261;
          let painted = 0;
          for (let index = 0; index < pixels.length; index++) {
            hash = Math.imul(hash ^ (pixels[index] ?? 0), 16777619);
            if (index % 4 === 3 && (pixels[index] ?? 0) > 0) painted++;
          }
          const root = article.getBoundingClientRect();
          const geometry = (element: Element) => {
            const box = element.getBoundingClientRect();
            return [box.x - root.x, box.y - root.y, box.width, box.height].map(
              (value) => Math.round(value * 100) / 100,
            );
          };
          return {
            surface: geometry(source),
            canvas: geometry(canvas),
            width: canvas.width,
            height: canvas.height,
            hash,
            painted,
          };
        });
      const original = await snapshot();
      expect(original.painted).toBeGreaterThan(10);
      const row = card.locator('[data-slot="note-body-row"]');
      await expect(row).toHaveAttribute("data-layout", "below");
      await expect
        .poll(() =>
          row.evaluate((element) => {
            const column = element.firstElementChild;
            return column
              ? Math.abs(
                  column.getBoundingClientRect().width -
                    element.getBoundingClientRect().width,
                )
              : Infinity;
          }),
        )
        .toBeLessThan(1);
      const cycle = async (active: boolean) => {
        for (const opened of [true, false, true, false]) {
          await paperTrigger.click();
          if (opened) await expect(paper).toBeVisible();
          else await expect(paper).toBeHidden();
          await expect(canvas).toBeVisible();
          await expect(canvas).toHaveAttribute(
            "data-input-enabled",
            String(active),
          );
          if (opened && preference !== "below") {
            await expect(row).toHaveAttribute("data-layout", "side");
            await expect
              .poll(async () => (await snapshot()).surface[2] ?? 0)
              .toBeLessThan(original.surface[2] ?? 0);
            const current = await snapshot();
            expect(current.width).toBe(original.width);
            expect(current.height).toBe(original.height);
            expect(current.hash).toBe(original.hash);
            expect(current.painted).toBe(original.painted);
            for (let i = 0; i < 4; i++)
              expect(
                Math.abs((current.surface[i] ?? 0) - (current.canvas[i] ?? 0)),
              ).toBeLessThan(1);
            expect(
              Math.abs(
                (current.surface[2] ?? 0) / (current.surface[3] ?? 1) -
                  (original.surface[2] ?? 0) / (original.surface[3] ?? 1),
              ),
            ).toBeLessThan(0.01);
          } else {
            await expect(row).toHaveAttribute("data-layout", "below");
            await expect.poll(snapshot).toEqual(original);
          }
          await expect
            .poll(() =>
              card
                .locator('[data-slot="annotation-viewport"]')
                .evaluate(
                  (element) => element.scrollWidth - element.clientWidth,
                ),
            )
            .toBeLessThanOrEqual(1);
          await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
          await expect(
            card.getByRole("button", { name: "查看原标画", exact: true }),
          ).toHaveCount(0);
        }
      };
      await cycle(true);
      await page.getByRole("button", { name: "完成标画", exact: true }).click();
      await expect(card.locator('[data-slot="question-surface"]')).toHaveCount(
        1,
      );
      await expect(card.getByRole("radio")).toHaveCount(4);
      await expect(canvas).toBeVisible();
      await expect(canvas).toHaveAttribute("data-input-enabled", "false");
      await card.locator('[role="radiogroup"] label').nth(1).click();
      await expect(card.getByRole("radio").nth(1)).toBeChecked();
      await expect.poll(snapshot).toEqual(original);
      await cycle(false);
      await page.screenshot({
        path: testInfo.outputPath(`paper-geometry-${preference}.png`),
      });
    },
  );
}

test("题卡扩宽后题面居中且保留标画原尺寸与像素", {
  tag: ["@annotation"],
}, async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 1000 });
  const card = page.getByRole("article", { name: "第 1 题", exact: true });
  // 模拟升级前较窄的题卡，之后恢复新版外框宽度。
  await card.evaluate((element) => {
    element.style.maxWidth = "768px";
  });
  const trigger = card.getByRole("button", { name: /圈画题干/ });
  await trigger.click();
  const canvas = card.locator('canvas[data-slot="annotation-canvas"]');
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  await drawStrokeWithPointerEvents(canvas);
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  const geometry = async () =>
    card.evaluate((article) => {
      const source = article.querySelector('[data-slot="question-surface"]');
      const canvas = article.querySelector(
        'canvas[data-slot="annotation-canvas"]',
      );
      if (!source || !(canvas instanceof HTMLCanvasElement))
        throw new Error("标画尚未就绪");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法读取标画");
      let hash = 2166136261;
      for (const value of context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data)
        hash = Math.imul(hash ^ value, 16777619);
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height].map(
          (value) => Math.round(value * 100) / 100,
        );
      };
      return { surface: box(source), canvas: box(canvas), hash };
    });
  const original = await geometry();
  const width = await card.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  await card.evaluate((element) => {
    element.style.removeProperty("max-width");
  });
  await expect
    .poll(() =>
      card.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThan(width);
  await expect
    .poll(async () => {
      const current = await geometry();
      return {
        surface: current.surface.slice(2),
        canvas: current.canvas.slice(2),
        hash: current.hash,
      };
    })
    .toEqual({
      surface: original.surface.slice(2),
      canvas: original.canvas.slice(2),
      hash: original.hash,
    });
  const current = await geometry();
  for (let index = 0; index < 4; index++)
    expect(
      Math.abs((current.surface[index] ?? 0) - (current.canvas[index] ?? 0)),
    ).toBeLessThan(1);
  await expect(card.locator('[data-slot="note-body-row"]')).toHaveAttribute(
    "data-layout",
    "below",
  );
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  await expect(
    card.getByRole("button", { name: "查看原标画", exact: true }),
  ).toHaveCount(0);
});

test(
  "圈画保存失败不丢原稿或遮标题，显式重试成功后可退出并刷新恢复",
  { tag: ["@annotation"] },
  async ({ page }, testInfo) => {
    const card = page.getByRole("article", { name: "第 1 题", exact: true });
    const trigger = card.getByRole("button", { name: /圈画题干/ });
    const canvas = card.locator('canvas[data-slot="annotation-canvas"]');
    await trigger.click();
    await expect(canvas).toHaveAttribute("data-input-enabled", "true");
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        value: unknown,
        key?: IDBValidKey,
      ) {
        const request =
          key === undefined
            ? original.call(this, value)
            : original.call(this, value, key);
        if (this.transaction.db.name === "tutor-annotations") {
          queueMicrotask(() => this.transaction.abort());
        }
        return request;
      };
      const testWindow = window as Window & {
        restoreAnnotationWrites?: () => void;
      };
      testWindow.restoreAnnotationWrites = () => {
        IDBObjectStore.prototype.put = original;
        delete testWindow.restoreAnnotationWrites;
      };
    });
    const restore = () =>
      page.evaluate(() => {
        const testWindow = window as Window & {
          restoreAnnotationWrites?: () => void;
        };
        testWindow.restoreAnnotationWrites?.();
      });
    try {
      await drawStrokeWithPointerEvents(canvas);
      await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
      await expect(page.getByTestId("draft-status")).toContainText(
        "本机保存失败",
      );
      await page.getByRole("button", { name: "完成标画", exact: true }).click();
      const notice = page.locator(
        '[data-slot="attempt-header"] [role="alert"]',
      );
      await expect(notice).toContainText("本机存储");
      await expect(notice).not.toContainText("null");
      await expect(canvas).toHaveAttribute("data-input-enabled", "true");
      const titleBox = await page
        .locator('[data-slot="attempt-header"] h1')
        .boundingBox();
      const noticeBox = await notice.boundingBox();
      expect(titleBox).not.toBeNull();
      expect(noticeBox).not.toBeNull();
      if (!titleBox || !noticeBox) throw new Error("缺少标题或错误提示布局");
      expect(noticeBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
      await page.screenshot({
        path: testInfo.outputPath("annotation-save-error.png"),
      });
      await restore();
      await notice.getByRole("button", { name: "重试操作" }).click();
      await expect(notice).toHaveCount(0);
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
      await page.reload();
      await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
      await trigger.click();
      await expect(canvas).toHaveAttribute("data-input-enabled", "true");
    } finally {
      await restore();
    }
  },
);

test("圈画再次点击与双击取消，不丢已有笔迹", { tag: ["@annotation"] }, async ({
  page,
}) => {
  const card = page.getByRole("article", { name: "第 1 题", exact: true });
  const trigger = card.getByRole("button", { name: /圈画题干/ });
  const canvas = card.locator('canvas[data-slot="annotation-canvas"]');
  await trigger.click();
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  await drawStrokeWithPointerEvents(canvas);
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(canvas).toHaveAttribute("data-input-enabled", "false");
  await trigger.click();
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  await trigger.dblclick();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(canvas).toHaveAttribute("data-input-enabled", "false");
  await trigger.dblclick();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  await expect(card.locator('[data-slot="question-surface"]')).toHaveCount(1);
  await expect(canvas).toBeVisible();
  await expect(card.getByRole("radio")).toHaveCount(4);
  await card.locator('[role="radiogroup"] label').nth(1).click();
  await expect(card.getByRole("radio").nth(1)).toBeChecked();
  await expect(canvas).toBeVisible();
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
});

test(
  "草稿全屏参考包含全部选项，退出后保留作答",
  { tag: ["@annotation"] },
  async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const leak = attachLeakMonitor(page);
    const card = page.getByRole("article", { name: "第 1 题", exact: true });
    await card.locator('[role="radiogroup"] label').nth(1).click();
    await card
      .getByRole("button", { name: "第 1 题草稿纸", exact: true })
      .click();
    const paper = card.locator('[data-slot="note-layer"]');
    await paper.getByRole("button", { name: "第 1 题草稿纸全屏" }).click();
    const dialog = page.getByRole("dialog", { name: "第 1 题草稿纸全屏" });
    const layers = await page.evaluate(() => {
      const frame = document.querySelector(
        '[data-slot="paper-frame"][data-state="open"]',
      );
      if (!frame) throw new Error("全屏纸面不存在");
      const locked = [...document.querySelectorAll<HTMLElement>("[inert]")];
      for (const element of locked) element.removeAttribute("inert");
      try {
        return [20, window.innerHeight - 20].map((y) =>
          frame.contains(document.elementFromPoint(window.innerWidth / 2, y)),
        );
      } finally {
        for (const element of locked) element.setAttribute("inert", "");
      }
    });
    expect(layers).toEqual([true, true]);
    const options = dialog.getByRole("list", { name: "参考选项" });
    await expect(options.getByRole("listitem")).toHaveCount(4);
    for (const label of ["选项甲", "选项乙", "选项丙", "选项丁"])
      await expect(options).toContainText(label);
    await options.getByRole("listitem").last().scrollIntoViewIfNeeded();
    await expect(options.getByRole("listitem").last()).toBeVisible();
    await dialog
      .getByRole("button", { name: "更多操作（第 1 题草稿纸）" })
      .click();
    await page.getByRole("menuitem", { name: "清空草稿纸" }).click();
    const confirm = page.getByRole("dialog", { name: "清空草稿纸？" });
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText("不应提前出现的秘密详解");
    await expect(dialog.locator(".katex-error, .math-fallback")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("paper-options-fullscreen.png"),
    });
    await dialog.getByRole("button", { name: "退出全屏" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByRole("radio").nth(1)).toBeChecked();
    expect(leak.violations()).toEqual([]);
  },
);

test("清空标画菜单不退出模式，清空可撤销且刷新保留空稿", {
  tag: ["@annotation"],
}, async ({ page }) => {
  const card = page.getByRole("article", { name: "第 1 题", exact: true });
  const trigger = card.getByRole("button", { name: /圈画题干/ });
  await trigger.click();
  const canvas = card.locator('canvas[data-slot="annotation-canvas"]');
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  await drawStrokeWithPointerEvents(canvas);
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  await page.getByRole("button", { name: "更多标画操作" }).click();
  await page.getByRole("menuitem", { name: "清空标画（可撤销）" }).click();
  await expect(trigger).not.toHaveAccessibleName(/已有/);
  const toolbar = page.getByRole("toolbar", { name: "第 1 题标画工具栏" });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  // 宽度够时重做是工具栏上的独立按钮（窄屏收进「更多」，见 320px 用例）
  await toolbar.getByRole("button", { name: "重做", exact: true }).click();
  await expect(trigger).not.toHaveAccessibleName(/已有/);
  await page.reload();
  await expect(trigger).not.toHaveAccessibleName(/已有/);
  await trigger.click();
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  await expect(trigger).not.toHaveAccessibleName(/已有/);
});

test(
  "圈画与草稿共存、圈画范围可见、右侧布局切换不丢草稿",
  { tag: ["@annotation"] },
  async ({ page }, testInfo) => {
    const leak = attachLeakMonitor(page);
    const card = page.getByRole("article", { name: "第 1 题", exact: true });
    const paperTrigger = card.getByRole("button", {
      name: /^第 1 题草稿纸(?:（|$)/,
    });
    const annotationTrigger = card.getByRole("button", { name: /圈画题干/ });
    const paper = card.locator('[data-slot="note-layer"]');
    const ink = paper.locator("canvas");
    await paperTrigger.click();
    await expect(ink).toBeVisible();
    await drawStrokeWithPointerEvents(ink);
    await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
    await annotationTrigger.click();
    await expect(
      card.locator('[data-slot="question-annotation-overlay"]'),
    ).toHaveAttribute("data-drawing", "true");
    await expect(paper).toBeVisible();
    await drawStrokeWithPointerEvents(ink);
    await expect(paper.getByText("2 笔", { exact: true })).toBeVisible();
    await expect(annotationTrigger).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({
      path: testInfo.outputPath("annotation-paper-coexist.png"),
    });
    await paperTrigger.click();
    await expect(paper).toBeHidden();
    await expect(annotationTrigger).toHaveAttribute("aria-expanded", "true");
    await paperTrigger.click();
    await expect(paper).toBeVisible();
    await expect(annotationTrigger).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "完成标画", exact: true }).click();
    await expect(paper).toBeVisible();
    await paper
      .getByRole("button", { name: "更多操作（第 1 题草稿纸）" })
      .click();
    await page.getByRole("menuitem", { name: "布局：左右分栏" }).click();
    const row = card.locator('[data-slot="note-body-row"]');
    await expect(row).toHaveAttribute("data-layout", "side");
    const surfaceBox = await card
      .locator('[data-slot="question-surface"]')
      .boundingBox();
    const paperBox = await ink.boundingBox();
    await page.screenshot({
      path: testInfo.outputPath("annotation-paper-side.png"),
    });
    expect(paperBox?.x).toBeGreaterThan(
      (surfaceBox?.x ?? 0) + (surfaceBox?.width ?? 0),
    );
    await expect(paper.getByText("2 笔", { exact: true })).toBeVisible();
    await paper
      .getByRole("button", { name: "更多操作（第 1 题草稿纸）" })
      .click();
    await page.getByRole("menuitem", { name: "布局：上下排列" }).click();
    await expect(row).toHaveAttribute("data-layout", "below");
    await expect(paper.getByText("2 笔", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1800, height: 1000 });
    await paper
      .getByRole("button", { name: "更多操作（第 1 题草稿纸）" })
      .click();
    await page
      .getByRole("menuitem", { name: "布局：自动（按宽度）", exact: true })
      .click();
    await expect(row).toHaveAttribute("data-layout", "side");
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(row).toHaveAttribute("data-layout", "below");
    await expect(paper.getByText("2 笔", { exact: true })).toBeVisible();
    expect(leak.violations()).toEqual([]);
  },
);

test("圈画和草稿都用同款笔橡皮，手指不落墨", {
  tag: ["@annotation"],
}, async ({ page }) => {
  const card = page.getByRole("article", { name: "第 1 题", exact: true });
  const trigger = card.getByRole("button", { name: /圈画题干/ });
  await trigger.click();
  const canvas = card.locator('canvas[data-slot="annotation-canvas"]');
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  const touchStroke = (target: Locator) =>
    target.evaluate((element) => {
      const box = element.getBoundingClientRect();
      for (const [type, offset] of [
        ["pointerdown", 15],
        ["pointermove", 45],
        ["pointerup", 45],
      ] as const)
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: "touch",
            pointerId: 42,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: box.x + offset,
            clientY: box.y + 20,
            pressure: 0.5,
          }),
        );
    });
  const markToolbar = page.getByRole("toolbar", { name: "第 1 题标画工具栏" });
  // 圈画没有「手指书写」；其余与草稿纸同一套：笔、荧光笔、橡皮、形状、撤销、
  // 重做、更多
  await expect
    .poll(() => toolbarButtonNames(markToolbar))
    .toEqual([
      "笔",
      "荧光笔",
      "橡皮",
      "形状",
      "撤销",
      "重做",
      "更多标画操作",
      "完成标画",
    ]);
  const markPen = markToolbar.getByRole("button", { name: "笔", exact: true });
  await expect(markPen).toHaveAttribute("aria-pressed", "true");
  await expect(canvas).toHaveCSS("touch-action", "pan-y");
  await touchStroke(canvas);
  await expect(trigger).not.toHaveAccessibleName(/已有/);

  // 再点一次当前的笔：弹出选项面板（6 色 5 档）；选色后面板不收起、圈画不退出
  await markPen.click();
  const penPanel = page.getByRole("dialog", { name: "笔设置" });
  await expect(penPanel).toBeVisible();
  await expect(
    penPanel.getByRole("radiogroup", { name: "颜色" }).getByRole("radio"),
  ).toHaveCount(6);
  await expect(
    penPanel.getByRole("radiogroup", { name: "粗细" }).getByRole("radio"),
  ).toHaveCount(5);
  await expect(penPanel.getByRole("radio", { name: "红" })).toBeChecked();
  await penPanel.getByRole("radio", { name: "蓝" }).click();
  await expect(penPanel).toBeVisible();
  await expect(penPanel.getByRole("radio", { name: "蓝" })).toBeChecked();
  await expect(markPen.locator('[data-slot="ink-tool-color"]')).toHaveCSS(
    "background-color",
    "rgb(29, 78, 216)",
  );
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  // 键盘：方向键在同组里移动并选中（按住再松开，和真人按键一样有先后），
  // Escape 收起面板、焦点回到笔按钮
  await page.keyboard.down("ArrowRight");
  await expect(penPanel.getByRole("radio", { name: "红" })).toBeChecked();
  await page.keyboard.up("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(penPanel).toHaveCount(0);
  await expect(markPen).toBeFocused();
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  // 面板开着直接落笔：面板收起，这一笔照常写上
  await markPen.click();
  await expect(penPanel).toBeVisible();
  await drawStrokeWithPointerEvents(canvas);
  await expect(penPanel).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);

  // 点未选中的橡皮只切工具、不弹面板；再点一次才出橡皮大小
  const markEraser = markToolbar.getByRole("button", {
    name: "橡皮",
    exact: true,
  });
  await markEraser.click();
  await expect(markEraser).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await markEraser.click();
  const eraserPanel = page.getByRole("dialog", { name: "橡皮设置" });
  await expect(
    eraserPanel.getByRole("radiogroup", { name: "大小" }).getByRole("radio"),
  ).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(eraserPanel).toHaveCount(0);
  await drawStrokeWithPointerEvents(canvas);
  await expect(trigger).not.toHaveAccessibleName(/已有/);
  await markToolbar.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  await markToolbar
    .getByRole("button", { name: "完成标画", exact: true })
    .click();

  await card.getByRole("button", { name: /^第 1 题草稿纸(?:（|$)/ }).click();
  const paper = card.locator('[data-slot="note-layer"]');
  const paperToolbar = paper.getByRole("toolbar");
  const paperCanvas = paper.locator("canvas");
  await expect
    .poll(() => toolbarButtonNames(paperToolbar))
    .toEqual([
      "笔",
      "荧光笔",
      "橡皮",
      "形状",
      "撤销",
      "重做",
      "更多操作（第 1 题草稿纸）",
    ]);
  // 草稿纸的笔是同一个选项面板（缺省黑色中号，跟随笔感设置）
  const paperPen = paperToolbar.getByRole("button", {
    name: "笔",
    exact: true,
  });
  await paperPen.click();
  const paperPenPanel = page.getByRole("dialog", { name: "笔设置" });
  await expect(paperPenPanel.getByRole("radio", { name: "黑" })).toBeChecked();
  await expect(
    paperPenPanel
      .getByRole("radiogroup", { name: "粗细" })
      .getByRole("radio", { name: "中" }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(paperPenPanel).toHaveCount(0);
  await expect(paperCanvas).toHaveCSS("touch-action", "pan-y");
  await touchStroke(paperCanvas);
  await expect(paper.getByText("1 笔", { exact: true })).toHaveCount(0);
  await drawStrokeWithPointerEvents(paperCanvas);
  await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
  await paperToolbar.getByRole("button", { name: "橡皮", exact: true }).click();
  await drawStrokeWithPointerEvents(paperCanvas);
  await expect(paper.getByText("1 笔", { exact: true })).toHaveCount(0);
  await paperToolbar.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
});

/**
 * 用笔在画布中间来回涂一笔（三趟压在同一条带上），取抬笔前、抬笔后的读数：
 * 画布上涂抹带中心那个像素，和书写中那一笔所在的临时层路径。
 */
async function scribbleAndProbe(canvas: Locator) {
  return canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("不是画布");
    const rect = element.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const points: Array<[number, number]> = [
      [cx - 80, cy],
      [cx + 80, cy],
      [cx - 80, cy + 2],
      [cx + 80, cy + 4],
    ];
    const fire = (type: string, [x, y]: [number, number], buttons: number) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 9,
          pointerType: "pen",
          isPrimary: true,
          clientX: rect.left + x,
          clientY: rect.top + y,
          button: 0,
          buttons,
          pressure: 0.5,
        }),
      );
    const read = () => {
      const scale = element.width / rect.width;
      const pixel = Array.from(
        element
          .getContext("2d")
          ?.getImageData(
            Math.round(cx * scale),
            Math.round((cy + 2) * scale),
            1,
            1,
          ).data ?? [],
      );
      const path = element.parentElement?.querySelector(
        'svg[data-slot="ink-live-layer"] path',
      );
      return {
        pixel,
        d: path?.getAttribute("d") ?? null,
        stroke: path?.getAttribute("stroke") ?? null,
      };
    };
    const [first, ...rest] = points;
    const last = points.at(-1);
    if (first === undefined || last === undefined) throw new Error("没有点");
    fire("pointerdown", first, 1);
    for (const point of rest) fire("pointermove", point, 1);
    const writing = read();
    fire("pointerup", last, 0);
    return { writing, done: read() };
  });
}

/** 颜色逐通道相差不超过 4（半透明像素存取有舍入） */
function expectPixelNear(actual: number[], expected: number[]): void {
  expect(actual, `像素 ${actual}`).toHaveLength(4);
  expected.forEach((value, index) => {
    expect(
      Math.abs((actual[index] ?? Number.NaN) - value),
      `像素 ${actual}，期望 ${expected}`,
    ).toBeLessThanOrEqual(4);
  });
}

test(
  "荧光笔：书写中不上画布，抬笔整笔落下，来回涂抹不叠深（草稿纸与圈画）",
  {
    tag: ["@annotation"],
  },
  async ({ page }, testInfo) => {
    const card = page.getByRole("article", { name: "第 1 题", exact: true });

    // 草稿纸：切到荧光笔，面板里换成绿色、粗
    await card.getByRole("button", { name: /^第 1 题草稿纸(?:（|$)/ }).click();
    const paper = card.locator('[data-slot="note-layer"]');
    const paperToolbar = paper.getByRole("toolbar");
    const paperCanvas = paper.locator("canvas");
    const paperHighlighter = paperToolbar.getByRole("button", {
      name: "荧光笔",
      exact: true,
    });
    await paperHighlighter.click();
    await expect(paperHighlighter).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await paperHighlighter.click();
    const panel = page.getByRole("dialog", { name: "荧光笔设置" });
    await expect(
      panel.getByRole("radiogroup", { name: "颜色" }).getByRole("radio"),
    ).toHaveCount(5);
    await expect(
      panel.getByRole("radiogroup", { name: "粗细" }).getByRole("radio"),
    ).toHaveCount(3);
    await expect(panel.getByRole("radio", { name: "黄" })).toBeChecked();
    await panel.getByRole("radio", { name: "绿" }).click();
    await panel.getByRole("radio", { name: "粗" }).click();
    await expect(
      paperHighlighter.locator('[data-slot="ink-tool-color"]'),
    ).toHaveCSS("background-color", "rgb(74, 222, 128)");
    await page.screenshot({
      path: testInfo.outputPath("highlighter-panel.png"),
    });
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    const onPaper = await scribbleAndProbe(paperCanvas);
    // 书写中：这一笔只在临时层上（一条路径），画布上还没有墨
    expect(onPaper.writing.d).toMatch(/^M[\d.]+ [\d.]+L.*Q/);
    expect(onPaper.writing.stroke).toBe("rgba(74, 222, 128, 0.45)");
    expect(onPaper.writing.pixel[3]).toBe(0);
    // 抬笔：临时层清空，画布上三趟压在一起的地方仍是一层的透明度（0.45×255≈115；
    // 叠两层会到 178）
    expect(onPaper.done.d).toBeNull();
    expectPixelNear(onPaper.done.pixel, [74, 222, 128, 115]);
    await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
    // 撤销、重做：整笔消失、回来，仍是一层的透明度
    await paperToolbar
      .getByRole("button", { name: "撤销", exact: true })
      .click();
    await expect(paper.getByText("1 笔", { exact: true })).toHaveCount(0);
    await paperToolbar
      .getByRole("button", { name: "重做", exact: true })
      .click();
    await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
    const centerPixel = (canvas: Locator) =>
      canvas.evaluate((element) => {
        if (!(element instanceof HTMLCanvasElement))
          throw new Error("不是画布");
        const rect = element.getBoundingClientRect();
        const scale = element.width / rect.width;
        return Array.from(
          element
            .getContext("2d")
            ?.getImageData(
              Math.round((rect.width / 2) * scale),
              Math.round((rect.height / 2 + 2) * scale),
              1,
              1,
            ).data ?? [],
        );
      });
    expectPixelNear(await centerPixel(paperCanvas), [74, 222, 128, 115]);
    // 橡皮擦得掉荧光笔
    await paperToolbar
      .getByRole("button", { name: "橡皮", exact: true })
      .click();
    await drawStrokeWithPointerEvents(paperCanvas);
    await expect(paper.getByText("1 笔", { exact: true })).toHaveCount(0);
    await paperToolbar
      .getByRole("button", { name: "撤销", exact: true })
      .click();
    await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("highlighter-paper.png"),
    });
    await card.getByRole("button", { name: /^第 1 题草稿纸(?:（|$)/ }).click();

    // 圈画：各书写面的工具箱各管各的，这里的荧光笔还是缺省的黄色、中等粗细
    const trigger = card.getByRole("button", { name: /圈画题干/ });
    await trigger.click();
    const markCanvas = card.locator('canvas[data-slot="annotation-canvas"]');
    await expect(markCanvas).toHaveAttribute("data-input-enabled", "true");
    const markToolbar = page.getByRole("toolbar", {
      name: "第 1 题标画工具栏",
    });
    await markToolbar
      .getByRole("button", { name: "荧光笔", exact: true })
      .click();
    const onQuestion = await scribbleAndProbe(markCanvas);
    expect(onQuestion.writing.d).toMatch(/^M[\d.]+ [\d.]+L.*Q/);
    expect(onQuestion.writing.stroke).toBe("rgba(250, 204, 21, 0.45)");
    expect(onQuestion.writing.pixel[3]).toBe(0);
    expect(onQuestion.done.d).toBeNull();
    expectPixelNear(onQuestion.done.pixel, [250, 204, 21, 115]);
    await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
    await page.screenshot({
      path: testInfo.outputPath("highlighter-question.png"),
    });
    await markToolbar
      .getByRole("button", { name: "完成标画", exact: true })
      .click();
    // 退出圈画后静态显示的仍是这一笔
    await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  },
);

/** 用当前的笔在画布中线上横着写一笔：中心左右各 100px */
async function writeLineAcross(canvas: Locator): Promise<void> {
  await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const fire = (type: string, x: number, buttons: number) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 11,
          pointerType: "pen",
          isPrimary: true,
          clientX: rect.left + x,
          clientY: rect.top + cy,
          button: 0,
          buttons,
          pressure: 0.5,
        }),
      );
    fire("pointerdown", cx - 100, 1);
    for (let x = cx - 90; x <= cx + 100; x += 10) fire("pointermove", x, 1);
    fire("pointerup", cx + 100, 0);
  });
}

/**
 * 橡皮从画布中心上方 30px 竖着划到下方 30px，取抬笔前、抬笔后的读数：橡皮圈
 * 有没有显示，中心与中心左右各 60px 处有没有墨。
 */
async function eraseDownAndProbe(canvas: Locator) {
  return canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("不是画布");
    const rect = element.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const fire = (type: string, y: number, buttons: number) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 12,
          pointerType: "pen",
          isPrimary: true,
          clientX: rect.left + cx,
          clientY: rect.top + y,
          button: 0,
          buttons,
          pressure: 0.5,
        }),
      );
    /** (x, y) 周围 3 CSS px 见方里最浓的那个像素的不透明度 */
    const inkAt = (x: number, y: number) => {
      const scale = element.width / rect.width;
      const data =
        element
          .getContext("2d")
          ?.getImageData(
            Math.round((x - 1.5) * scale),
            Math.round((y - 1.5) * scale),
            Math.ceil(3 * scale),
            Math.ceil(3 * scale),
          ).data ?? [];
      let alpha = 0;
      for (let i = 3; i < data.length; i += 4)
        alpha = Math.max(alpha, data[i] ?? 0);
      return alpha;
    };
    const read = () => {
      const ring = element.parentElement?.querySelector<SVGElement>(
        'svg[data-slot="ink-live-layer"] circle[data-slot="ink-eraser-ring"]',
      );
      return {
        ring: ring != null && ring.style.display !== "none",
        center: inkAt(cx, cy),
        left: inkAt(cx - 60, cy),
        right: inkAt(cx + 60, cy),
      };
    };
    fire("pointerdown", cy - 30, 1);
    for (const y of [cy - 15, cy, cy + 15, cy + 30]) fire("pointermove", y, 1);
    const erasing = read();
    fire("pointerup", cy + 30, 0);
    return { erasing, done: read() };
  });
}

test(
  "局部橡皮：面板里选「局部」，只擦掉碰到的一段，橡皮圈跟着走（草稿纸与圈画）",
  {
    tag: ["@annotation"],
  },
  async ({ page }, testInfo) => {
    const card = page.getByRole("article", { name: "第 1 题", exact: true });

    // 草稿纸：写一条横线，橡皮面板里把擦除方式从「整笔」改成「局部」
    await card.getByRole("button", { name: /^第 1 题草稿纸(?:（|$)/ }).click();
    const paper = card.locator('[data-slot="note-layer"]');
    const paperToolbar = paper.getByRole("toolbar");
    const paperCanvas = paper.locator("canvas");
    await writeLineAcross(paperCanvas);
    await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
    const paperEraser = paperToolbar.getByRole("button", {
      name: "橡皮",
      exact: true,
    });
    await paperEraser.click();
    await paperEraser.click();
    const panel = page.getByRole("dialog", { name: "橡皮设置" });
    const modes = panel.getByRole("radiogroup", { name: "擦除方式" });
    await expect(modes.getByRole("radio")).toHaveCount(2);
    await expect(modes.getByRole("radio", { name: "整笔" })).toBeChecked();
    await expect(panel.getByText("碰到哪一笔，就擦掉那一整笔")).toBeVisible();
    await modes.getByRole("radio", { name: "局部" }).click();
    await expect(modes.getByRole("radio", { name: "局部" })).toBeChecked();
    await expect(panel.getByText("只擦掉橡皮碰到的那一段")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("eraser-panel.png") });
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // 竖着划过横线中间：划的途中橡皮圈跟着、中间那一段已经擦掉、两头还在；
    // 抬笔后橡皮圈收起，一笔变两笔
    const onPaper = await eraseDownAndProbe(paperCanvas);
    expect(onPaper.erasing.ring).toBe(true);
    expect(onPaper.erasing.center).toBe(0);
    expect(onPaper.erasing.left).toBeGreaterThan(0);
    expect(onPaper.erasing.right).toBeGreaterThan(0);
    expect(onPaper.done).toEqual({ ...onPaper.erasing, ring: false });
    await expect(paper.getByText("2 笔", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("eraser-partial-paper.png"),
    });
    // 一次拖动一步撤销；重做回到两段
    await paperToolbar
      .getByRole("button", { name: "撤销", exact: true })
      .click();
    await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
    await paperToolbar
      .getByRole("button", { name: "重做", exact: true })
      .click();
    await expect(paper.getByText("2 笔", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: /^第 1 题草稿纸(?:（|$)/ }).click();

    // 圈画：各书写面的工具箱各管各的，这里的橡皮还是缺省的整笔
    const trigger = card.getByRole("button", { name: /圈画题干/ });
    await trigger.click();
    const markCanvas = card.locator('canvas[data-slot="annotation-canvas"]');
    await expect(markCanvas).toHaveAttribute("data-input-enabled", "true");
    const markToolbar = page.getByRole("toolbar", {
      name: "第 1 题标画工具栏",
    });
    await writeLineAcross(markCanvas);
    await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
    const markEraser = markToolbar.getByRole("button", {
      name: "橡皮",
      exact: true,
    });
    await markEraser.click();
    await markEraser.click();
    const markModes = page
      .getByRole("dialog", { name: "橡皮设置" })
      .getByRole("radiogroup", { name: "擦除方式" });
    await expect(markModes.getByRole("radio", { name: "整笔" })).toBeChecked();
    await markModes.getByRole("radio", { name: "局部" }).click();
    await page.keyboard.press("Escape");
    const onQuestion = await eraseDownAndProbe(markCanvas);
    expect(onQuestion.erasing.ring).toBe(true);
    expect(onQuestion.erasing.center).toBe(0);
    expect(onQuestion.erasing.left).toBeGreaterThan(0);
    expect(onQuestion.erasing.right).toBeGreaterThan(0);
    expect(onQuestion.done).toEqual({ ...onQuestion.erasing, ring: false });
    await expect(trigger).toHaveAccessibleName(/已有 2 笔/);
    await page.screenshot({
      path: testInfo.outputPath("eraser-partial-question.png"),
    });
    await markToolbar
      .getByRole("button", { name: "撤销", exact: true })
      .click();
    await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
    await markToolbar
      .getByRole("button", { name: "完成标画", exact: true })
      .click();
    await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  },
);

/**
 * 用当前工具从画布中心左上 (−100, −40) 拖到右下 (+100, +40)，取抬笔前、抬笔后
 * 的读数：临时层上的预览路径，以及这个框的四条边中点、对角线中点（画布中心）
 * 有没有墨。
 */
async function dragBoxAndProbe(canvas: Locator) {
  return canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("不是画布");
    const rect = element.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const fire = (type: string, x: number, y: number, buttons: number) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 13,
          pointerType: "pen",
          isPrimary: true,
          clientX: rect.left + x,
          clientY: rect.top + y,
          button: 0,
          buttons,
          pressure: 0.5,
        }),
      );
    /** (x, y) 周围 3 CSS px 见方里最浓的那个像素的不透明度 */
    const inkAt = (x: number, y: number) => {
      const scale = element.width / rect.width;
      const data =
        element
          .getContext("2d")
          ?.getImageData(
            Math.round((x - 1.5) * scale),
            Math.round((y - 1.5) * scale),
            Math.ceil(3 * scale),
            Math.ceil(3 * scale),
          ).data ?? [];
      let alpha = 0;
      for (let i = 3; i < data.length; i += 4)
        alpha = Math.max(alpha, data[i] ?? 0);
      return alpha;
    };
    const read = () => ({
      preview:
        element.parentElement
          ?.querySelector('svg[data-slot="ink-live-layer"] path')
          ?.getAttribute("d") ?? null,
      top: inkAt(cx, cy - 40),
      right: inkAt(cx + 100, cy),
      bottom: inkAt(cx, cy + 40),
      left: inkAt(cx - 100, cy),
      center: inkAt(cx, cy),
    });
    fire("pointerdown", cx - 100, cy - 40, 1);
    fire("pointermove", cx - 20, cy + 10, 1);
    fire("pointermove", cx + 100, cy + 40, 1);
    const dragging = read();
    fire("pointerup", cx + 100, cy + 40, 0);
    return { dragging, done: read() };
  });
}

/** 折线路径：M 开头，后面跟着 count 个 L */
const polyline = (count: number) =>
  new RegExp(`^M[\\d.]+ [\\d.]+(L[\\d.]+ [\\d.]+){${count}}$`);

test(
  "形状：面板里选一种，拖动出预览、抬笔落成一笔；荧光笔可改成直线（草稿纸与圈画）",
  {
    tag: ["@annotation"],
  },
  async ({ page }, testInfo) => {
    const card = page.getByRole("article", { name: "第 1 题", exact: true });

    // 草稿纸：点形状只切工具；再点一次出面板，缺省直线，换成矩形
    await card.getByRole("button", { name: /^第 1 题草稿纸(?:（|$)/ }).click();
    const paper = card.locator('[data-slot="note-layer"]');
    const paperToolbar = paper.getByRole("toolbar");
    const paperCanvas = paper.locator("canvas");
    const paperShape = paperToolbar.getByRole("button", {
      name: "形状",
      exact: true,
    });
    await paperShape.click();
    await expect(paperShape).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await paperShape.click();
    const panel = page.getByRole("dialog", { name: "形状设置" });
    const kinds = panel.getByRole("radiogroup", { name: "形状" });
    await expect(kinds.getByRole("radio")).toHaveCount(4);
    await expect(kinds.getByRole("radio", { name: "直线" })).toBeChecked();
    await expect(
      panel.getByText("直线：从一头拖到另一头，接近横平竖直时自动摆正"),
    ).toBeVisible();
    // 颜色、粗细与笔共用（缺省黑色中号，跟随笔感设置）
    await expect(panel.getByRole("radio", { name: "黑" })).toBeChecked();
    await kinds.getByRole("radio", { name: "矩形" }).click();
    await expect(panel.getByText("矩形：从一个角拖到对角")).toBeVisible();
    // 形状按钮上的图标换成了矩形
    await expect(
      paperShape.locator('[data-slot="ink-shape-glyph"]'),
    ).toHaveAttribute("data-shape", "rect");
    await page.screenshot({ path: testInfo.outputPath("shape-panel.png") });
    for (const radio of await panel.getByRole("radio").all()) {
      const box = await radio.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // 拖动途中：只有临时层上的预览（五个顶点的折线），画布上没有墨、笔数不变
    const boxOnPaper = await dragBoxAndProbe(paperCanvas);
    expect(boxOnPaper.dragging.preview).toMatch(polyline(4));
    expect(boxOnPaper.dragging).toMatchObject({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
    // 抬笔：预览收起，四条边都画上了，框里是空的，算一笔
    expect(boxOnPaper.done.preview).toBeNull();
    for (const edge of ["top", "right", "bottom", "left"] as const)
      expect(boxOnPaper.done[edge], edge).toBeGreaterThan(200);
    expect(boxOnPaper.done.center).toBe(0);
    await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
    // 一个图形一步撤销；重做回来
    await paperToolbar
      .getByRole("button", { name: "撤销", exact: true })
      .click();
    await expect(paper.getByText("1 笔", { exact: true })).toHaveCount(0);
    await paperToolbar
      .getByRole("button", { name: "重做", exact: true })
      .click();
    await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();

    // 荧光笔面板里把线条从「手绘」改成「直线」：同样一拖，落成穿过中心的一道
    // 直线（两个顶点），算第二笔
    const paperHighlighter = paperToolbar.getByRole("button", {
      name: "荧光笔",
      exact: true,
    });
    await paperHighlighter.click();
    await paperHighlighter.click();
    const lines = page
      .getByRole("dialog", { name: "荧光笔设置" })
      .getByRole("radiogroup", { name: "线条" });
    await expect(lines.getByRole("radio", { name: "手绘" })).toBeChecked();
    await lines.getByRole("radio", { name: "直线" }).click();
    await expect(lines.getByRole("radio", { name: "直线" })).toBeChecked();
    await page.screenshot({
      path: testInfo.outputPath("highlighter-line-panel.png"),
    });
    await page.keyboard.press("Escape");
    const lineOnPaper = await dragBoxAndProbe(paperCanvas);
    expect(lineOnPaper.dragging.preview).toMatch(polyline(1));
    expect(lineOnPaper.dragging.center).toBe(0);
    expect(lineOnPaper.done.preview).toBeNull();
    // 一层荧光笔的透明度（0.45 × 255 ≈ 115）
    expect(Math.abs(lineOnPaper.done.center - 115)).toBeLessThanOrEqual(4);
    await expect(paper.getByText("2 笔", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("shape-paper.png") });
    await card.getByRole("button", { name: /^第 1 题草稿纸(?:（|$)/ }).click();

    // 圈画：各书写面的工具箱各管各的，这里的形状还是缺省的直线；换成箭头
    const trigger = card.getByRole("button", { name: /圈画题干/ });
    await trigger.click();
    const markCanvas = card.locator('canvas[data-slot="annotation-canvas"]');
    await expect(markCanvas).toHaveAttribute("data-input-enabled", "true");
    const markToolbar = page.getByRole("toolbar", {
      name: "第 1 题标画工具栏",
    });
    const markShape = markToolbar.getByRole("button", {
      name: "形状",
      exact: true,
    });
    await markShape.click();
    await markShape.click();
    const markKinds = page
      .getByRole("dialog", { name: "形状设置" })
      .getByRole("radiogroup", { name: "形状" });
    await expect(markKinds.getByRole("radio", { name: "直线" })).toBeChecked();
    await markKinds.getByRole("radio", { name: "箭头" }).click();
    await page.keyboard.press("Escape");
    const arrowOnQuestion = await dragBoxAndProbe(markCanvas);
    // 箭头是一笔：杆、折到一侧箭翼、回到箭尖、再到另一侧箭翼
    expect(arrowOnQuestion.dragging.preview).toMatch(polyline(4));
    expect(arrowOnQuestion.dragging.center).toBe(0);
    expect(arrowOnQuestion.done.preview).toBeNull();
    expect(arrowOnQuestion.done.center).toBeGreaterThan(200);
    await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
    await page.screenshot({ path: testInfo.outputPath("shape-question.png") });
    await markToolbar
      .getByRole("button", { name: "撤销", exact: true })
      .click();
    await expect(trigger).not.toHaveAccessibleName(/已有/);
    await markToolbar
      .getByRole("button", { name: "重做", exact: true })
      .click();
    await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
    await markToolbar
      .getByRole("button", { name: "完成标画", exact: true })
      .click();
    // 退出圈画后静态显示的仍是这一笔
    await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  },
);
