import { expect, test } from "@playwright/test";
import { annotationSurfaceLayoutSchema } from "../packages/contract/src/annotation";

test("共享题面底图：六类素材、分数宽度、真实PNG与作答隔离", async ({
  page,
}, testInfo) => {
  await page.goto("/dev/question-base");
  for (const width of [304.25, 720, 856]) {
    await page.getByLabel("题面宽度").fill(String(width));
    for (const fixture of [
      "judge",
      "choice",
      "multi",
      "fill",
      "media",
      "graph",
    ]) {
      await page.getByLabel("题面夹具").selectOption(fixture);
      const surface = page.locator('[data-slot="question-surface"]');
      if (fixture === "judge")
        await surface.getByLabel("对", { exact: true }).locator("..").click();
      if (fixture === "choice")
        await surface.getByLabel("选项 B").locator("..").click();
      if (fixture === "multi")
        await surface.getByLabel("选项 A").locator("..").click();
      if (fixture === "fill")
        await surface.getByLabel("第1空").fill("私人填答不进入底图");
      await page.getByRole("button", { name: "生成底图", exact: true }).click();
      await expect(page.getByTestId("layout-result")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole("alert")).toHaveCount(0);
      const raw = JSON.parse(
        await page.getByTestId("layout-result").innerText(),
      ) as { layout: unknown };
      const layout = annotationSurfaceLayoutSchema.parse(raw.layout);
      expect(layout.cssWidth).toBeCloseTo(width, 2);
      const png = page.getByAltText("题面底图");
      await expect(png).toBeVisible();
      const pixels = await png.evaluate(async (node) => {
        const image = node as HTMLImageElement;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("真实画布不可用");
        context.drawImage(image, 0, 0);
        const rgba = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let nonWhite = 0;
        for (let i = 0; i < rgba.length; i += 4)
          if (
            (rgba[i + 3] ?? 0) > 0 &&
            ((rgba[i] ?? 255) < 240 ||
              (rgba[i + 1] ?? 255) < 240 ||
              (rgba[i + 2] ?? 255) < 240)
          )
            nonWhite++;
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          nonWhite,
        };
      });
      expect(pixels.width).toBe(Math.ceil(layout.cssWidth * 2));
      expect(pixels.height).toBe(Math.ceil(layout.cssHeight * 2));
      expect(pixels.nonWhite).toBeGreaterThan(100);
      if (fixture === "judge")
        await expect(surface.getByLabel("对", { exact: true })).toBeChecked();
      if (fixture === "choice")
        await expect(surface.getByLabel("选项 B")).toBeChecked();
      if (fixture === "fill")
        await expect(surface.getByLabel("第1空")).toHaveValue(
          "私人填答不进入底图",
        );
      await expect(
        page.locator('[data-slot="question-base-host"]'),
      ).toHaveCount(0);
      if (width === 304.25 && fixture === "fill")
        await page.screenshot({
          path: testInfo.outputPath("shared-surface-fill.png"),
          fullPage: true,
        });
    }
  }
});

test("坏公式与超高题面拒绝生成残缺底图", async ({ page }) => {
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

test("交互展开导致版式不同及配图失败时不放行底图", async ({ page }) => {
  await page.goto("/dev/question-base");
  await page.getByLabel("题面夹具").selectOption("fold");
  await page.getByRole("button", { name: "公开材料", exact: true }).click();
  await page.getByRole("button", { name: "生成底图", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("布局");
  await expect(page.getByAltText("题面底图")).toHaveCount(0);
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
