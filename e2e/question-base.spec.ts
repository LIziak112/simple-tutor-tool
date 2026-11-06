import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  expect,
  type Locator,
  type Page,
  test,
  webkit,
} from "@playwright/test";

import { expectFormulaInBase } from "./annotation-assertions";
import { drawStrokeWithPointerEvents } from "./helpers";

async function drawShortStroke(canvas: Locator) {
  await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const fire = (type: string, x: number, y: number, buttons: number) => {
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 8,
          pointerType: "pen",
          isPrimary: true,
          clientX: rect.left + rect.width * x,
          clientY: rect.top + rect.height * y,
          button: 0,
          buttons,
          pressure: 0.5,
        }),
      );
    };
    fire("pointerdown", 0.12, 0.65, 1);
    fire("pointermove", 0.16, 0.7, 1);
    fire("pointerup", 0.2, 0.65, 0);
  });
}

async function drawAtTileEdge(canvas: Locator, edge: "top" | "bottom") {
  await canvas.evaluate((element, side) => {
    const rect = element.getBoundingClientRect();
    const y = side === "top" ? 0.02 : 0.98;
    const fire = (type: string, x: number, buttons: number) => {
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 9,
          pointerType: "pen",
          isPrimary: true,
          clientX: rect.left + rect.width * x,
          clientY: rect.top + rect.height * y,
          button: 0,
          buttons,
          pressure: 0.5,
        }),
      );
    };
    fire("pointerdown", 0.25, 1);
    fire("pointermove", 0.27, 1);
    fire("pointerup", 0.29, 0);
  }, edge);
}

async function redNear(canvas: Locator, point: { x: number; y: number }) {
  return canvas.evaluate((element, target) => {
    const node = element as HTMLCanvasElement;
    const pixels =
      node
        .getContext("2d")
        ?.getImageData(
          Math.max(0, Math.floor(target.x) - 6),
          Math.max(0, Math.floor(target.y) - 6),
          13,
          13,
        ).data ?? [];
    let red = 0;
    for (let index = 0; index < pixels.length; index += 4)
      if (
        (pixels[index] ?? 0) > 130 &&
        (pixels[index + 1] ?? 0) < 100 &&
        (pixels[index + 3] ?? 0) > 0
      )
        red++;
    return red;
  }, point);
}

async function generateBase(page: Page) {
  const image = page.getByAltText("题面底图");
  const previousUrl = (await image.count())
    ? await image.getAttribute("src")
    : null;
  await page.getByRole("button", { name: "生成底图", exact: true }).click();
  // 等待本轮生成结束，再读取本轮结果与图片。
  await expect(
    page.getByRole("button", { name: "生成底图", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("layout-result")).toBeVisible();
  await expect(image).toBeVisible();
  if (previousUrl) await expect(image).not.toHaveAttribute("src", previousUrl);
  await expect
    .poll(() =>
      image.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(page.locator('[data-slot="question-base-host"]')).toHaveCount(0);
}

test("极限公式首次及重复生成均与正常题面的公式像素一致", {
  tag: ["@student"],
}, async ({ page }) => {
  await page.goto("/dev/question-base");
  await page.getByLabel("题面宽度").fill("720");
  await page.getByLabel("题面夹具").selectOption("limit");
  await generateBase(page);
  await expectFormulaInBase(page);
  await generateBase(page);
  await expectFormulaInBase(page);
});

test("先普通题再公式题，后续新字体不被旧快照遗漏", {
  tag: ["@student"],
}, async ({ page }) => {
  await page.goto("/dev/question-base");
  await page.getByLabel("题面宽度").fill("720");
  await page.getByLabel("题面夹具").selectOption("judge");
  await generateBase(page);
  for (const fixture of ["limit", "mathFonts"]) {
    await page.getByLabel("题面夹具").selectOption(fixture);
    await generateBase(page);
    await expectFormulaInBase(page);
  }
});

test("字体嵌入请求失败不生成 PNG，恢复后同页重试成功", {
  tag: ["@student"],
}, async ({ page }) => {
  await page.goto("/dev/question-base");
  await page.getByLabel("题面宽度").fill("720");
  await page.getByLabel("题面夹具").selectOption("limit");
  await expect(page.locator(".katex")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  let failedRequests = 0;
  await page.route("**/KaTeX*.woff2*", (route) => {
    failedRequests++;
    return route.fulfill({ status: 404, body: "字体加载失败" });
  });
  await page.getByRole("button", { name: "生成底图", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("字体");
  expect(failedRequests).toBeGreaterThan(0);
  await expect(page.getByAltText("题面底图")).toHaveCount(0);
  await expect(page.locator('[data-slot="question-base-host"]')).toHaveCount(0);
  await page.unroute("**/KaTeX*.woff2*");
  await generateBase(page);
  await expectFormulaInBase(page);
});

test("坏公式与超高题面拒绝生成残缺底图", { tag: ["@student"] }, async ({
  page,
}) => {
  await page.goto("/dev/question-base");
  for (const fixture of ["broken", "tall"]) {
    await page.getByLabel("题面夹具").selectOption(fixture);
    await page.getByRole("button", { name: "生成底图", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("layout-result")).toHaveCount(0);
    await expect(page.getByAltText("题面底图")).toHaveCount(0);
    await expect(page.locator('[data-slot="question-base-host"]')).toHaveCount(
      0,
    );
  }
});

test("公开折叠固定展开保持版式，配图失败仍不放行底图", {
  tag: ["@student"],
}, async ({ page }) => {
  await page.goto("/dev/question-base");
  await page.getByLabel("题面夹具").selectOption("fold");
  const fold = page.getByRole("button", { name: "公开材料", exact: true });
  await expect(fold).toBeDisabled();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("材料内容。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "生成底图", exact: true }).click();
  await expect(page.getByTestId("layout-result")).toBeVisible();
  await expect(page.getByAltText("题面底图")).toBeVisible();
  await expect(page.locator('[data-slot="question-base-host"]')).toHaveCount(0);
  await page.route("**/icons/icon-192.png", (route) => route.abort());
  await page.getByLabel("题面夹具").selectOption("media");
  await expect(
    page.locator('[data-slot="question-surface"] [role="alert"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "生成底图", exact: true }).click();
  await expect(page.getByTestId("layout-result")).toHaveCount(0);
  await expect(page.getByAltText("题面底图")).toHaveCount(0);
  await expect(page.locator('[data-slot="question-base-host"]')).toHaveCount(0);
});

test(
  "冻结表面实验：公式填空跨内核保留原稿坐标并绑定唯一输入",
  {
    tag: ["@student"],
  },
  async ({ page }, testInfo) => {
    const visualDir = join(tmpdir(), "ownclass-frozen-validation");
    await mkdir(visualDir, { recursive: true });
    await page.goto("/dev/question-base?frozenExperiment=1");
    const prototype = page.getByTestId("frozen-prototype");
    await prototype.getByLabel("实验类型").selectOption("fill");
    await prototype.getByLabel("实验宽度").fill("720");
    await prototype.getByRole("button", { name: "冻结原稿" }).click();
    await expect(
      prototype.getByRole("img", { name: "冻结题面" }),
    ).toBeVisible();
    await prototype.getByLabel("显示宽度").fill("360");
    await expect(
      prototype.locator('[data-slot="question-surface"]'),
    ).toHaveCount(0);
    const input = prototype.getByRole("textbox", { name: "第1空" });
    await input.fill("导数");
    await expect(input).toHaveValue("导数");
    await input.press("Tab");
    await expect(
      prototype.getByRole("textbox", { name: "第2空" }),
    ).toBeFocused();
    await prototype.getByRole("button", { name: "圈画" }).click();
    const canvas = prototype.locator('canvas[data-slot="annotation-canvas"]');
    await expect(canvas).toHaveAttribute("data-input-enabled", "true");
    await drawStrokeWithPointerEvents(canvas);
    await expect
      .poll(
        async () =>
          JSON.parse(
            await prototype.getByTestId("prototype-snapshot").inputValue(),
          ).doc.strokes.length,
      )
      .toBe(1);
    const original = JSON.parse(
      await prototype.getByTestId("prototype-snapshot").inputValue(),
    );
    expect(original.doc.strokes).toHaveLength(1);
    const firstCanvasBox = await canvas.boundingBox();
    expect(firstCanvasBox?.width).toBeCloseTo(360, 0);
    expect(original.doc.strokes[0].points[0].x).toBeCloseTo(
      original.doc.baseWidth * 0.3,
      0,
    );
    expect(
      await redNear(canvas, original.doc.strokes[0].points[0]),
    ).toBeGreaterThan(0);
    await page.screenshot({
      path: join(visualDir, `${testInfo.project.name}-source.png`),
    });

    const otherBrowser =
      testInfo.project.name === "webkit"
        ? await chromium.launch({
            channel: process.env.CI ? "" : "msedge",
            args: [],
          })
        : await webkit.launch({ channel: "", args: [] });
    const otherContext = await otherBrowser.newContext({
      baseURL: new URL(page.url()).origin,
      viewport: { width: 375, height: 850 },
    });
    try {
      const other = await otherContext.newPage();
      await other.goto("/dev/question-base?frozenExperiment=1");
      await other.addStyleTag({
        content:
          "body { font-family: Arial !important } .katex { font-size: 1.35em !important }",
      });
      const restored = other.getByTestId("frozen-prototype");
      await restored.getByLabel("实验类型").selectOption("fill");
      await restored
        .getByTestId("prototype-snapshot")
        .fill(JSON.stringify(original));
      await restored.getByRole("button", { name: "导入原稿" }).click();
      await restored.getByLabel("显示宽度").fill("340");
      const compactBox = await restored
        .getByRole("textbox", { name: "第1空" })
        .boundingBox();
      expect(compactBox?.height).toBeLessThan(44);
      await restored.getByRole("button", { name: "1:1放大" }).click();
      const fullSizeBox = await restored
        .getByRole("textbox", { name: "第1空" })
        .boundingBox();
      expect(fullSizeBox?.height).toBeGreaterThanOrEqual(44);
      console.log(
        `控件实测：${JSON.stringify({ compactHeight: compactBox?.height, fullSizeHeight: fullSizeBox?.height })}`,
      );
      expect(
        await restored
          .getByTestId("frozen-viewport")
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(true);
      await restored.getByLabel("显示宽度").fill("340");
      await expect(
        restored.getByRole("img", { name: "冻结题面" }),
      ).toHaveAttribute("src", original.dataUrl);
      expect(
        JSON.parse(
          (await restored.getByTestId("prototype-points").textContent()) ??
            "null",
        ),
      ).toEqual(original.doc.strokes);
      expect(
        await redNear(
          restored.locator('canvas[data-slot="annotation-canvas"]'),
          original.doc.strokes[0].points[0],
        ),
      ).toBeGreaterThan(0);
      await expect(
        restored.getByRole("textbox", { name: "第1空" }),
      ).toHaveCount(1);
      await restored.getByRole("textbox", { name: "第1空" }).fill("极限");
      await expect(restored.getByTestId("prototype-answer")).toContainText(
        "极限",
      );
      await restored.getByRole("button", { name: "只读", exact: true }).click();
      const readonlyInput = restored.getByRole("textbox", { name: "第1空" });
      await expect(readonlyInput).toHaveAttribute("readonly", "");
      await readonlyInput.press("X");
      await expect(readonlyInput).toHaveValue("极限");
      await restored.getByRole("button", { name: "解除只读" }).click();
      await restored.getByRole("button", { name: "圈画" }).click();
      const otherCanvas = restored.locator(
        'canvas[data-slot="annotation-canvas"]',
      );
      await drawShortStroke(otherCanvas);
      await expect
        .poll(
          async () =>
            JSON.parse(
              await restored.getByTestId("prototype-snapshot").inputValue(),
            ).doc.strokes.length,
        )
        .toBe(2);
      const continued = JSON.parse(
        await restored.getByTestId("prototype-snapshot").inputValue(),
      );
      expect(continued.doc.strokes).toHaveLength(2);
      expect(continued.doc.strokes[0].points).toEqual(
        original.doc.strokes[0].points,
      );
      const secondPoint = continued.doc.strokes[1].points[0];
      expect(await redNear(otherCanvas, secondPoint)).toBeGreaterThan(0);
      expect(await redNear(canvas, secondPoint)).toBe(0);
      await restored.getByRole("button", { name: "橡皮" }).click();
      await drawShortStroke(otherCanvas);
      await expect
        .poll(
          async () =>
            JSON.parse(
              await restored.getByTestId("prototype-snapshot").inputValue(),
            ).doc.strokes.length,
        )
        .toBe(1);
      await restored.getByRole("button", { name: "撤销" }).click();
      await expect
        .poll(
          async () =>
            JSON.parse(
              await restored.getByTestId("prototype-snapshot").inputValue(),
            ).doc.strokes.length,
        )
        .toBe(2);
      const undone = JSON.parse(
        await restored.getByTestId("prototype-snapshot").inputValue(),
      );
      expect(undone.doc.strokes).toHaveLength(2);
      await prototype
        .getByTestId("prototype-snapshot")
        .fill(JSON.stringify(undone));
      await prototype.getByRole("button", { name: "导入原稿" }).click();
      // 导入需先完成图片 decode，再把同 PNG 的新 doc 装入真实画布。
      await expect
        .poll(async () =>
          JSON.parse(
            (await prototype.getByTestId("prototype-points").textContent()) ??
              "null",
          ),
        )
        .toEqual(undone.doc.strokes);
      await expect(
        prototype.getByRole("img", { name: "冻结题面" }),
      ).toHaveAttribute("src", original.dataUrl);
      await expect.poll(() => redNear(canvas, secondPoint)).toBeGreaterThan(0);
      const invalid = {
        ...undone,
        manifest: { ...undone.manifest, slots: [] },
      };
      await prototype
        .getByTestId("prototype-snapshot")
        .fill(JSON.stringify(invalid));
      await prototype.getByRole("button", { name: "导入原稿" }).click();
      await expect(
        prototype.getByRole("textbox", { name: "第1空" }),
      ).toHaveCount(0);
      await expect(
        prototype.locator('canvas[data-slot="annotation-canvas"]'),
      ).toBeVisible();
      await expect(canvas).toHaveAttribute("data-input-enabled", "false");
      expect(await redNear(canvas, secondPoint)).toBeGreaterThan(0);
      expect(
        JSON.parse(
          (await prototype.getByTestId("prototype-points").textContent()) ??
            "null",
        ),
      ).toEqual(undone.doc.strokes);
      await other.screenshot({
        path: join(visualDir, `${testInfo.project.name}-restored.png`),
      });
      await page.screenshot({
        path: join(visualDir, `${testInfo.project.name}-roundtrip.png`),
      });
    } finally {
      await otherContext.close();
      await otherBrowser.close();
    }
  },
);

test(
  "冻结表面实验：长材料分片同域，排序只冻结静态题干",
  {
    tag: ["@student"],
  },
  async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const sizes: Array<{ width: number; height: number }> = [];
      (
        window as typeof window & { __canvasSizes: typeof sizes }
      ).__canvasSizes = sizes;
      for (const key of ["width", "height"] as const) {
        const property = Object.getOwnPropertyDescriptor(
          HTMLCanvasElement.prototype,
          key,
        );
        if (!property?.get || !property.set)
          throw new Error(`canvas ${key} 无法观测`);
        Object.defineProperty(HTMLCanvasElement.prototype, key, {
          configurable: true,
          get: property.get,
          set(this: HTMLCanvasElement, value: number) {
            property.set?.call(this, value);
            sizes.push({ width: this.width, height: this.height });
          },
        });
      }
    });
    await page.goto("/dev/question-base?frozenExperiment=1");
    const materialPrototype = page.getByTestId("frozen-material-prototype");
    await materialPrototype.getByRole("button", { name: "冻结原稿" }).click();
    await expect(
      materialPrototype.getByTestId("material-tile").first(),
    ).toBeVisible({ timeout: 60000 });
    const material = JSON.parse(
      await materialPrototype.getByTestId("prototype-snapshot").inputValue(),
    );
    expect(material.tiles.length).toBeGreaterThan(1);
    expect(material.cssHeight).toBeGreaterThan(2048);
    expect(
      material.tiles.every(
        (tile: { pixelHeight: number }) => tile.pixelHeight <= 4096,
      ),
    ).toBe(true);
    expect(
      material.tiles
        .slice(1)
        .every(
          (tile: { top: number }, index: number) =>
            tile.top ===
            material.tiles[index].top + material.tiles[index].height,
        ),
    ).toBe(true);
    const canvasSizes = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __canvasSizes: Array<{ width: number; height: number }>;
          }
        ).__canvasSizes,
    );
    expect(
      Math.max(
        ...canvasSizes.map(({ width, height }) => Math.max(width, height)),
      ),
    ).toBeLessThanOrEqual(4096);
    const pngBytes = material.tiles.reduce(
      (total: number, tile: { dataUrl: string }) =>
        total +
        Buffer.from(tile.dataUrl.split(",")[1] ?? "", "base64").byteLength,
      0,
    );
    const totalPixels = material.tiles.reduce(
      (total: number, tile: { pixelWidth: number; pixelHeight: number }) =>
        total + tile.pixelWidth * tile.pixelHeight,
      0,
    );
    const elapsedMs = JSON.parse(
      (await materialPrototype.getByTestId("material-metrics").textContent()) ??
        "{}",
    ).elapsedMs;
    console.log(
      `材料实测：${JSON.stringify({ cssHeight: material.cssHeight, tiles: material.tiles.length, pngBytes, totalPixels, elapsedMs, canvasPeak: Math.max(...canvasSizes.map(({ width, height }) => Math.max(width, height))), slotY: material.slots.map((slot: { y: number }) => slot.y) })}`,
    );
    expect(
      Math.min(
        ...material.slots.flatMap((slot: { y: number }) =>
          material.tiles
            .slice(1)
            .map((tile: { top: number }) => Math.abs(slot.y - tile.top)),
        ),
      ),
    ).toBeLessThan(250);
    for (const [index, tile] of material.tiles.entries()) {
      const image = materialPrototype.getByRole("img", {
        name: `冻结材料第${index + 1}片`,
      });
      expect(
        await image.evaluate((element: HTMLImageElement) => [
          element.naturalWidth,
          element.naturalHeight,
        ]),
      ).toEqual([tile.pixelWidth, tile.pixelHeight]);
    }
    await expect(
      materialPrototype.getByRole("combobox", { name: /第\s*1\s*空的选项/ }),
    ).toHaveCount(1);
    await materialPrototype
      .getByRole("combobox", { name: /第\s*1\s*空的选项/ })
      .selectOption("opt-1");
    await expect(
      materialPrototype.getByTestId("prototype-answer"),
    ).toContainText('"slot-1":"opt-1"');
    const firstTileCanvas = materialPrototype
      .getByTestId("material-tile")
      .first()
      .locator("canvas");
    const secondTileCanvas = materialPrototype
      .getByTestId("material-tile")
      .nth(1)
      .locator("canvas");
    await materialPrototype.getByRole("button", { name: "圈画" }).click();
    await drawAtTileEdge(firstTileCanvas, "bottom");
    await drawAtTileEdge(secondTileCanvas, "top");
    await expect
      .poll(async () => {
        const current = JSON.parse(
          await materialPrototype
            .getByTestId("prototype-snapshot")
            .inputValue(),
        );
        return current.tiles
          .slice(0, 2)
          .map(
            (tile: { doc: { strokes: unknown[] } }) => tile.doc.strokes.length,
          );
      })
      .toEqual([1, 1]);
    const withInk = JSON.parse(
      await materialPrototype.getByTestId("prototype-snapshot").inputValue(),
    );
    const seamBefore =
      withInk.tiles[0].top * 2 + withInk.tiles[0].doc.strokes[0].points[0].y;
    const seamAfter =
      withInk.tiles[1].top * 2 + withInk.tiles[1].doc.strokes[0].points[0].y;
    expect(seamBefore).toBeLessThan(withInk.tiles[1].top * 2);
    expect(seamAfter).toBeGreaterThan(withInk.tiles[1].top * 2);
    expect(
      await redNear(firstTileCanvas, withInk.tiles[0].doc.strokes[0].points[0]),
    ).toBeGreaterThan(0);
    expect(
      await redNear(
        secondTileCanvas,
        withInk.tiles[1].doc.strokes[0].points[0],
      ),
    ).toBeGreaterThan(0);
    await materialPrototype.getByTestId("prototype-snapshot").fill(
      JSON.stringify({
        ...withInk,
        tiles: withInk.tiles.map(
          (tile: (typeof withInk.tiles)[number], index: number) =>
            index === 0 ? { ...tile, doc: { ...tile.doc, strokes: [] } } : tile,
        ),
      }),
    );
    await materialPrototype.getByRole("button", { name: "导入原稿" }).click();
    await expect
      .poll(() =>
        redNear(firstTileCanvas, withInk.tiles[0].doc.strokes[0].points[0]),
      )
      .toBe(0);
    await expect
      .poll(() =>
        redNear(secondTileCanvas, withInk.tiles[1].doc.strokes[0].points[0]),
      )
      .toBeGreaterThan(0);
    const mismatchedIdentity = {
      ...withInk,
      materialId: "another-material",
    };
    await materialPrototype
      .getByTestId("prototype-snapshot")
      .fill(JSON.stringify(mismatchedIdentity));
    await materialPrototype.getByRole("button", { name: "导入原稿" }).click();
    await expect(
      materialPrototype.getByRole("button", { name: "圈画" }),
    ).toBeDisabled();
    await expect(
      materialPrototype.getByRole("combobox", { name: /第\s*1\s*空的选项/ }),
    ).toBeDisabled();
    expect(
      await redNear(
        secondTileCanvas,
        withInk.tiles[1].doc.strokes[0].points[0],
      ),
    ).toBeGreaterThan(0);
    const corruptDoc = {
      ...withInk,
      tiles: withInk.tiles.map(
        (tile: (typeof withInk.tiles)[number], index: number) =>
          index === 0
            ? {
                ...tile,
                doc: { ...tile.doc, baseHeight: tile.pixelHeight - 1 },
              }
            : tile,
      ),
    };
    await materialPrototype
      .getByTestId("prototype-snapshot")
      .fill(JSON.stringify(corruptDoc));
    await materialPrototype.getByRole("button", { name: "导入原稿" }).click();
    await expect(
      materialPrototype.getByRole("alert").filter({ hasText: "尺寸不符" }),
    ).toHaveCount(1);
    expect(
      await redNear(
        secondTileCanvas,
        withInk.tiles[1].doc.strokes[0].points[0],
      ),
    ).toBeGreaterThan(0);
    await page.screenshot({
      path: join(
        tmpdir(),
        "ownclass-frozen-validation",
        `${testInfo.project.name}-material.png`,
      ),
    });
    await materialPrototype
      .getByTestId("material-tile")
      .nth(1)
      .screenshot({
        path: join(
          tmpdir(),
          "ownclass-frozen-validation",
          `${testInfo.project.name}-material-tile-2.png`,
        ),
      });
    const prototype = page.getByTestId("frozen-prototype");
    await prototype.getByLabel("实验类型").selectOption("ordering");
    await prototype.getByRole("button", { name: "冻结原稿" }).click();
    await expect(
      prototype.getByRole("img", { name: "冻结题面" }),
    ).toBeVisible();
    await expect(prototype.getByTestId("dynamic-ordering")).toBeVisible();
    await prototype.getByRole("button", { name: "加入排序" }).first().click();
    await expect(prototype.getByTestId("prototype-answer")).toContainText(
      "item-1",
    );
    await expect(prototype.getByRole("img", { name: "冻结题面" })).toHaveCount(
      1,
    );
  },
);

test(
  "冻结表面实验：长公式选项保留原稿且答案只有一个状态",
  {
    tag: ["@student"],
  },
  async ({ page }, testInfo) => {
    await page.goto("/dev/question-base?frozenExperiment=1");
    const prototype = page.getByTestId("frozen-prototype");
    await prototype.getByLabel("实验类型").selectOption("choice");
    await prototype.getByRole("button", { name: "冻结原稿" }).click();
    await expect(
      prototype.getByRole("img", { name: "冻结题面" }),
    ).toBeVisible();
    const original = JSON.parse(
      await prototype.getByTestId("prototype-snapshot").inputValue(),
    );
    expect(original.manifest.slots).toHaveLength(3);
    expect(original.manifest.slots[1].height).toBeGreaterThan(
      original.manifest.slots[0].height,
    );
    const image = prototype.getByRole("img", { name: "冻结题面" });
    const sourceUrl = await image.getAttribute("src");
    await prototype.getByLabel("显示宽度").fill("360");
    await prototype.getByRole("radio", { name: "选项 B" }).check();
    await expect(
      prototype.getByRole("radio", { name: "选项 B" }),
    ).toBeChecked();
    await expect(prototype.getByRole("radio")).toHaveCount(3);
    await expect(prototype.getByTestId("prototype-answer")).toContainText(
      '"kind":"choice","index":1',
    );
    await page.addStyleTag({
      content:
        "body { font-family: Arial !important } .katex { font-size: 2em !important }",
    });
    await expect(image).toHaveAttribute("src", sourceUrl ?? "");
    expect(
      JSON.parse(await prototype.getByTestId("prototype-snapshot").inputValue())
        .manifest.slots,
    ).toEqual(original.manifest.slots);
    await page.screenshot({
      path: join(
        tmpdir(),
        "ownclass-frozen-validation",
        `${testInfo.project.name}-choice.png`,
      ),
    });
  },
);
