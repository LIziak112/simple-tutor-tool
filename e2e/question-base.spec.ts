import { expect, type Page, test } from "@playwright/test";

/** 对照正常 DOM 的公式截图，避免「PNG 存在但公式为空」也通过测试。 */
async function expectFormulaInBase(page: Page) {
  const formula = page.locator('[data-slot="question-surface"] .katex');
  const reference = await formula.screenshot();
  const comparison = await page.evaluate(async (referenceBase64) => {
    const surface = document.querySelector('[data-slot="question-surface"]');
    const math = surface?.querySelector(".katex");
    const image = document.querySelector<HTMLImageElement>(
      'img[alt="题面底图"]',
    );
    if (!surface || !math || !image) throw new Error("公式底图未就绪");
    await image.decode();
    const referenceImage = new Image();
    referenceImage.src = `data:image/png;base64,${referenceBase64}`;
    await referenceImage.decode();
    const rect = surface.getBoundingClientRect();
    const box = math.getBoundingClientRect();
    const ratio = image.naturalWidth / rect.width;
    const count = (source: HTMLImageElement, crop: readonly number[]) => {
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 32;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("画布不可用");
      context.drawImage(
        source,
        crop[0] ?? 0,
        crop[1] ?? 0,
        crop[2] ?? 1,
        crop[3] ?? 1,
        0,
        0,
        96,
        32,
      );
      const data = context.getImageData(0, 0, 96, 32).data;
      const buckets = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) > 0 && (data[i] ?? 255) < 200) {
          const bucket = Math.floor(((i / 4) % 96) / 32);
          buckets[bucket] = (buckets[bucket] ?? 0) + 1;
        }
      }
      return buckets;
    };
    return {
      expected: count(referenceImage, [
        0,
        0,
        referenceImage.naturalWidth,
        referenceImage.naturalHeight,
      ]),
      actual: count(image, [
        (box.left - rect.left) * ratio,
        (box.top - rect.top) * ratio,
        box.width * ratio,
        box.height * ratio,
      ]),
    };
  }, reference.toString("base64"));
  for (let i = 0; i < comparison.expected.length; i++) {
    const expected = comparison.expected[i] ?? 0;
    expect(expected).toBeGreaterThan(10);
    expect(comparison.actual[i] ?? 0).toBeGreaterThan(expected * 0.65);
    expect(comparison.actual[i] ?? 0).toBeLessThan(expected * 1.35);
  }
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

test("交互展开导致版式不同及配图失败时不放行底图", {
  tag: ["@student"],
}, async ({ page }) => {
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
