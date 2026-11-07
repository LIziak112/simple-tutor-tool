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
  await toolbar.getByRole("button", { name: "更多标画操作" }).click();
  await page.getByRole("menuitem", { name: "重做", exact: true }).click();
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
  await expect(markToolbar.getByRole("button")).toHaveCount(5);
  await expect(
    markToolbar.getByRole("button", { name: "手指书写", exact: true }),
  ).toHaveCount(0);
  await expect(
    markToolbar.getByRole("button", { name: "笔", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(canvas).toHaveCSS("touch-action", "pan-y");
  await touchStroke(canvas);
  await expect(trigger).not.toHaveAccessibleName(/已有/);
  await drawStrokeWithPointerEvents(canvas);
  await expect(trigger).toHaveAccessibleName(/已有 1 笔/);
  await markToolbar.getByRole("button", { name: "橡皮", exact: true }).click();
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
  await expect(paperToolbar.getByRole("button")).toHaveCount(4);
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
